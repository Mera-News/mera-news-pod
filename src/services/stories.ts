// Every story that matches the person's topics, a page at a time, each with its verdict: picked or
// left out, with the reason, by the person's assistant or by the pod's own AI service. A verdict is
// kept in verdicts.json, so a story is judged once. A pick the assistant makes is written as one of
// the pod's own suggestions, so it reaches suggestions.get, the notifiers and a paired phone like any
// other pick; a story left out is never a pick, whoever scores it later (see readFeed). A story the
// pod's own AI service scored and did not pick counts as left out by the pod.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { JudgeResult, PickLevel, PodServices, ProfileStory, StoriesPage, StoryVerdict, Verdict } from '../plugin-api';
import { client } from './client';
import { PodError } from './ledger';
import { readFeed } from './picks';

/** The news server searches the news of the last 48 hours for each topic. */
const WINDOW_HOURS = 48;
const PER_TOPIC = 20;
/** Topics per request: the server's limit. */
const TOPICS_PER_REQUEST = 200;
/** Pages asked for per topic in one run. A run that stops here says it is not complete. */
const MAX_ROUNDS = 25;
const HYDRATE_CHUNK = 50;
const PAGE_DEFAULT = 20;
const PAGE_MAX = 50;
/** A run started this recently, for the same topics, is used again instead of asking the server. */
const REUSE_MS = 60_000;
/** Runs kept per scope: the whole profile, and each fact. */
const RUNS_KEPT = 5;
const RUN_KEPT_MS = 30 * 60_000;
/** Unjudged stories a run returned are left out of later runs for this long. */
const SHOWN_MS = 72 * 3600_000;
/** A verdict is kept this long: far past the window, so a story is never judged twice. */
const VERDICT_MS = 7 * 24 * 3600_000;
const LEVELS: readonly PickLevel[] = ['emergency', 'high', 'medium', 'low'];

const PERSONA = 'query GetArticleIdsForPersona($query: PersonaQueryInput!) { articleIdsForPersona(query: $query) { topicResults { topicText articleIds matchMeta { articleId stableClusterId } hasNextPage nextCursor } } }';
const BY_IDS = 'query GetArticlesForTopicsByIds($articleIds: [ID!]!) { articlesForTopicsByIds(articleIds: $articleIds) { articles { _id title title_en article_url image_url pubDate language_code publication_name } } }';

interface Story {
  key: string;
  ids: string[];
  topics: Set<string>;
  factIds: Set<string>;
}
interface Run {
  id: string;
  /** The fact this run covers, or undefined for every fact. */
  fact?: string;
  at: number;
  signature: string;
  stories: Story[];
  byArticle: Map<string, Story>;
  articles: number;
  topics: { text: string; matches: number }[];
  facts: { id: string; statement: string }[];
  complete: boolean;
  /** Every article of the run, read once, so the publishers and languages cover the whole run. */
  articlesById?: Map<string, ArticleIn>;
  publishers: number;
  languages: number;
  /** Stories this run returned unjudged: an earlier page, not an earlier run. */
  marked: Set<string>;
}
/** One topic's matches, as the server answered them. */
interface TopicMatches {
  ids: string[];
  storyOf: Map<string, string>;
  complete: boolean;
}
/** A shared answer, so runs for different facts never ask twice for a topic or an article. */
interface Cached<T> {
  at: number;
  p: Promise<T>;
}
interface Stored {
  verdict: Verdict;
  reason: string;
  level?: PickLevel;
  at: string;
  ids: string[];
}
interface File {
  stories: Record<string, Stored>;
  shown: Record<string, number>;
}
interface ArticleIn {
  _id: string;
  title?: string | null;
  title_en?: string | null;
  article_url?: string | null;
  image_url?: string | null;
  pubDate?: string | null;
  language_code?: string | null;
  publication_name?: string | null;
}

const bad = (message: string) => new PodError('bad_input', message, 'correct it and call again; nothing was saved');

function load(file: string): File {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<File>;
    return { stories: raw.stories && typeof raw.stories === 'object' ? raw.stories : {}, shown: raw.shown && typeof raw.shown === 'object' ? raw.shown : {} };
  } catch {
    // A missing or unreadable file starts empty: the worst case is a story judged a second time.
    return { stories: {}, shown: {} };
  }
}

