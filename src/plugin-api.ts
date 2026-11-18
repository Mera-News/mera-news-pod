// The contract between the pod and its plugins. A plugin imports these types only, never pod or
// client code: it gets everything it may touch through the context the pod hands it.

/** The contract version. A plugin that names another version is refused at boot. */
export const POD_API = 1 as const;

// --- What a plugin reads and changes -------------------------------------------------------------

export type TopicsStatus = 'pending' | 'done' | 'error' | 'none';
export type TopicSource = 'generated' | 'added' | 'followed';
export type PickLevel = 'emergency' | 'high' | 'medium' | 'low';

export interface TopicView {
  id: string;
  text: string;
  /** -1 shows less of it, 1 shows more; it never hides a topic. */
  weight: number;
  source: TopicSource;
}

export interface FactView {
  id: string;
  statement: string;
  topicsStatus: TopicsStatus;
  /** ISO time the fact was saved. */
  addedAt: string;
  topics: TopicView[];
}

export interface ProfileView {
  facts: FactView[];
  /** Pass to `profile.get` for the next page; absent on the last one. */
  nextOffset?: number;
}

export interface AddFactsResult {
  added: { id: string; statement: string; retried?: boolean }[];
  already: { id: string; statement: string }[];
  refused: { statement: string; code: 'conflict'; conflictsWith: { id: string; statement: string }; next: string }[];
  /** A home fact was added while the data server cannot look up places. */
  localCoverageWeaker?: boolean;
}

export interface RemoveFactsResult {
  removed: { id: string; statement: string; topics: string[] }[];
  notFound: string[];
}

export interface TopicEdit {
  remove?: string[];
  weight?: { topicId: string; weight: number }[];
}

export interface TopicEditResult {
  results: { op: 'remove' | 'weight'; index: number; ok: boolean; id: string; error?: string }[];
}

export interface PickView {
  id: string;
  title: string;
  publication: string;
  url: string;
  publishedAt: string;
  level: PickLevel;
  /** The article's language. The reason is in the pod's configured language. */
  lang: string;
  reason: string;
  /** The saved facts this pick ties to. */
  facts: string[];
}

export type SuggestionsState = 'ok' | 'no_facts' | 'topics_pending' | 'first_read_pending' | 'paused' | 'problem';

export interface SuggestionsReply {
  state: SuggestionsState;
  /** One plain sentence on what is happening and when to look again. */
  hint: string;
  nextReadAt: string | null;
  picks: PickView[];
  cursor: string;
  more: boolean;
  /** The pod's pick history started over: these picks count from the beginning. */
  reset?: boolean;
}

export type ReadingState = 'on' | 'pausing' | 'paused';

export interface PodProblem {
  code: string;
  /** Who can fix it: the assistant through a tool, or only the person. */
  who: 'assistant' | 'person';
  fix: string;
}

export interface PodStatus {
  reading: ReadingState;
  everyMinutes: number;
  readingNow: boolean;
  firstReadDone: boolean;
  lastRunAt: string | null;
  nextReadAt: string | null;
  unscored: number;
  counts: { facts: number; topics: number; topicsPending: number; picks: number };
  problems: PodProblem[];
  /** Features the configured data server does not offer, by plain name. */
  limits: string[];
  ai: { host: string; model: string };
  dataServer: { host: string };
}

export interface PodServices {
  profile: {
    get(options?: { offset?: number }): Promise<ProfileView>;
    addFacts(statements: string[]): Promise<AddFactsResult>;
    removeFacts(ids: string[]): Promise<RemoveFactsResult>;
    editTopics(edit: TopicEdit): Promise<TopicEditResult>;
  };
  suggestions: {
    /** `since`: a cursor, 'all' to replay, or absent for "after the last pick delivered". */
    get(options: { since?: string; limit: number }): Promise<SuggestionsReply>;
  };
  reading: {
    status(): Promise<PodStatus>;
    set(change: { paused?: boolean; everyMinutes?: number }): Promise<PodStatus>;
  };
}

// --- What a plugin is given and returns ----------------------------------------------------------

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export type PodEvent = 'picks' | 'profile' | 'status';

export interface PluginContext {
  podApi: typeof POD_API;
  services: PodServices;
  /** The plugin's own section of pod.json, as written. */
  config: unknown;
  /** A directory only this plugin writes, inside the pod's data directory. */
  dataDir: string;
  log: Logger;
  /** The token estimate the client uses for its own prompts. */
  estimateTokens(text: string): number;
  /** Reserved for later plugins: not provided by this version of the pod. */
  on?(event: PodEvent, listener: (payload: unknown) => void): () => void;
}

export interface PodPlugin {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Lines `mera-news-pod check` prints for this plugin, such as its address. */
  describe?(): string[];
}

/** What a plugin module exports as `createPlugin`. Plugins are trusted code with the pod's access. */
export type CreatePlugin = (context: PluginContext) => PodPlugin | Promise<PodPlugin>;
