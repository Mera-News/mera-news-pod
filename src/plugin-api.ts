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
  /** False only for a topic of a fact that needs review, made after the person last reviewed it. */
  reviewed: boolean;
}

export interface FactView {
  id: string;
  statement: string;
  topicsStatus: TopicsStatus;
  /** ISO time the fact was saved. */
  addedAt: string;
  topics: TopicView[];
  /** True for a fact saved through `addFacts`: the person is shown its topics to keep or remove. */
  needsReview: boolean;
  /** ISO time the person last reviewed this fact's topics (`editTopics({ reviewed })`). */
  reviewedAt?: string;
}

/**
 * Where setting up the profile stands, over every saved fact, not one page. Each list holds fact
 * statements. Only facts that need review count; combination topics are left out. A status the
 * assistant works toward, never a reason to stop answering.
 */
export interface ProfileSetup {
  complete: boolean;
  /** The pod's AI service is still making topics. */
  findingTopics: string[];
  /** Topics are ready and wait for the person to keep or remove them. */
  toReview: string[];
  /** Topics failed, none were made, or the pod has no AI service to make them: add topics or remove the fact. */
  noTopics: string[];
}

export interface ProfileView {
  facts: FactView[];
  /** Pass to `profile.get` for the next page; absent on the last one. */
  nextOffset?: number;
  setup: ProfileSetup;
}

export interface AddFactsResult {
  added: { id: string; statement: string; retried?: boolean }[];
  already: { id: string; statement: string }[];
  refused: { statement: string; code: 'conflict'; conflictsWith: { id: string; statement: string }; next: string }[];
  /** A home fact was added while the data server cannot look up places. */
  localCoverageWeaker?: boolean;
}

export interface AddTopicsResult {
  added: { id: string; text: string }[];
  /** Topics the person removed before, or the fact already has. */
  skipped: string[];
  /** Set when the pod has an AI service and makes its own topics as well. */
  note?: string;
}

export interface RemoveFactsResult {
  removed: { id: string; statement: string; topics: string[] }[];
  notFound: string[];
}