function save(file: string, value: File) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, file);
}

/** Why the pod's own reading did not pick a story, by the row's status. */
const POD_LEFT_OUT: Record<string, string> = {
  complete: 'Mera News judged it not close enough to your facts.',
  excluded: 'Left out by your settings, such as a muted publisher.',
  already_read: 'You have already read it.',
};

export function createStories(deps: { news: PodServices['news']; profile: Pick<PodServices['profile'], 'get'>; file: string; onChange(): void }): { stories: PodServices['stories']; leftOut(): Set<string> } {
  let data = load(deps.file);
  let chain: Promise<unknown> = Promise.resolve();
  const serially = <T>(fn: () => T | Promise<T>): Promise<T> => {
    const run = chain.then(fn);
    chain = run.catch(() => {});
    return run;
  };
  const runs = new Map<string, Run>();

  const prune = () => {
    const now = Date.now();
    for (const [k, v] of Object.entries(data.stories)) if (!(now - Date.parse(v.at) < VERDICT_MS)) delete data.stories[k];
    for (const [k, at] of Object.entries(data.shown)) if (!(now - at < SHOWN_MS)) delete data.shown[k];
  };
  const write = () => {
    prune();
    save(deps.file, data);
  };

  async function ask<T>(operationName: string, query: string, variables: object): Promise<T> {
    let reply: { data?: T; errors?: { extensions?: { code?: string } }[] };
    try {
      reply = (await deps.news.graphql({ operationName, query, variables })) as typeof reply;
    } catch {
      reply = { errors: [{}] };
    }
    if (!reply.errors?.length && reply.data) return reply.data;
    // The server's own text never leaves: it can echo what was asked.
    if (reply.errors?.[0]?.extensions?.code === 'UNAUTHENTICATED') {
      throw new PodError('key_refused', 'The Mera News key was refused.', 'set the key from Mera Labs in the pod settings, then restart it');
    }
    throw new PodError('news_unavailable', 'The news server could not answer.', 'try again in a minute; if it keeps failing, the pod status names what to fix');
  }

  /** Every topic of every fact, each text once, one topic per fact in turn so the newest facts come as early as the oldest. */
  async function profileTopics() {
    const facts: { id: string; statement: string; topics: string[] }[] = [];
    for (let offset: number | undefined = 0; offset !== undefined; ) {
      const page = await deps.profile.get(offset ? { offset } : undefined);
      facts.push(...page.facts.map((f) => ({ id: f.id, statement: f.statement, topics: f.topics.map((t) => t.text.trim()).filter(Boolean) })));
      offset = page.nextOffset;
    }
    const topics = new Map<string, { text: string; factIds: Set<string> }>();
    for (let i = 0, more = true; more; i++) {
      more = false;
      for (const f of facts) {
        const text = f.topics[i];
        if (!text) continue;
        more = true;
        const key = text.toLowerCase();
        if (!topics.has(key)) topics.set(key, { text, factIds: new Set() });
        topics.get(key)!.factIds.add(f.id);
      }
    }
    // A topic two facts share counts for both.
    for (const f of facts) for (const t of f.topics) topics.get(t.toLowerCase())?.factIds.add(f.id);
    return { facts, topics: [...topics.values()] };
  }

  // Shared by every run: a topic asked for or an article read in the last minute is not asked for
  // again, whichever fact's run asked first. A run keeps its own articles (articlesById).
  const topicCache = new Map<string, Cached<TopicMatches>>();
  const articleCache = new Map<string, Cached<ArticleIn | undefined>>();
  /** Keeps a cached answer until it fails or is empty, so a failed request or a miss is asked again next time. */
  function cache<T>(map: Map<string, Cached<T>>, key: string, at: number, p: Promise<T>) {
    const entry = { at, p };
    map.set(key, entry);
    const drop = () => {
      if (map.get(key) === entry) map.delete(key);
    };
    p.then((v) => v === undefined && drop(), drop);
  }

  async function fetchTopics(texts: string[]): Promise<Map<string, TopicMatches>> {
    type Result = { topicText: string; articleIds: string[]; matchMeta?: { articleId: string; stableClusterId?: string | null }[] | null; hasNextPage?: boolean; nextCursor?: string | null };
    const out = new Map<string, TopicMatches>(texts.map((t) => [t.toLowerCase(), { ids: [], storyOf: new Map(), complete: true }]));
    let asking = texts.map((text) => ({ text }) as { text: string; afterCursor?: string });
    for (let round = 0; asking.length > 0; round++) {
      if (round === MAX_ROUNDS) {
        for (const a of asking) out.get(a.text.toLowerCase())!.complete = false;
        break;
      }
      const next: typeof asking = [];
      for (let i = 0; i < asking.length; i += TOPICS_PER_REQUEST) {
        const batch = asking.slice(i, i + TOPICS_PER_REQUEST);
        const got = await ask<{ articleIdsForPersona: { topicResults: Result[] } }>('GetArticleIdsForPersona', PERSONA, { query: { limitPerTopic: PER_TOPIC, topics: batch } });
        for (const r of got.articleIdsForPersona.topicResults ?? []) {
          const topic = out.get(String(r.topicText).toLowerCase());
          if (!topic) continue;
          for (const id of r.articleIds ?? []) if (typeof id === 'string' && !topic.ids.includes(id)) topic.ids.push(id);
          for (const m of r.matchMeta ?? []) if (m?.stableClusterId) topic.storyOf.set(m.articleId, String(m.stableClusterId));
          if (r.hasNextPage && r.nextCursor) next.push({ text: r.topicText, afterCursor: r.nextCursor });
        }
      }
      asking = next;
    }
    return out;
  }

  function topicMatches(texts: string[]): Promise<TopicMatches[]> {
    const now = Date.now();
    for (const [k, c] of topicCache) if (now - c.at >= REUSE_MS) topicCache.delete(k);
    const missing = texts.filter((t) => !topicCache.has(t.toLowerCase()));
    if (missing.length) {
      const asked = fetchTopics(missing);
      for (const t of missing) cache(topicCache, t.toLowerCase(), now, asked.then((m) => m.get(t.toLowerCase())!));
    }
    return Promise.all(texts.map((t) => topicCache.get(t.toLowerCase())!.p));
  }

  async function startRun(fact?: string): Promise<Run> {
    const all = await profileTopics();
    const facts = fact === undefined ? all.facts : all.facts.filter((f) => f.id === fact);
    if (!facts.length && fact !== undefined) throw bad('There is no saved fact with that id.');
    const topics = fact === undefined ? all.topics : all.topics.filter((t) => t.factIds.has(fact));
    const signature = JSON.stringify([fact ?? null, facts.map((f) => f.id), topics.map((t) => t.text)]);
    const last = [...runs.values()].reverse().find((r) => r.signature === signature);
    if (last && Date.now() - last.at < REUSE_MS) {
      // A new caller of the same run: what earlier pages returned now counts as shown before.
      last.marked.clear();
      return last;
    }

    const matches = await topicMatches(topics.map((t) => t.text));
    const storyOf = new Map(matches.flatMap((m) => [...m.storyOf]));
    // Stories in turn: each topic's best match before any topic's second.
    const byKey = new Map<string, Story>();
    const byArticle = new Map<string, Story>();
    const lists = topics.map((t, n) => ({ t, ids: matches[n].ids }));
    for (let rank = 0; lists.some((l) => rank < l.ids.length); rank++) {
      for (const { t, ids: list } of lists) {
        const id = list[rank];
        if (!id) continue;
        const key = storyOf.has(id) ? `s:${storyOf.get(id)}` : `a:${id}`;
        let story = byKey.get(key);
        if (!story) byKey.set(key, (story = { key, ids: [], topics: new Set(), factIds: new Set() }));
        if (!story.ids.includes(id)) story.ids.push(id);
        story.topics.add(t.text);
        for (const f of t.factIds) story.factIds.add(f);
        byArticle.set(id, story);
      }
    }
    const run: Run = {
      id: randomBytes(4).toString('hex'),
      ...(fact === undefined ? {} : { fact }),
      at: Date.now(),
      signature,
      stories: [...byKey.values()],
      byArticle,
      articles: byArticle.size,
      topics: lists.map(({ t, ids: list }) => ({ text: t.text, matches: list.length })),
      // A topic two facts share still counts only for the facts of this run.
      facts: facts.map((f) => ({ id: f.id, statement: f.statement })),
      complete: matches.every((m) => m.complete),
      publishers: 0,
      languages: 0,
      marked: new Set(),
    };
    runs.set(run.id, run);
    held = undefined;
    // Oldest first: a scope keeps its newest runs, so one lane paging never expires another's cursor.
    for (const [id, r] of runs) {
      if (Date.now() - r.at > RUN_KEPT_MS || [...runs.values()].filter((x) => x.fact === r.fact).length > RUNS_KEPT) runs.delete(id);
    }
    return run;
  }

  /** Article ids by story key across every run kept, built again after runs change. */
  let held: Map<string, Set<string>> | undefined;
  /** Every report of a story the pod holds: a fact's run holds only the reports that fact's topics matched. */
  const idsOf = (key: string, ids: string[]) => {
    if (!held) {
      held = new Map();
      for (const r of runs.values()) {
        for (const st of r.stories) held.set(st.key, new Set([...(held.get(st.key) ?? []), ...st.ids]));
      }
    }
    return [...new Set([...ids, ...(held.get(key) ?? [])])];
  };

  /** Every article id of a story the assistant left out. */
  const leftOut = () => new Set(Object.entries(data.stories).flatMap(([k, v]) => (v.verdict === 'left_out' ? idsOf(k, v.ids) : [])));

  /** The pod's own verdicts by article id: its picks (its AI service's, and the assistant's saved before), and what its scoring finished without picking. */
  let picksP: Promise<Map<string, StoryVerdict>> | undefined;
  // Lanes loading together share one read of the feed.
  const podPicks = () => (picksP ??= podPicksOnce().finally(() => (picksP = undefined)));
  async function podPicksOnce(): Promise<Map<string, StoryVerdict>> {
    const { candidates, rows } = await readFeed(leftOut());
    const out = new Map<string, StoryVerdict>();
    for (const c of candidates) for (const id of c.memberIds) out.set(id, { verdict: 'picked', reason: c.pick.reason, level: c.pick.level, by: 'pod' });
    for (const r of rows) if (!out.has(r.articleId) && POD_LEFT_OUT[r.status]) out.set(r.articleId, { verdict: 'left_out', reason: POD_LEFT_OUT[r.status], by: 'pod' });
    return out;
  }

  const storedOf = (story: Pick<Story, 'key' | 'ids'>): [string, Stored] | undefined => {
    if (data.stories[story.key]) return [story.key, data.stories[story.key]];
    for (const [k, v] of Object.entries(data.stories)) if (v.ids.some((id) => story.ids.includes(id))) return [k, v];
    return undefined;
  };
  const verdictOf = (story: Story, picks: Map<string, StoryVerdict>): StoryVerdict | undefined => {
    const stored = storedOf(story)?.[1];
    if (stored) return { verdict: stored.verdict, reason: stored.reason, ...(stored.level ? { level: stored.level } : {}), by: 'assistant', at: stored.at };
    for (const id of idsOf(story.key, story.ids)) if (picks.has(id)) return picks.get(id);
    return undefined;
  };

  function summarise(run: Run, picks: Map<string, StoryVerdict>) {
    const facts = new Map(run.facts.map((f) => [f.id, { ...f, matched: 0, picked: 0, leftOut: 0 }]));
    let picked = 0;
    let leftOut = 0;
    for (const s of run.stories) {
      const v = verdictOf(s, picks)?.verdict;
      if (v === 'picked') picked++;
      if (v === 'left_out') leftOut++;
      for (const id of s.factIds) {
        const f = facts.get(id);
        if (!f) continue;
        f.matched++;
        if (v === 'picked') f.picked++;
        if (v === 'left_out') f.leftOut++;
      }
    }
    return {
      windowHours: WINDOW_HOURS,
      articles: run.articles,
      stories: run.stories.length,
      merged: run.articles - run.stories.length,
      topics: run.topics,
      facts: [...facts.values()],
      picked,
      leftOut,
      unjudged: run.stories.length - picked - leftOut,
      publishers: run.publishers,
      languages: run.languages,
      complete: run.complete,
    };
  }

  async function hydrate(ids: string[]): Promise<Map<string, ArticleIn>> {
    const now = Date.now();
    for (const [k, c] of articleCache) if (now - c.at >= REUSE_MS) articleCache.delete(k);
    // Held here, so an entry another call drops while this one waits is still answered.
    const want = new Map(ids.map((id) => [id, articleCache.get(id)?.p]));
    const missing = ids.filter((id) => !want.get(id));
    for (let i = 0; i < missing.length; i += HYDRATE_CHUNK) {
      const chunk = missing.slice(i, i + HYDRATE_CHUNK);
      const asked = ask<{ articlesForTopicsByIds: { articles: ArticleIn[] } }>('GetArticlesForTopicsByIds', BY_IDS, { articleIds: chunk }).then((got) => new Map((got.articlesForTopicsByIds.articles ?? []).map((a) => [a._id, a])));
      for (const id of chunk) {
        const p = asked.then((m) => m.get(id));
        cache(articleCache, id, now, p);
        want.set(id, p);
      }
      // One request at a time; a failed one fails the call at once.
      await asked;
    }
    const got = await Promise.all(want.values());
    const keys = [...want.keys()];
    return new Map(keys.flatMap((id, n) => (got[n] ? [[id, got[n]] as const] : [])));
  }

  /** Reads every article of the run once, and counts its publishers and languages. */
  async function hydrateRun(run: Run): Promise<Map<string, ArticleIn>> {
    if (run.articlesById) return run.articlesById;
    const all = await hydrate([...run.byArticle.keys()]);
    run.publishers = new Set([...all.values()].flatMap((a) => (a.publication_name ? [text(a.publication_name, 200)] : []))).size;
    run.languages = new Set([...all.values()].map((a) => text(a.language_code, 12) || 'und')).size;
    run.articlesById = all;
    return all;
  }

  // Only the named fields leave, never a description or any other article text. Text from a feed is capped.
  const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
  function storyOut(run: Run, s: Story, a: ArticleIn, verdict: StoryVerdict | undefined): ProfileStory | null {
    const link = typeof a.article_url === 'string' && /^https?:\/\//.test(a.article_url) ? a.article_url.slice(0, 2000) : '';
    if (!link) return null;
    const title = text(a.title || a.title_en, 500);
    const titleEn = text(a.title_en, 500);
    const image = typeof a.image_url === 'string' && /^https:\/\//.test(a.image_url) ? a.image_url.slice(0, 2000) : '';
    const facts = run.facts.filter((f) => s.factIds.has(f.id)).map((f) => ({ id: f.id, statement: f.statement.slice(0, 300) }));
    return {
      id: a._id,
      story: s.key,
      title,
      ...(titleEn && titleEn !== title ? { titleEn } : {}),
      link,
      publisher: text(a.publication_name, 200),
      publishedAt: text(a.pubDate, 40),
      language: text(a.language_code, 12) || 'und',
      ...(image ? { image } : {}),
      reports: s.ids.length,
      facts,
      topics: [...s.topics].map((t) => t.slice(0, 80)),
      ...(verdict ? { verdict: { ...verdict, reason: verdict.reason.slice(0, 1000) } } : {}),
    };
  }

  const stories: PodServices['stories'] = {
    async forProfile(options = {}) {
      const limit = options.limit ?? PAGE_DEFAULT;
      if (!Number.isInteger(limit) || limit < 0 || limit > PAGE_MAX) throw bad(`limit must be a whole number from 0 to ${PAGE_MAX}.`);
      const { fact } = options;
      if (fact !== undefined && (typeof fact !== 'string' || !fact)) throw bad('fact must be the id of a saved fact.');
      let run: Run;
      let start = 0;
      if (options.after !== undefined) {
        const m = /^([0-9a-f]{8})\.(\d{1,6})$/.exec(String(options.after));
        const found = m && runs.get(m[1]);
        if (!found) throw new PodError('run_expired', 'That page of stories has expired.', 'call again without after to start from the first page');
        if (found.fact !== fact) throw bad('That cursor belongs to a run for another fact: pass the same fact as the call that gave it.');
        run = found;
        start = Number(m[2]);
      } else {
        run = await startRun(fact);
      }
      const picks = await podPicks();
      await hydrateRun(run);
      if (limit === 0) return { run: run.id, summary: summarise(run, picks), stories: [], shownBefore: 0 };

      return serially(async () => {
        prune();
        const now = Date.now();
        // Without peek, unjudged stories an earlier run returned wait out their 72 hours.
        const skip = (s: Story) => !options.peek && !verdictOf(s, picks) && data.shown[s.key] !== undefined;
        // Stories an earlier page of this run returned are skipped too, but were not held back.
        const shownBefore = options.peek ? 0 : run.stories.filter((s) => skip(s) && !run.marked.has(s.key)).length;
        const chosen: { at: number; s: Story }[] = [];
        let i = start;
        for (; i < run.stories.length && chosen.length < limit; i++) if (!skip(run.stories[i])) chosen.push({ at: i, s: run.stories[i] });
        const articles = await hydrateRun(run);
        let page = chosen.flatMap((c) => {
          const a = articles.get(c.s.ids[0]);
          const out = a && storyOut(run, c.s, a, verdictOf(c.s, picks));
          return out ? [{ ...c, out }] : [];
        });
        const summary = summarise(run, picks);
        if (options.fits) while (page.length > 1 && !options.fits(page.map((p) => p.out), summary)) page = page.slice(0, -1);
        // The page ends after its last story kept, so a page cut to fit loses none.
        const end = page.length < chosen.length && page.length > 0 ? page[page.length - 1].at + 1 : i;
        let more = false;
        for (let j = end; j < run.stories.length && !more; j++) more = !skip(run.stories[j]);
        if (!options.peek) {
          const fresh = page.filter((p) => !p.out.verdict);
          for (const p of fresh) {
            data.shown[p.s.key] = now;
            run.marked.add(p.s.key);
          }
          if (fresh.length) write();
        }
        return { run: run.id, summary, stories: page.map((p) => p.out), ...(more ? { nextCursor: `${run.id}.${end}` } : {}), shownBefore };
      });
    },

    async judge(items) {
      if (!Array.isArray(items) || items.length < 1 || items.length > 50) throw bad('Pass 1 to 50 verdicts.');
      const clean = items.map((v, n) => {
        const id = typeof v?.id === 'string' ? v.id : '';
        if (!/^[\w.:-]{1,100}$/.test(id)) throw bad(`Verdict ${n + 1} has no valid id.`);
        if (v.verdict !== 'picked' && v.verdict !== 'left_out') throw bad(`Verdict ${n + 1} must be picked or left_out.`);
        const reason = typeof v.reason === 'string' ? v.reason.trim().replace(/\s+/g, ' ') : '';
        if (reason.length < 1 || reason.length > 300 || /[\p{Cc}\p{Cf}]/u.test(reason)) throw bad(`Verdict ${n + 1} needs a reason of 1 to 300 characters.`);
        if (v.level !== undefined && !LEVELS.includes(v.level)) throw bad(`Verdict ${n + 1} has a level that is not emergency, high, medium or low.`);
        if (v.verdict === 'picked' && !v.level) throw bad(`Verdict ${n + 1} is a pick, so it needs a level.`);
        return { id, verdict: v.verdict, reason, ...(v.level ? { level: v.level } : {}) } as { id: string; verdict: Verdict; reason: string; level?: PickLevel };
      });

      const picks = await podPicks();
      return serially(async () => {
        const result: JudgeResult = { saved: [], already: [], refused: [] };
        const at = new Date().toISOString();
        const seen = new Map<string, Verdict>();
        const toPick: { item: (typeof clean)[number]; story: Story }[] = [];
        let changed = false;
        for (const item of clean) {
          // The newest run that holds this article names its whole story.
          const known = [...runs.values()].reverse().find((r) => r.byArticle.has(item.id))?.byArticle.get(item.id);
          // Its reports from every run, so a verdict through one fact's lane covers the others' too.
          const story: Story = known ? { ...known, ids: idsOf(known.key, known.ids) } : { key: `a:${item.id}`, ids: [item.id], topics: new Set(), factIds: new Set() };
          const before = verdictOf(story, picks)?.verdict ?? seen.get(story.key);
          if (before) {
            result.already.push({ id: item.id, verdict: before });
            continue;
          }
          seen.set(story.key, item.verdict);
          if (item.verdict === 'left_out') {
            data.stories[story.key] = { verdict: 'left_out', reason: item.reason, ...(item.level ? { level: item.level } : {}), at, ids: [...story.ids] };
            result.saved.push({ id: item.id, verdict: 'left_out' });
            changed = true;
          } else toPick.push({ item, story });
        }

        if (toPick.length) {
          const { ArticleService } = client<{ ArticleService: { getArticlesForTopicsByIds(ids: string[]): Promise<{ articles: { _id: string }[] }> } }>('article-service');
          const { persistAndLinkV2Suggestions } = client<{ persistAndLinkV2Suggestions(a: unknown[], topics: Map<string, string[]>): Promise<unknown> }>('database/services/article-suggestion-persist');
          const { saveScoringResult } = client<{ saveScoringResult(id: string, p: { relevance: number; reason: string; reasonSkipped: boolean }): Promise<void> }>('database/services/article-suggestion-scoring-writes');
          const { DEFAULT_HARNESS_CONFIG } = client<{ DEFAULT_HARNESS_CONFIG: { articlePipeline: Record<string, number> } }>('news-harness/core/config');
          const { default: database } = client<{ default: { get(t: string): { find(id: string): Promise<{ status: string; reason: string | null }> } } }>('database/index');
          // The value the client stores for each level, so the pick lands in that level's band.
          const score = (level: PickLevel) => DEFAULT_HARNESS_CONFIG.articlePipeline[`${level}PriorityScore`];

          let found: { _id: string }[];
          try {
            found = (await ArticleService.getArticlesForTopicsByIds(toPick.map((p) => p.item.id))).articles;
          } catch {
            throw new PodError('news_unavailable', 'The news server could not answer, so no pick was saved.', 'try again in a minute');
          }
          const byId = new Map(found.map((a) => [a._id, a]));
          // Topic texts link each new row to the facts they came from.
          await persistAndLinkV2Suggestions(
            toPick.flatMap((p) => byId.get(p.item.id) ?? []),
            new Map(toPick.map((p) => [p.item.id, [...p.story.topics]])),
          );
          for (const { item, story } of toPick) {
            if (!byId.has(item.id)) {
              result.refused.push({ id: item.id, code: 'unknown_story', message: 'Mera News has no article with this id now, so nothing was saved.' });
              continue;
            }
            // The client never rescores a row the person muted or already read, so such a pick cannot be saved.
            const was = (await database.get('article_suggestions').find(item.id)).status;
            if (was === 'excluded' || was === 'already_read') {
              result.refused.push({ id: item.id, code: 'not_available', message: 'The person muted this publisher or already read this story, so it cannot be picked. Do not try again.' });
              continue;
            }
            await saveScoringResult(item.id, { relevance: score(item.level!), reason: item.reason, reasonSkipped: false });
            const row = await database.get('article_suggestions').find(item.id);
            // The client keeps a reason only when it shares a word with the article; without one the row is no pick.
            if (row.status !== 'complete' || !row.reason) {
              result.refused.push({ id: item.id, code: 'reason_not_grounded', message: 'The reason shares no word with the headline, so the pick was not saved. Write it again naming something the headline says.' });
              continue;
            }
            data.stories[story.key] = { verdict: 'picked', reason: item.reason, level: item.level, at, ids: [...story.ids] };
            result.saved.push({ id: item.id, verdict: 'picked' });
            changed = true;
          }
        }
        if (changed) {
          write();
          deps.onChange();
        }
        // In the order asked.
        const order = (list: { id: string }[]) => list.sort((x, y) => clean.findIndex((c) => c.id === x.id) - clean.findIndex((c) => c.id === y.id));
        order(result.saved);
        order(result.refused);
        return result;
      });
    },
  };
  return { stories, leftOut };
}
