// What state the pod is in, said plainly: one state, one sentence a person can be told, and when
// reading happens next. A reply that carries no picks always says why through this.
import type { LoadedConfig } from '../config';
import type { Control } from '../control';
import type { PodProblem, PodStatus, SuggestionsState } from '../plugin-api';

type Fact = { id: string; topicsStatus: string | null };
const client = <T>(file: string) => require(`mera-news-client/dist/lib/${file}`) as T;

/** Shown when the data server will not say what it offers: what a self-hosted server may lack. */
export const ALL_LIMITS = ['followed stories', 'place lookup', 'story grouping refresh', 'windowed headlines', 'world headlines'];
// The query that serves each feature, so a server that lacks the query lacks the feature.
const FEATURE_QUERIES: Record<string, string> = {
  'followed stories': 'articlesForStories',
  'place lookup': 'placeSearch',
  'story grouping refresh': 'clusterMembershipsForArticles',
  'windowed headlines': 'topHeadlinesForCountry',
  'world headlines': 'worldHeadlines',
};

/** One question to the data server at start: which queries it answers. Any refusal gives the full list. */
export async function fetchLimits(cfg: LoadedConfig): Promise<string[]> {
  try {
    const res = await fetch(cfg.dataServer.graphqlUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cfg.dataServer.apiKey ? { 'x-api-key': cfg.dataServer.apiKey } : {}) },
      body: JSON.stringify({ query: '{ __type(name: "Query") { fields { name } } }' }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json()) as { data?: { __type?: { fields?: { name: string }[] } } };
    const names = body.data?.__type?.fields?.map((f) => f.name);
    if (!res.ok || !names) return ALL_LIMITS;
    return ALL_LIMITS.filter((feature) => !names.includes(FEATURE_QUERIES[feature]));
  } catch {
    return ALL_LIMITS;
  }
}

export interface Snapshot {
  facts: number;
  topics: number;
  topicsPending: number;
  topicsFailed: number;
  unscored: number;
  lastRunMs: number | null;
  frequencyMs: number;
  readingNow: boolean;
  readFailing: boolean;
  aiKeyRefused: boolean;
  dataKeyRefused: boolean;
  /** Where an unreadable pick history was moved at start. */
  picksSetAside?: string;
}

export interface SnapshotInputs {
  keyRefused(server: 'ai' | 'data'): boolean;
  picksSetAside?: string;
}

export async function takeSnapshot(inputs: SnapshotInputs): Promise<Snapshot> {
  const { getFacts } = client<{ getFacts(): Promise<Fact[]> }>('database/services/fact-service');
  const { getActive } = client<{ getActive(): Promise<unknown[]> }>('database/services/topic-service');
  const { countUnscoredSuggestions } = client<{ countUnscoredSuggestions(): Promise<number> }>('database/services/article-suggestion-reads');
  const { AppScheduler } = client<{ AppScheduler: { tasks: Map<string, { frequency: number }>; _msSinceFailure(name: string): number | null } }>('scheduler/AppScheduler');
  const { useSchedulerStore } = client<{ useSchedulerStore: { getState(): { isRunning(name: string): boolean; getLastRun(name: string): number | null } } }>('scheduler/scheduler-store');

  const facts = await getFacts();
  const scheduler = useSchedulerStore.getState();
  return {
    facts: facts.length,
    topics: (await getActive()).length,
    topicsPending: facts.filter((f) => f.topicsStatus === 'pending').length,
    topicsFailed: facts.filter((f) => f.topicsStatus === 'error').length,
    unscored: await countUnscoredSuggestions(),
    lastRunMs: scheduler.getLastRun('feed-sync'),
    frequencyMs: AppScheduler.tasks.get('feed-sync')!.frequency,
    readingNow: scheduler.isRunning('feed-sync'),
    // A failed read stays recorded until the next one succeeds.
    readFailing: AppScheduler._msSinceFailure('feed-sync') !== null,
    aiKeyRefused: inputs.keyRefused('ai'),
    dataKeyRefused: inputs.keyRefused('data'),
    picksSetAside: inputs.picksSetAside,
  };
}

