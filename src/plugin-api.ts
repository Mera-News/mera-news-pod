// The contract between the pod and its plugins. A plugin imports these types only, never pod or
// client code: it gets everything it may touch through the context the pod hands it.

/** The newest contract version. The pod accepts a plugin that names this one or an older one it still speaks. */
export const POD_API = 2 as const;
/** Every contract version the pod speaks. A plugin that names another is refused at boot. */
export const POD_API_VERSIONS = [1, 2] as const;
export type PodApiVersion = (typeof POD_API_VERSIONS)[number];

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

/** What the data server answers to a GraphQL request, as it sent it. */
export interface GraphqlReply {
  data?: unknown;
  errors?: { message: string; extensions?: { code?: string; [key: string]: unknown } }[];
}

/** One table of a snapshot. `rows` is absent when the caller already holds this hash. */
export interface SnapshotTable {
  hash: string;
  mode: 'replace' | 'merge';
  rows?: Record<string, unknown>[];
}

/** A batch of named changes from a paired phone, run by the client's own registered writers. */
export interface CommandRequest {
  /** The schema and command registry versions the caller runs; a difference refuses the batch. */
  schemaVersion: number;
  registry: number;
  /** The table hashes the caller holds, so the snapshot sent back carries only what changed. */
  hashes?: Record<string, string>;
  commands: { name: string; args?: unknown[] }[];
}
export type CommandResult = { ok: unknown } | { error: { code: string; message: string } };
export interface CommandsReply {
  /** One per command, in order; after the first error the rest are `earlier_change_failed`. */
  results: CommandResult[];
  /** The tables after the batch, as `display.snapshot` serves them for the same hashes. */
  snapshot: Snapshot;
}

export interface Snapshot {
  schemaVersion: number;
  registry: number;
  tables: Record<string, SnapshotTable>;
}

export interface PodServices {
  profile: {
    get(options?: { offset?: number }): Promise<ProfileView>;
    addFacts(statements: string[]): Promise<AddFactsResult>;
    removeFacts(ids: string[]): Promise<RemoveFactsResult>;
    editTopics(edit: TopicEdit): Promise<TopicEditResult>;
    /** Contract version 2 and later. True when the pod holds at least one fact. */
    hasProfile(): Promise<boolean>;
    /**
     * Contract version 2 and later. Replaces the pod's whole profile with the given rows (the tables
     * a snapshot serves for facts, topics, places, preferences, followed and saved stories), clears
     * the feed so no pick made for the old profile is delivered, and starts a read. It destroys the
     * pod's profile: a plugin offers it only where the person chose it. The sync plugin allows it
     * only for the first device paired.
     */
    replaceProfile(profile: { schemaVersion: number; tables: Record<string, { rows?: Record<string, unknown>[] }> }): Promise<void>;
  };
  suggestions: {
    /**
     * `since`: a cursor, 'all' to replay, or absent for "after the last pick delivered". `fits`: a
     * caller with a size limit says whether a page of picks fits; the page is cut until it does (never
     * below one pick), and only the picks returned count as delivered, so a cut loses none.
     */
    get(options: { since?: string; limit: number; fits?: (picks: PickView[]) => boolean }): Promise<SuggestionsReply>;
  };
  reading: {
    status(): Promise<PodStatus>;
    set(change: { paused?: boolean; everyMinutes?: number }): Promise<PodStatus>;
    /** Contract version 2 and later. Starts a read: `ran`, `busy`, `debounced`, or `paused` while reading is paused. */
    readNow(): Promise<string>;
  };
  /** Contract version 2 and later. */
  commands: {
    /** Runs the batch in order through the client's registered writers and returns the tables after it. */
    run(request: CommandRequest): Promise<CommandsReply>;
  };
  model: {
    /**
     * Sends a chat completion to the pod's own AI endpoint with the pod's key and model. Only the
     * chat fields of the body pass and a `tools` field is refused. The reply streams back as it is.
     */
    chatCompletions(body: unknown, signal?: AbortSignal): Promise<Response>;
  };
  news: {
    /**
     * Sends news queries to the pod's data server. Only the news queries the client uses pass; any
     * other operation, or a batch holding one, answers a NOT_ALLOWED error without a request.
     */
    graphql(body: unknown): Promise<GraphqlReply | GraphqlReply[]>;
  };
  /** Contract version 2 and later. */
  display: {
    /**
     * The tables a phone shows, as plain rows. `hashes`: the hash the caller holds for each table; a
     * table with that same hash comes back without rows. `peer`: the caller's own schema and registry
     * versions; if they differ from the pod's the call fails with code `version_mismatch` and the
     * message says which side is older.
     */
    snapshot(options?: { hashes?: Record<string, string>; peer?: { schemaVersion: number; registry: number } }): Promise<Snapshot>;
  };
  /** Contract version 2 and later. */
  events: {
    /**
     * Calls `listener` with no arguments, at most once every two seconds, after any change to what
     * `display.snapshot` serves or to the pick history. Returns a function that stops listening. A
     * listener that throws is logged and does not stop the others.
     */
    on(event: 'changed', listener: () => void): () => void;
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
  /** The contract version the plugin named. */
  podApi: PodApiVersion;
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

/**
 * What a plugin module exports. `name` is short, lower case, digits and dashes, unique among the
 * pod's plugins; it names the plugin's data directory (`<data>/plugins/<name>`).
 */
export interface PluginModule {
  podApi: PodApiVersion;
  name: string;
  createPlugin: CreatePlugin;
}
