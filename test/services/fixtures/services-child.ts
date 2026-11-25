// Runs the pod with its real services in its own process, and answers commands from the test over
// the IPC channel. It ends when that channel closes, which also happens when the test process dies.
import { boot, type Pod } from '../../../src/boot';
import { installProcessHandlers } from '../../../src/process';
import type { PodServices } from '../../../src/plugin-api';
import { createServices } from '../../../src/services';
import { READING_TASKS } from '../../../src/control';

const send = (message: unknown, done?: () => void) => process.send?.(message, undefined, undefined, () => done?.());
process.on('disconnect', () => process.exit(0));

const client = <T>(file: string) => require(`mera-news-client/dist/lib/${file}`) as T;

// The timers the client's delayed writes start (a mute's purge, a staged topic delete), told apart
// by where they were made, so a test can ask about exactly those and not every timer in the process.
const delayedWrites = new Set<unknown>();
const DELAYED_WRITE = /publication-pref-ui-actions|topic-decline-service/;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
  const tracked = DELAYED_WRITE.test(new Error().stack ?? '');
  const timer = realSetTimeout((...a: unknown[]) => {
    delayedWrites.delete(timer);
    fn(...a);
  }, ms, ...args);
  if (tracked) delayedWrites.add(timer);
  return timer;
}) as typeof setTimeout;
globalThis.clearTimeout = ((timer?: Parameters<typeof clearTimeout>[0]) => {
  delayedWrites.delete(timer);
  realClearTimeout(timer);
}) as typeof clearTimeout;
type Row = {
  id: string;
  status?: string;
  relevance?: number;
  reason?: string;
  title?: string;
  titleOriginal?: string;
  url?: string;
  lang?: string;
  publishedHoursAgo?: number;
  cluster?: string;
  factIds?: string[];
};
type Db = { get(t: string): any; write<T>(fn: () => Promise<T>): Promise<T>; batch(...ops: unknown[]): Promise<void> };

async function plantRows(rows: Row[]) {
  const { default: database } = client<{ default: Db }>('database/index');
  const col = database.get('article_suggestions');
  const links = database.get('article_suggestion_facts');
  const now = new Date();
  await database.write(async () => {
    const ops: unknown[] = [];
    for (const row of rows) {
      // A read already in flight may have stored the row first: the planted values replace it, so a test never depends on that timing.
      const fill = (r: any) => {
        r.articleId = row.id;
        r.clusterMembershipsJson = row.cluster ? JSON.stringify([{ clusterId: row.cluster, confidence: 0.95, stableClusterId: row.cluster }]) : null;
        r.relevance = row.relevance ?? 0.9;
        r.reason = row.reason ?? `Why ${row.id} matters to you.`;
        r.status = row.status ?? 'complete';
        r.languageCode = row.lang ?? 'en';
        r.publicationName = `Paper ${row.id}`;
        // Made-up words per id, because the Feed shows headlines that share most words as one story.
        // Ids that share a part (`old-a`, `old-b`) give such headlines.
        r.titleEn = row.title ?? `Zxq${row.id} vorpal${row.id} glimmer${row.id}`;
        r.titleOriginal = row.titleOriginal ?? row.title ?? `Zxq${row.id} vorpal${row.id} glimmer${row.id}`;
        r.descriptionEn = `ARTICLE BODY ${row.id}`;
        r.articleUrl = row.url ?? `https://example.com/${row.id}`;
        r.matchedTopicTextsJson = '[]';
        r.rawScore = row.relevance ?? 0.9;
        r.scoredAt = Date.now();
        r.createdAt = now;
        r.firstPubDate = new Date(Date.now() - (row.publishedHoursAgo ?? 1) * 3_600_000);
      };
      const existing = await col.find(row.id).catch(() => null);
      ops.push(existing ? existing.prepareUpdate(fill) : col.prepareCreate((r: any) => { r._raw.id = row.id; fill(r); }));
      for (const factId of row.factIds ?? []) {
        ops.push(links.prepareCreate((r: any) => { r.articleSuggestionId = row.id; r.factId = factId; r.createdAt = now; }));
      }
    }
    await database.batch(...ops);
  });
}