export function problemsOf(s: Snapshot): PodProblem[] {
  const problems: PodProblem[] = [];
  if (s.aiKeyRefused) {
    problems.push({
      code: 'ai_key_refused',
      who: 'person',
      fix: 'The AI service refuses the pod\'s key, so nothing can be rated. Set aiApiKey in secrets.json (or MERA_POD_AI_API_KEY), then restart the pod.',
    });
  }
  if (s.dataKeyRefused) {
    problems.push({
      code: 'data_key_refused',
      who: 'person',
      fix: 'The data server refuses the pod\'s key, so no news can be fetched. Set dataApiKey in secrets.json (or MERA_POD_DATA_API_KEY) to the key the data server expects, then restart the pod.',
    });
  }
  if (s.readFailing) {
    problems.push({
      code: 'read_failing',
      who: 'person',
      fix: 'The last read failed. Check that the data server and the model are running and that the keys in secrets.json are right, then run mera-news-pod check.',
    });
  }
  if (s.facts > 0 && s.topics === 0 && s.topicsPending === 0) {
    problems.push({ code: 'no_topics', who: 'assistant', fix: 'No saved fact has topics, so nothing is being read. Adding a fact again retries its topics.' });
  } else if (s.topicsFailed > 0) {
    problems.push({ code: 'topics_failed', who: 'assistant', fix: 'Topics could not be made for some facts. Adding the same fact again retries it.' });
  }
  if (s.picksSetAside) {
    problems.push({
      code: 'picks_history_reset',
      who: 'person',
      fix: `The pick history could not be read and was moved to ${s.picksSetAside}, so some picks may be delivered once more.`,
    });
  }
  return problems;
}

/** When the next read is, in words. */
export function when(nextReadAt: string | null, now = Date.now()): string {
  if (!nextReadAt) return 'soon';
  const minutes = Math.round((Date.parse(nextReadAt) - now) / 60_000);
  if (minutes < 1) return 'within a minute';
  if (minutes < 60) return `in about ${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  return `in about ${hours} hour${hours === 1 ? '' : 's'}`;
}

export const nextReadAtOf = (s: Snapshot, paused: boolean): string | null =>
  paused || s.lastRunMs === null ? null : new Date(s.lastRunMs + s.frequencyMs).toISOString();

const BLOCKING = ['ai_key_refused', 'data_key_refused', 'read_failing', 'no_topics'];

/** `returned`: how many picks the reply carries. A reply with picks is never `first_read_pending`; a problem or a pause still says so. */
export function judge(s: Snapshot, paused: boolean, returned = 0, now = Date.now()): { state: SuggestionsState; hint: string; nextReadAt: string | null } {
  const nextReadAt = nextReadAtOf(s, paused);
  const next = `The next read is ${when(nextReadAt, now)}.`;
  const blocking = problemsOf(s).find((p) => BLOCKING.includes(p.code));
  let state: SuggestionsState;
  let hint: string;
  if (blocking) {
    state = 'problem';
    hint = `${blocking.fix} ${blocking.who === 'person' ? `Mera tries again ${when(nextReadAt, now)}.` : ''}`.trim();
  } else if (s.facts === 0) {
    state = 'no_facts';
    hint = 'Nothing is saved about what you want to read yet, so there is nothing to look for. Add a fact about yourself or an interest, then check again in a few minutes.';
  } else if (s.topics === 0 && s.topicsPending > 0) {
    state = 'topics_pending';
    hint = 'Topics are still being made from your saved facts. Check again in a few minutes.';
  } else if (returned === 0 && s.topics > 0 && (s.lastRunMs === null || s.unscored > 0)) {
    state = 'first_read_pending';
    hint = `The first read has not finished, or news is still being rated. ${next} Check again in a few minutes.`;
  } else if (paused) {
    state = 'paused';
    hint = 'Reading is paused, so no new picks will come until it is turned back on.';
  } else {
    state = 'ok';
    hint = s.unscored > 0 ? `Reading is on, and more articles are still being rated. ${next}` : `Reading is on. ${next}`;
  }
  return { state, hint, nextReadAt };
}

export function buildStatus(cfg: LoadedConfig, control: Control, s: Snapshot, picks: number, limits: string[]): PodStatus {
  const paused = control.get().paused;
  return {
    reading: control.readingState(),
    everyMinutes: control.get().everyMinutes,
    readingNow: s.readingNow,
    firstReadDone: s.lastRunMs !== null,
    lastRunAt: s.lastRunMs === null ? null : new Date(s.lastRunMs).toISOString(),
    nextReadAt: nextReadAtOf(s, paused),
    unscored: s.unscored,
    counts: { facts: s.facts, topics: s.topics, topicsPending: s.topicsPending, picks },
    problems: problemsOf(s),
    limits,
    ai: { host: new URL(cfg.ai.baseUrl).host, model: cfg.ai.model },
    dataServer: { host: new URL(cfg.dataServer.graphqlUrl).host },
  };
}
