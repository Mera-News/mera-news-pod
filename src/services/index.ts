// The services plugins use: the profile, the suggestions, and reading control. Everything here runs
// once the client is up. Client modules are loaded inside functions, never at the top of a file,
// because the client may not be loaded before the pod registers its host.
import type { ServicesContext } from '../boot';
import { createNotifier, NOTIFY_LEVELS } from '../notify';
import type { PickView, PodServices } from '../plugin-api';
import { createDisplayService } from './display';
import { createEvents } from './events';
import { createCommands } from './commands';
import { createLedger, PodError } from './ledger';
import { readFeed } from './picks';
import { createModelService } from './model';
import { createNewsService } from './news';
import { createProfile } from './profile';
import { buildStatus, fetchLimits, judge, takeSnapshot } from './status';
import { watchFinishedStories, watchTopicsReady } from './watchers';

export { PodError } from './ledger';

export function createServices(context: ServicesContext): { services: PodServices; stop(): void } {
  const { cfg, control, log } = context;
  const snapshotInputs = { keyRefused: context.keyRefused, picksSetAside: undefined as string | undefined };
  const baseLedger = createLedger(cfg.paths.picksFile);
  snapshotInputs.picksSetAside = baseLedger.setAside;
  const changes = createEvents((line) => log('warning', line));
  // Numbering a new story changes the pick history without touching a table, so it is reported here.
  const ledger: typeof baseLedger = {
    ...baseLedger,
    async run(fn) {
      const before = baseLedger.position();
      const out = await baseLedger.run(fn);
      const after = baseLedger.position();
      if (before.epoch !== after.epoch || before.head !== after.head) changes.poke();
      return out;
    },
  };
  const notifier = createNotifier(cfg);
  const appNotify = !!cfg.notify.meraNewsApp;
  const running = !!notifier || appNotify;
  // Asked once, in the background: a plugin that needs it waits for the answer.
  const dataServer = fetchLimits(cfg);

  /** Reads the Feed and numbers its new stories, inside the ledger's one chain. */
  const feed = () =>
    ledger.run(async (tx) => {
      const { candidates, liveIds } = await readFeed();
      const seqs = tx.register(candidates.map((c) => c.memberIds), liveIds);
      return candidates.map((c, i) => ({ seq: seqs[i], pick: c.pick }));
    });

  // Sends new picks at the top levels, one batch at a time. At least once: what was sent is
  // recorded only after the send worked, so a failure or a crash in between sends it again.
  // shortcut: a failed send is retried when the next story finishes, not on a timer, so a long quiet gap delays it; upgrade to a timer if that matters.
  // A notifier starts at the newest pick when it is first turned on, or when the history starts
  // over, so it never sends the backlog of stories found before it was on.
  const arm = async () => {
    if (!running) {
      if (control.get().notifyEpoch !== null) control.setNotifyPosition(null, 0);
      return;
    }
    await feed();
    const { epoch, head } = ledger.position();
    if (control.get().notifyEpoch !== epoch) control.setNotifyPosition(epoch, head);
  };
  let sending: Promise<void> = arm().catch((error) => log('warning', `The notifier could not start: ${(error as Error).message}`));
  let emittedSeq = 0;
  const notifyNew = (picks: { seq: number; pick: PickView }[]) => {
    if (!running) return;
    sending = sending
      .then(async () => {
        const fresh = picks.filter((p) => p.seq > control.get().notifiedSeq).sort((a, b) => a.seq - b.seq);
        if (!fresh.length) return;
        const important = fresh.filter((p) => NOTIFY_LEVELS.includes(p.pick.level));
        // Each story is emitted once per process, before ntfy and the webhook, so a failing send never repeats it.
        const toEmit = important.filter((p) => p.seq > emittedSeq);
        if (appNotify && toEmit.length) {
          changes.emitNotify(toEmit.map((p) => p.pick));
          emittedSeq = toEmit[toEmit.length - 1].seq;
        }
        if (notifier && important.length) await notifier.send(important.map((p) => p.pick));
        control.setNotifiedSeq(fresh[fresh.length - 1].seq);
      })
      .catch((error) => log('warning', `A notifier could not send and will try again: ${(error as Error).message}`));
  };

  const stopTopics = watchTopicsReady((line) => log('warning', line));
  const stopStories = watchFinishedStories(async () => notifyNew(await feed()), (line) => log('warning', line));

  // Served while reading is paused: it only reads what is already stored.
  const display = createDisplayService();
  const services: PodServices = {
    commands: createCommands(log, display),
    profile: createProfile(() => dataServer),
    // Chat is the person's own action, so it is served while reading is paused.
    model: createModelService(cfg),
    news: createNewsService(cfg),
    display,
    events: changes.events,

    suggestions: {
      async get({ since, limit, fits, peek }) {
        if (!Number.isInteger(limit) || limit < 1) throw new PodError('bad_limit', 'limit must be a whole number of at least 1.', 'pass a limit such as 10');
        const [snapshot, reply] = await Promise.all([
          takeSnapshot(snapshotInputs),
          ledger.run(async (tx) => {
            const { candidates, liveIds } = await readFeed();
            const seqs = tx.register(candidates.map((c) => c.memberIds), liveIds);
            const fitsPage = fits ? (page: { pick: PickView }[]) => fits(page.map((i) => i.pick)) : undefined;
            const taken = tx.take(candidates.map((c, i) => ({ seq: seqs[i], pick: c.pick })), since, limit, fitsPage, peek === true);
            return { ...taken, all: candidates.length };
          }),
        ]);
        const { state, hint, nextReadAt } = judge(snapshot, control.get().paused, reply.items.length);
        return {
          state,
          hint,
          nextReadAt,
          picks: reply.items.map((i) => i.pick),
          cursor: reply.cursor,
          more: reply.more,
          ...(reply.reset ? { reset: true } : {}),
        };
      },
    },

    reading: {
      // The scheduler's own answer: it is `paused` while reading is paused and `busy` while a read runs.
      async readNow() {
        return (require('mera-news-client/dist/lib/scheduler/AppScheduler') as { AppScheduler: { trigger(name: string): Promise<string> } }).AppScheduler.trigger('feed-sync');
      },
      async status() {
        const [snapshot, picks, known] = await Promise.all([takeSnapshot(snapshotInputs), feed(), dataServer]);
        return buildStatus(cfg, control, snapshot, picks.length, known);
      },
      async set(change) {
        if (change.paused !== undefined) control.setPaused(change.paused);
        if (change.everyMinutes !== undefined) control.setEvery(change.everyMinutes);
        return services.reading.status();
      },
    },
  };

  return {
    services,
    stop() {
      changes.stop();
      stopTopics();
      stopStories();
      // A paired phone's mute and topic delete leave timers in the client; a stopped pod keeps none.
      const client = <T>(file: string) => require(`mera-news-client/dist/lib/${file}`) as T;
      client<{ cancelPendingPurges(): void }>('database/services/publication-pref-ui-actions').cancelPendingPurges();
      client<{ cancelPendingDeletes(): void }>('database/services/topic-decline-service').cancelPendingDeletes();
    },
  };
}