async function main() {
  let pod: Pod;
  let services!: PodServices;
  // failNextApply makes the next control.apply throw once; queueStarts counts inferenceQueue.start calls.
  let failApply = false;
  let queueStarts = 0;
  try {
    pod = await boot({
      sink: (_level, line) => send({ log: line }),
      createServices: (context) => {
        const realApply = context.control.apply;
        context.control.apply = () => {
          if (failApply) {
            failApply = false;
            throw new Error('the control could not be applied');
          }
          realApply();
        };
        const { inferenceQueue } = client<{ inferenceQueue: { start(): Promise<void> } }>('inference/InferenceQueue');
        const realStart = inferenceQueue.start.bind(inferenceQueue);
        inferenceQueue.start = () => (queueStarts++, realStart());
        const made = createServices(context);
        services = made.services;
        return made;
      },
    });
  } catch (error) {
    send({ error: (error as Error).message }, () => process.exit(1));
    return;
  }
  const handlers = installProcessHandlers({
    log: (line) => send({ log: line }),
    shutdown: pod.stop,
    exit: (code) => send({ exit: code }, () => process.exit(code)),
  });
  send({ ready: true });

  process.on('message', async (msg: { id: number; cmd: string; arg?: any }) => {
    const reply = (value: unknown) => send({ id: msg.id, value });
    try {
      switch (msg.cmd) {
        case 'call': {
          const [group, name] = String(msg.arg.fn).split('.');
          const args = (msg.arg.args ?? []) as any[];
          // A function cannot cross the channel: `fitsChars` stands for a caller whose replies hold that many characters of picks.
          if (args[0]?.fitsChars) {
            const { fitsChars, ...rest } = args[0];
            args[0] = { ...rest, fits: (picks: unknown[]) => JSON.stringify(picks).length <= fitsChars };
          }
          try {
            return reply({ ok: await (services as any)[group][name](...args) });
          } catch (error) {
            const e = error as Error & { code?: string; next?: string };
            return reply({ error: { message: e.message, code: e.code, next: e.next } });
          }
        }
        case 'plant': await plantRows(msg.arg); return reply(null);
        case 'patchRow': { // `table` defaults to article_suggestions; `raw` sets stored columns by their names
          const { default: database } = client<{ default: Db }>('database/index');
          const row = await database.get(msg.arg.table ?? 'article_suggestions').find(msg.arg.id);
          await database.write(() =>
            row.update((r: any) => {
              Object.assign(r, msg.arg.patch);
              for (const [k, v] of Object.entries(msg.arg.raw ?? {})) r._setRaw(k, v);
            }),
          );
          return reply(null);
        }
        case 'rowStatus': {
          const { default: database } = client<{ default: Db }>('database/index');
          return reply((await database.get('article_suggestions').find(msg.arg)).status);
        }
        case 'deleteRow': {
          const { default: database } = client<{ default: Db }>('database/index');
          const row = await database.get('article_suggestions').find(msg.arg);
          await database.write(() => row.destroyPermanently());
          return reply(null);
        }
        case 'plantFact': { // a fact with the given topics status and topics, without any model call
          const { addFact } = client<{ addFact(s: string, m?: object, q?: object, o?: object): Promise<{ id: string }> }>('database/services/fact-service');
          const { createTopics } = client<{ createTopics(i: object[]): Promise<{ id: string }[]> }>('database/services/topic-service');
          const fact = await addFact(msg.arg.statement, msg.arg.metadata, undefined, { topicsStatus: msg.arg.status });
          const topics = await createTopics((msg.arg.topics ?? []).map((t: { text: string; provenance?: string }) => ({ factId: fact.id, text: t.text, weight: 1, provenance: t.provenance ?? 'llm' })));
          return reply({ id: fact.id, topicIds: topics.map((t) => t.id) });
        }
        case 'plantTopic': { // one topic on a saved fact, as another writer (a combination pass, say) would add it
          const { createTopics } = client<{ createTopics(i: object[]): Promise<{ id: string }[]> }>('database/services/topic-service');
          const [topic] = await createTopics([{ factId: msg.arg.factId, text: msg.arg.text, weight: 1, provenance: msg.arg.provenance }]);
          return reply(topic.id);
        }
        case 'factRows': // the saved facts as the client stores them, with fields profile.get does not show
          return reply(await client<{ getFacts(): Promise<unknown[]> }>('database/services/fact-service').getFacts());
        case 'holdReads': { // pauses or resumes the reading tasks without the pod's own pause, so a state can be read before any read clears it
          const { AppScheduler } = client<{ AppScheduler: { pauseTask(n: string): void; resumeTask(n: string): void } }>('scheduler/AppScheduler');
          for (const name of READING_TASKS) (msg.arg ? AppScheduler.pauseTask(name) : AppScheduler.resumeTask(name));
          return reply(null);
        }
        case 'readsRunning': // true while a reading task started before holdReads is still running
          return reply(READING_TASKS.some((name) => client<{ useSchedulerStore: { getState(): { isRunning(n: string): boolean } } }>('scheduler/scheduler-store').useSchedulerStore.getState().isRunning(name)));
        case 'lastRun': // makes the reading task look as if it finished a run just now
          client<{ useSchedulerStore: { getState(): { loadLastRunTimes(t: object): void } } }>('scheduler/scheduler-store').useSchedulerStore.getState().loadLastRunTimes({ 'feed-sync': msg.arg ?? Date.now() });
          return reply(null);
        case 'state': return reply({ ...pod.control.get(), reading: pod.control.readingState(), rejections: handlers.rejections() });
        case 'trigger': return reply(await client<{ AppScheduler: { trigger(n: string): Promise<string> } }>('scheduler/AppScheduler').AppScheduler.trigger('feed-sync'));
        case 'lastTrigger': // when the pod itself last asked for a read; the schedule's own runs do not set it
          return reply(client<{ AppScheduler: { lastTriggerAt: Map<string, number> } }>('scheduler/AppScheduler').AppScheduler.lastTriggerAt.get('feed-sync') ?? null);
        case 'regenerate': { // asks for a fresh round of topics for a fact, as the app's retry does
          const { getFacts } = client<{ getFacts(): Promise<{ id: string; statement: string }[]> }>('database/services/fact-service');
          const { retryTopicGeneration } = client<{ retryTopicGeneration(id: string, s: string): Promise<void> }>('chat-tools/tool-handlers');
          const fact = (await getFacts()).find((f) => f.id === msg.arg)!;
          await retryTopicGeneration(fact.id, fact.statement);
          return reply(null);
        }
        case 'failNextApply': failApply = true; return reply(null);
        case 'queueStarts': return reply(queueStarts);
        case 'heap': global.gc?.(); return reply(process.memoryUsage().heapUsed);
        case 'rowCount': {
          const { default: database } = client<{ default: Db }>('database/index');
          return reply(await database.get(msg.arg).query().fetchCount());
        }
        case 'overlap': return reply({ overlap, runs });
        case 'stop': await pod.stop(); return send({ id: msg.id, value: null }, () => process.exit(0));
        // Stops the pod and answers how many delayed-write timers were alive before and after, then exits.
        case 'stopAndCountDelayedWrites': {
          const before = delayedWrites.size;
          await pod.stop();
          return send({ id: msg.id, value: { before, after: delayedWrites.size } }, () => process.exit(0));
        }
      }
    } catch (error) {
      reply({ crashed: (error as Error).message });
    }
  });

  // Counts finished feed-sync runs, and any that starts while another is still going.
  let overlap = 0;
  let runs = 0;
  const { useSchedulerStore } = client<{ useSchedulerStore: { subscribe(fn: (s: any, prev: any) => void): void } }>('scheduler/scheduler-store');
  useSchedulerStore.subscribe((state, prev) => {
    if (state.taskLastRun['feed-sync'] !== prev.taskLastRun['feed-sync']) runs++;
    if (state.runningCount > 1 && state.runningCount > prev.runningCount) {
      const running = Object.values(state.jobs as Record<string, { taskName: string; status: string }>).filter((j) => j.taskName === 'feed-sync' && j.status === 'running');
      if (running.length > 1) overlap++;
    }
  });
}
void main();