export interface TopicEdit {
  remove?: string[];
  weight?: { topicId: string; weight: number }[];
  /**
   * Fact ids whose topics the person has just reviewed, stamped after the removes. An unknown fact
   * (`unknown_fact`) or one whose topics are still being made (`topics_pending`) refuses the whole
   * call before anything changes.
   */
  reviewed?: string[];
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

export type Verdict = 'picked' | 'left_out';

/** What was decided about one story, and why: one sentence on why it matters, or why it was left out. */
export interface StoryVerdict {
  verdict: Verdict;
  reason: string;
  /** Set for every pick. */
  level?: PickLevel;
  /** `assistant`: through `stories.judge`. `pod`: the pod's own AI service picked it. */
  by: 'assistant' | 'pod';
  /** ISO time it was judged, for a verdict the pod stored. */
  at?: string;
}

/** One story that matched the person's topics: its lead report, never any article text. */
export interface ProfileStory {
  /** The lead article's id. Pass it to `stories.judge`. */
  id: string;
  /** The story's key: every report of one event shares it. */
  story: string;
  title: string;
  /** The English headline, when it differs from `title`. */
  titleEn?: string;
  link: string;
  publisher: string;
  publishedAt: string;
  language: string;
  /** The publisher's image, https only. */
  image?: string;
  /** Reports of this story among the matches. */
  reports: number;
  /** The facts whose topics matched it. */
  facts: { id: string; statement: string }[];
  topics: string[];
  /** Absent while nobody has judged it. */
  verdict?: StoryVerdict;
}

export interface StoriesSummary {
  /** Mera News searches the news of this many hours. */
  windowHours: number;
  /** Articles that matched a topic, and the stories they make once reports of one event are merged. */
  articles: number;
  stories: number;
  merged: number;
  topics: { text: string; matches: number }[];
  /** Per fact: the stories that matched it, and how many of those were picked and left out. */
  facts: { id: string; statement: string; matched: number; picked: number; leftOut: number }[];
  picked: number;
  leftOut: number;
  unjudged: number;
  /** Publishers and languages of every article in the run. */
  publishers: number;
  languages: number;
  /** False when the news server had more pages of matches than one run reads. */
  complete: boolean;
}

export interface StoriesPage {
  /** The run this page belongs to: `after` set to `<run>.0` reads it again from the start, with fresh verdicts. */
  run: string;
  summary: StoriesSummary;
  stories: ProfileStory[];
  /** Pass as `after` for the next page; absent on the last one. */
  nextCursor?: string;
  /** Unjudged stories left out of this run because an earlier run (not a peek) returned them. */
  shownBefore: number;
}

export interface JudgeResult {
  saved: { id: string; verdict: Verdict }[];
  /** Stories judged before: the first verdict stands. */
  already: { id: string; verdict: Verdict }[];
  /** Not saved: `unknown_story` (no such article), `reason_not_grounded` (a pick's reason shares no word with its headline; write it again) or `not_available` (muted or already read; never picked). */
  refused: { id: string; code: string; message: string }[];
}

/** One article of a followed story: never any article text beyond its headline. */
export interface FollowedArticle {
  id: string;
  /** The headline in the article's own language (`lang`), or the English one when the pod has only that. */
  title: string;
  /** The English headline, when it differs from `title`. */
  titleEn?: string;
  /** The article's language, `und` when unknown. */
  lang: string;
  publisher: string;
  /** The publisher's three-letter country code, when known. */
  country?: string;
  /** Null once the pod no longer holds the article's link. */
  url: string | null;
  /** The publisher's image, https only. */
  image?: string | null;
  publishedAt: string | null;
}

/** A story the person follows: it grows with every read that finds more of it. */
export interface FollowedStoryView {
  id: string;
  title: string;
  /** True when the title was written by Mera News (the story's label or its search), not a headline. */
  titleIsAi: boolean;
  /** Stories added since the person last looked, shared with a paired phone. */
  newCount: number;
  /** Articles on its timeline, copies of one story included. */
  articles: number;
  /** The newest article on its timeline. */
  latest: FollowedArticle | null;
  /** ISO time it last grew, or when it was followed. */
  updatedAt: string;
  followedAt: string;
  status: 'active' | 'ended';
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

/** An AI service the pod knows. `baseUrl` is null for one the person names by address. */
export interface AiProvider {
  id: string;
  name: string;
  baseUrl: string | null;
  /** The model suggested for chat and topics. */
  chatModel?: string;
  /** The model suggested for rating articles: a smaller, cheaper one. */
  relevanceModel?: string;
  /** True when the service answers GET /models, so `aiService.models` can fill a picker. */
  listsModels: boolean;
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
  /**
   * The AI service in use, or null when the pod has none. `model` serves chat and topics,
   * `relevanceModel` rates articles; `reasons` is false while the pod writes no reason for a pick.
   */
  ai: { host: string; model: string; relevanceModel: string; reasons: boolean } | null;
  dataServer: { host: string };
  /** Present only while setting up the profile is not finished. It never blocks reading or chat. */
  setup?: ProfileSetup;
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
    /**
     * Contract version 2 and later. Saves topics written outside the pod for one fact, at most 12,
     * each 1 to 80 characters, and marks the fact's topics done. Topics the person removed before and
     * ones the fact already has are skipped. An unknown fact id fails with code `unknown_fact`.
     */
    addTopics(factId: string, texts: string[]): Promise<AddTopicsResult>;
  };
  suggestions: {
    /**
     * `since`: a cursor, 'all' to replay, or absent for "after the last pick delivered". `fits`: a
     * caller with a size limit says whether a page of picks fits; the page is cut until it does (never
     * below one pick), and only the picks returned count as delivered, so a cut loses none. `peek`
     * delivers nothing, so a reader that only shows picks never takes them from another caller.
     */
    get(options: { since?: string; limit: number; fits?: (picks: PickView[]) => boolean; peek?: boolean }): Promise<SuggestionsReply>;
  };
  reading: {
    status(): Promise<PodStatus>;
    set(change: { paused?: boolean; everyMinutes?: number }): Promise<PodStatus>;
    /** Contract version 2 and later. Starts a read: `ran`, `busy`, `debounced`, or `paused` while reading is paused. */
    readNow(): Promise<string>;
  };
  /** Contract version 2 and later. */
  aiService: {
    /**
     * Tests, saves and switches to the person's OpenAI-compatible AI service, with no restart.
     * `baseUrl` is https, or http on this computer; `model` serves chat and topics and
     * `relevanceModel` (default `model`) rates articles. Without `apiKey` the saved key is used for
     * the same origin, and none for a new one. `reasons` turns the reason written for each pick on or
     * off (default: as it is). Before anything is saved, one short request per model goes to the
     * address: a refusal fails with code `ai_test_failed` and a sentence saying why, and nothing
     * changes. A bad value fails with `bad_input`. Once saved, the address, models and key go to
     * pod.json and secrets.json and take effect at once; topics that failed are made again and a
     * read starts. The answer is only `{ set: true }`: the key is never returned.
     */
    set(change: { baseUrl: string; model: string; relevanceModel?: string; apiKey?: string; reasons?: boolean }): Promise<{ set: true }>;
    /**
     * The chat models the service at `baseUrl` lists, sorted, for a picker. Without `apiKey` the
     * saved key is used for the same origin. Fails with `ai_models_failed` and a sentence saying why.
     */
    models(query: { baseUrl: string; apiKey?: string }): Promise<{ models: string[] }>;
    /** The services the pod knows, with their addresses and suggested models. */
    providers(): readonly AiProvider[];
    /** Turns the reason written for each pick on or off. Fails with `no_ai_service` while there is none. */
    setReasons(on: boolean): Promise<{ set: true }>;
  };
  /** Contract version 2 and later. */
  stories: {
    /**
     * One page of every story that matches the person's topics, each with its verdict when it has one.
     * A call without `after` starts a run (one made in the last minute for the same topics is reused);
     * `after` continues it. `limit` is 0 to 50 (default 20); 0 returns the summary only. Without
     * `peek`, the unjudged stories returned are recorded as shown, and later runs leave them out for 72
     * hours; `peek` records nothing, for a page that only shows stories. `fits` works as in
     * `suggestions.get`, and is given the page's summary too. An `after` from a run the pod no longer holds fails with `run_expired`.
     * `fact` limits the run to the stories that fact's topics matched, with the summary counted for
     * that fact only, and its own run and cursor, so each fact can load and page on its own; what
     * another run already fetched is not fetched again. An unknown fact, or an `after` from a run for
     * another fact, fails with `bad_input`.
     */
    forProfile(options?: { fact?: string; after?: string; limit?: number; peek?: boolean; fits?: (stories: ProfileStory[], summary: StoriesSummary) => boolean }): Promise<StoriesPage>;
    /**
     * Saves one verdict per story, by the `id` `forProfile` gave: picked (with a level) or left out,
     * each with a one-sentence reason. A story keeps its first verdict, whichever report is named. A
     * pick becomes one of the pod's own picks, so `suggestions.get`, the notifiers and a paired phone
     * get it; a story left out never shows as a pick. At most 50 at once; a bad item fails the call
     * with `bad_input` before anything is saved.
     */
    judge(verdicts: { id: string; verdict: Verdict; reason: string; level?: PickLevel }[]): Promise<JudgeResult>;
  };
  /** Contract version 2 and later. The stories the person follows, as the Mera News app shows them. */
  followed: {
    /** Every followed story: those with new articles first, then the most recently updated. */
    list(): Promise<{ stories: FollowedStoryView[] }>;
    /**
     * One story and a page of its timeline, newest first, copies of one event folded into one entry
     * (`copies` counts the others). `limit` is 1 to 50 (default 20); `cursor` goes back as `after`.
     * `markSeen: true` clears its new count, also on a paired phone, so a page that only shows the
     * story leaves it out; `story.newCount` is the count before it was cleared. An unknown id fails
     * with `unknown_story`.
     */
    get(id: string, options?: { after?: string; limit?: number; markSeen?: boolean }): Promise<{ story: FollowedStoryView; entries: { head: FollowedArticle; copies: number }[]; cursor: string | null; more: boolean }>;
    /**
     * Follows a story by what to search for: `text` is 1 to 80 characters, kept as written. `label`
     * (default `text`) is its title; `fromArticleId` seeds it with that article. Following the same
     * search again answers `already` with the story's id. The story grows only while the pod reads
     * the news, which needs an AI service; `hint` says so.
     */
    follow(input: { text: string; label?: string; fromArticleId?: string }): Promise<{ id: string; state: 'followed' | 'already'; hint: string }>;
    /** Stops following and stops its search. An unknown id fails with `unknown_story`. */
    unfollow(id: string): Promise<{ removed: true }>;
    /** Takes an article, with the copies folded with it, off the story's timeline for good. */
    removeArticle(id: string, articleId: string): Promise<{ removed: true }>;
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
    /** The schema and command registry versions this pod runs, without reading any table. */
    versions(): { schemaVersion: number; registry: number };
  };
  /** Contract version 2 and later. */
  events: {
    /**
     * Calls `listener` with no arguments, at most once every two seconds, after any change to what
     * `display.snapshot` serves or to the pick history. Returns a function that stops listening. A
     * listener that throws is logged and does not stop the others.
     */
    on(event: 'changed', listener: () => void): () => void;
    /**
     * Calls `listener` with the new `emergency` and `high` picks of a batch, once per pick for the
     * life of the pod process, whatever ntfy and the webhook do. Never awaited; a listener that
     * throws or rejects is logged and does not stop the others. Returns a function that stops listening.
     */
    on(event: 'notify', listener: (picks: PickView[]) => void | Promise<void>): () => void;
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

/** Exactly what a plugin speaking version 1 is given. */
export interface PodServicesV1 {
  profile: Pick<PodServices['profile'], 'get' | 'addFacts' | 'removeFacts' | 'editTopics'>;
  suggestions: PodServices['suggestions'];
  reading: Pick<PodServices['reading'], 'status' | 'set'>;
  model: PodServices['model'];
  news: PodServices['news'];
}

/** What a plugin is given, by the version it named: `ctx.podApi` tells a plugin which it has. */
export type PluginContext =
  | (PluginContextBase & { podApi: 1; services: PodServicesV1 })
  | (PluginContextBase & {
      podApi: 2;
      services: PodServices;
      /** The https origin of the Mera News app notifier (pod.json `notify.meraNewsApp`), or null when off. */
      meraNewsApp: string | null;
    });

interface PluginContextBase {
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
