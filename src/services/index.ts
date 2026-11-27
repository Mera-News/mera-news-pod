// The services plugins use: the profile, the suggestions, and reading control. Everything here runs
// once the client is up. Client modules are loaded inside functions, never at the top of a file,
// because the client may not be loaded before the pod registers its host.
import type { ServicesContext } from '../boot';
import { createNotifier, NOTIFY_LEVELS, PartialSendError } from '../notify';
import type { PickView, PodServices } from '../plugin-api';
import { createDisplayService } from './display';
import { createEvents } from './events';
import { createFollowed } from './followed';
import { createAiService, reasonsOn } from './ai-service';
import { createCommands } from './commands';
import { createLedger, PodError } from './ledger';
import { readFeed } from './picks';
import { createModelService } from './model';
import { createNewsService } from './news';
import { createProfile, readSetup } from './profile';
import { createStories } from './stories';
import { buildStatus, fetchLimits, judge, takeSnapshot } from './status';
import { watchFinishedStories, watchTopicsReady } from './watchers';
import { client } from './client';

export { PodError } from './ledger';

export function createServices(context: ServicesContext): { services: PodServices; stop(): void } {
  const { cfg, control, log } = context;
  // noAi is read at every snapshot: an AI service can be set while the pod runs.
  const snapshotInputs = {
    keyRefused: context.keyRefused,
    get noAi() {
      return !cfg.ai;
    },
    picksSetAside: undefined as string | undefined,
  };
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
  // One abort ends a paced ntfy burst and every send in flight when the pod stops.
  const stopping = new AbortController();
  const targets = createNotifier(cfg, undefined, stopping.signal);
  const appNotify = !!cfg.notify.meraNewsApp;
  const running = targets.length > 0 || appNotify;
  // Asked once, in the background: a plugin that needs it waits for the answer.
  const dataServer = fetchLimits(cfg);
  const profile = createProfile(() => dataServer, () => !!cfg.ai);
  const news = createNewsService(cfg);
  // Before the first read of the Feed: a story the assistant left out is never a pick.
  const stories = createStories({ news, profile, file: cfg.paths.verdictsFile, onChange: changes.poke });

  /** Reads the Feed and numbers its new stories, inside the ledger's one chain. */
  const feed = () =>
    ledger.run(async (tx) => {
      const { candidates, liveIds } = await readFeed(stories.leftOut());
      const seqs = tx.register(candidates.map((c) => c.memberIds), liveIds);
      return candidates.map((c, i) => ({ seq: seqs[i], pick: c.pick }));
    });

  // Sends new picks at the top levels, each target on its own chain and its own position, so a failing
  // or slow target never holds another back. At least once per target: a position moves only after its
  // send worked, so a failure or a crash in between sends it again. The saved position is the slowest
  // target's, so a restart may repeat picks to a faster target, never lose them.
  // shortcut: a failed send is retried when the next story finishes, not on a timer, so a long quiet gap delays it; upgrade to a timer if that matters.
  // A notifier starts at the newest pick when it is first turned on, or when the history starts
  // over, so it never sends the backlog of stories found before it was on.
  const positions = new Map<string, number>();
  const chains = new Map<string, Promise<void>>();
  const arm = async () => {
    if (!running) {
      if (control.get().notifyEpoch !== null) control.setNotifyPosition(null, 0);
      return;
    }
    await feed();
    const { epoch, head } = ledger.position();
    if (control.get().notifyEpoch !== epoch) control.setNotifyPosition(epoch, head);
  };
  const saveSlowest = () => {
    if (stopping.signal.aborted) return;
    control.setNotifiedSeq(Math.min(...targets.map((t) => positions.get(t.name) ?? control.get().notifiedSeq)));
  };
  let sending: Promise<void> = arm().catch((error) => log('warning', `The notifier could not start: ${(error as Error).message}`));
  let emittedSeq = 0;
  const deliver = (target: (typeof targets)[number], picks: { seq: number; pick: PickView }[]) => {
    const run = async () => {
      if (stopping.signal.aborted) return;
      const from = positions.get(target.name) ?? control.get().notifiedSeq;
      const fresh = picks.filter((p) => p.seq > from).sort((a, b) => a.seq - b.seq);
      if (!fresh.length) return;
      const important = fresh.filter((p) => NOTIFY_LEVELS.includes(p.pick.level));
      try {
        if (important.length) await target.send(important.map((p) => p.pick));
        positions.set(target.name, fresh[fresh.length - 1].seq);
      } catch (error) {
        if (stopping.signal.aborted) return;
        // What was delivered stays delivered: the retry starts after the last pick that got through.
        if (error instanceof PartialSendError) positions.set(target.name, important[error.delivered - 1].seq);
        log('warning', `A notifier could not send and will try again: ${(error as Error).message}`);
      }
      saveSlowest();
    };
    chains.set(target.name, (chains.get(target.name) ?? Promise.resolve()).then(run));
  };
  const notifyNew = (picks: { seq: number; pick: PickView }[]) => {
    if (!running) return;
    sending = sending
      .then(() => {
        if (stopping.signal.aborted) return;
        const fresh = picks.filter((p) => p.seq > control.get().notifiedSeq).sort((a, b) => a.seq - b.seq);
        if (!fresh.length) return;
        // Each story is emitted once per process, before ntfy and the webhook, so a failing send never repeats it.
        const toEmit = fresh.filter((p) => NOTIFY_LEVELS.includes(p.pick.level) && p.seq > emittedSeq);
        if (appNotify && toEmit.length) {
          changes.emitNotify(toEmit.map((p) => p.pick));
          emittedSeq = toEmit[toEmit.length - 1].seq;
        }
        if (!targets.length) control.setNotifiedSeq(fresh[fresh.length - 1].seq);
        for (const target of targets) deliver(target, picks);
      })
      .catch((error) => log('warning', `A notifier could not send and will try again: ${(error as Error).message}`));
  };

  const stopTopics = watchTopicsReady((line) => log('warning', line));
  const stopStories = watchFinishedStories(async () => notifyNew(await feed()), (line) => log('warning', line));

  // Served while reading is paused: it only reads what is already stored.
  const display = createDisplayService();
  const services: PodServices = {
    aiService: createAiService({
      paths: cfg.paths,
      fetch: context.aiFetch,
      apply: context.applyAi,
      keyFromEnv: context.aiKeyFromEnv,
      hasAi: () => !!cfg.ai,
      readNow: () => services.reading.readNow(),
      log,
    }),
    commands: createCommands(log, display),
    profile,
    // Chat is the person's own action, so it is served while reading is paused.
    model: createModelService(cfg),
    news,
    // Served while reading is paused, like the news: the assistant or the person asks for it.
    stories: stories.stories,
    followed: createFollowed({ hasAi: () => !!cfg.ai }),
    display,
    events: changes.events,

    suggestions: {
      async get({ since, limit, fits, peek }) {
        if (!Number.isInteger(limit) || limit < 1) throw new PodError('bad_limit', 'limit must be a whole number of at least 1.', 'pass a limit such as 10');
        const [snapshot, reply] = await Promise.all([
          takeSnapshot(snapshotInputs),
          ledger.run(async (tx) => {
            const { candidates, liveIds } = await readFeed(stories.leftOut());
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
        const [snapshot, picks, known, setup] = await Promise.all([takeSnapshot(snapshotInputs), feed(), dataServer, readSetup(!!cfg.ai)]);
        return { ...buildStatus(cfg, control, { ...snapshot, reasons: reasonsOn() }, picks.length, known), ...(setup.complete ? {} : { setup }) };
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
      stopping.abort();
      changes.stop();
      stopTopics();
      stopStories();
      // A paired phone's mute and topic delete leave timers in the client; a stopped pod keeps none.
      client<{ cancelPendingPurges(): void }>('database/services/publication-pref-ui-actions').cancelPendingPurges();
      client<{ cancelPendingDeletes(): void }>('database/services/topic-decline-service').cancelPendingDeletes();
    },
  };
}
