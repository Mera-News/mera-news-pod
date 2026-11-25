// The stories the person follows, read and changed the way the Mera News app does: the client's
// tracked_stories rows and its own follow, unfollow and remove writers, so a paired phone sees the
// same. The timeline fold (copies of one event shown once) is the app's display rule, lifted here.
import type { FollowedArticle, FollowedStoryView, PodServices } from '../plugin-api';
import { client } from './client';
import { PodError } from './ledger';
import { MAX_TOPIC } from './profile';

const PAGE_DEFAULT = 20;
const PAGE_MAX = 50;
/** A suggestion row's link is used only while the row is this young: the server drops an article at 48 hours. */
const LINK_MS = 48 * 3600_000;
/** Bare cards filled from local rows per read, as the app does. */
const MAX_SOURCE_HYDRATE = 30;

interface Snapshot {
  articleId: string;
  title: string;
  titleOriginal?: string;
  pubDateMs: number;
  imageUrl?: string;
  publicationName?: string;
  languageCode?: string;
  countryCode?: string;
  storyKey?: string;
}
interface Row {
  id: string;
  llmHeadline: string | null;
  topicText: string | null;
  fallbackTitle: string;
  unseenCount: number;
  lastUpdateAt: Date | null;
  createdAt: Date;
  status: 'active' | 'ended';
  memberArticleIds: string[];
  memberSnapshots: Snapshot[];
}
interface Suggestion {
  title_en: string | null;
  title_original: string | null;
  article_url: string | null;
  image_url: string | null;
  publication_name: string | null;
  language_code: string | null;
  country_code: string | null;
  storyKey?: string | null;
  createdAt: string;
  firstPubDate: string;
  clusters?: { stableClusterId?: string | null }[];
}
type Entry = { head: Snapshot; copies: Snapshot[] };

const tracked = () =>
  client<{
    getTrackedStoryById(id: string): Promise<Row | null>;
    sortTrackedStories(rows: Row[]): Row[];
    markSeen(id: string): Promise<void>;
    advanceSeenWatermark(id: string, ms: number): Promise<void>;
    backfillSnapshotSource(id: string, patches: Map<string, Partial<Snapshot>>): Promise<void>;
    findActiveTrackedId(q: { stableClusterId?: string | null; articleId?: string | null; searchText?: string | null }): Promise<string | null>;
  }>('database/services/tracked-story-service');
const actions = () =>
  client<{
    trackStoryWithProposal(subject: object, scope: { label: string; searchText: string }): Promise<'followed' | 'already' | 'skipped'>;
    deleteTrackedStoryById(id: string): Promise<boolean>;
    disownStoryMember(id: string, articleId: string): Promise<boolean>;
  }>('tracking/track-actions');
const localRow = (id: string) => client<{ getSuggestionByArticleId(id: string): Promise<Suggestion | null> }>('database/services/article-suggestion-reads').getSuggestionByArticleId(id);
const database = () => client<{ default: { get(t: string): { query(): { fetch(): Promise<Row[]> }; find(id: string): Promise<{ articleUrl: string | null; imageUrl: string | null }> } } }>('database/index').default;

const bad = (message: string) => new PodError('bad_input', message, 'correct it and call again; nothing was changed');
const unknown = () => new PodError('unknown_story', 'The person follows no story with that id.', 'call followed.list for the stories followed now');
const failed = () => new PodError('write_failed', 'The change could not be saved.', 'try again; if it keeps failing, restart the pod');
const iso = (d: Date | null | undefined) => (d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : new Date(0).toISOString());
const https = (u: unknown) => (typeof u === 'string' && /^https:\/\//.test(u) ? u.slice(0, 2000) : null);
const ID = /^[\w.:-]{1,100}$/;
/** The profile's topic rule: no control or format character, except the joiners Persian and Indic scripts need. */
const plain = (t: string) => t.length >= 1 && t.length <= MAX_TOPIC && !/(?![\u200c\u200d])[\p{Cc}\p{Cf}]/u.test(t);

function article(s: Snapshot, url: string | null, image?: string | null): FollowedArticle {
  const title = (s.titleOriginal || s.title).slice(0, 500);
  return {
    id: s.articleId,
    title,
    ...(s.title && s.title !== title ? { titleEn: s.title.slice(0, 500) } : {}),
    // A snapshot's `title` is English: without the original, English is never labelled with another language.
    lang: s.titleOriginal ? s.languageCode || 'und' : 'en',
    publisher: s.publicationName ?? '',
    ...(s.countryCode ? { country: s.countryCode } : {}),
    url,
    image: https(image ?? s.imageUrl),
    publishedAt: s.pubDateMs > 0 ? new Date(s.pubDateMs).toISOString() : null,
  };
}

async function view(r: Row): Promise<FollowedStoryView> {
  // The newest snapshot among the current members, as the app's Stories row shows it.
  const ids = new Set(r.memberArticleIds ?? []);
  const latest = (r.memberSnapshots ?? []).filter((s) => ids.has(s.articleId)).reduce<Snapshot | null>((best, s) => (!best || s.pubDateMs > best.pubDateMs ? s : best), null);
  return {
    id: r.id,
    title: (r.llmHeadline ?? r.topicText ?? r.fallbackTitle ?? '').slice(0, 300),
    titleIsAi: !!(r.llmHeadline ?? r.topicText),
    newCount: r.unseenCount ?? 0,
    articles: (r.memberSnapshots ?? []).length,
    latest: latest ? await linkOf(latest.articleId).then((link) => article(latest, link.url, link.image)) : null,
    updatedAt: iso(r.lastUpdateAt ?? r.createdAt),
    followedAt: iso(r.createdAt),
    status: r.status === 'ended' ? 'ended' : 'active',
  };
}

/** Fills the source fields a bare card lacks from the local row, and keeps them on the story, as the app's timeline does. */
async function hydrateSource(id: string, cards: Snapshot[]): Promise<Snapshot[]> {
  const bare = cards.filter((c) => !c.languageCode || !c.countryCode || !c.storyKey || !c.titleOriginal).slice(0, MAX_SOURCE_HYDRATE);
  const rows = await Promise.all(bare.map((c) => localRow(c.articleId)));
  const patches = new Map<string, Partial<Snapshot>>();
  rows.forEach((r, i) => {
    if (!r) return;
    const patch = { languageCode: r.language_code ?? undefined, countryCode: r.country_code ?? undefined, storyKey: r.storyKey ?? undefined, titleOriginal: r.title_original ?? undefined };
    if (Object.values(patch).some(Boolean)) patches.set(bare[i].articleId, patch);
  });
  if (!patches.size) return cards;
  await tracked().backfillSnapshotSource(id, patches);
  return cards.map((c) => {
    const p = patches.get(c.articleId);
    return p ? { ...c, languageCode: c.languageCode ?? p.languageCode, countryCode: c.countryCode ?? p.countryCode, storyKey: c.storyKey ?? p.storyKey, titleOriginal: c.titleOriginal ?? p.titleOriginal } : c;
  });
}

/**
 * The app's timeline fold: cards sharing a fold key are one story, except that a title key never
 * joins two groups the server gave different story keys. The head is the copy the app's
 * representative rule picks for this person; entries come newest head first.
 */
async function fold(cards: Snapshot[]): Promise<Entry[]> {
  const { foldKeysOf } = client<{ foldKeysOf(s: Snapshot): string[] }>('tracking/story-fold-key');
  const { makeRepCompare } = client<{ makeRepCompare(ctx: unknown): (a: unknown, b: unknown) => number }>('algorithms/representative-compare');
  const { loadUserGeoLanguageContext } = client<{ loadUserGeoLanguageContext(): Promise<unknown> }>('user-context/user-geo-language-context');
  const parent = cards.map((_, i) => i);
  const skOf = new Map<number, string>();
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a: number, b: number) => {
    const [ra, rb] = [find(a), find(b)];
    const [ka, kb] = [skOf.get(ra), skOf.get(rb)];
    if (ra === rb || (ka && kb && ka !== kb)) return;
    parent[rb] = ra;
    if (kb && !ka) skOf.set(ra, kb);
  };
  cards.forEach((c, i) => c.storyKey && skOf.set(i, c.storyKey));
  const holder = new Map<string, number>();
  cards.forEach((c, i) => {
    for (const key of foldKeysOf(c)) {
      const h = holder.get(key);
      if (h === undefined) holder.set(key, i);
      else union(h, i);
    }
  });
  const groups = new Map<number, Snapshot[]>();
  cards.forEach((c, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), c]));
  const compare = makeRepCompare(await loadUserGeoLanguageContext());
  const asItem = (c: Snapshot) => ({ s: { _id: c.articleId, firstPubDate: c.pubDateMs ? new Date(c.pubDateMs).toISOString() : null, rawScore: null, publication_name: c.publicationName ?? null, country_code: c.countryCode ?? null, language_code: c.languageCode ?? null, image_url: c.imageUrl ?? null } });
  return [...groups.values()]
    .map((members) => {
      const sorted = [...members].sort((a, b) => compare(asItem(a), asItem(b)));
      return { head: sorted[0], copies: sorted.slice(1) };
    })
    .sort((a, b) => b.head.pubDateMs - a.head.pubDateMs || (a.head.articleId < b.head.articleId ? -1 : 1));
}

/** A story's timeline, deduped by article (the newest snapshot wins), filled and folded. */
async function entriesOf(row: Row): Promise<{ cards: Snapshot[]; entries: Entry[] }> {
  const cards = [...new Map((row.memberSnapshots ?? []).filter((s) => s.articleId).map((s) => [s.articleId, s])).values()].sort((a, b) => b.pubDateMs - a.pubDateMs);
  return { cards, entries: await fold(await hydrateSource(row.id, cards)) };
}

/** The kept link: a kept row (a save, or held for the story or a fact check), else the suggestion row while the server still holds the article. */
async function linkOf(articleId: string): Promise<{ url: string | null; image?: string | null }> {
  const kept = await database().get('saved_article_suggestions').find(articleId).catch(() => null);
  if (kept?.articleUrl) return { url: kept.articleUrl, image: kept.imageUrl };
  const row = await localRow(articleId);
  if (row?.article_url && Date.now() - Date.parse(row.createdAt) < LINK_MS) return { url: row.article_url, image: row.image_url };
  return { url: null };
}

async function story(id: unknown): Promise<Row> {
  if (typeof id !== 'string' || !ID.test(id)) throw bad('id must be the id of a followed story.');
  const row = await tracked().getTrackedStoryById(id);
  if (!row) throw unknown();
  return row;
}

export function createFollowed(deps: { hasAi(): boolean }): PodServices['followed'] {
  // Follows run one at a time: the client checks for the same story, then writes, with awaits between.
  let chain: Promise<unknown> = Promise.resolve();
  const serially = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn);
    chain = run.catch(() => {});
    return run;
  };
  return {
    async list() {
      const rows = (await database().get('tracked_stories').query().fetch()).filter((r) => r.status === 'active');
      return { stories: await Promise.all(tracked().sortTrackedStories(rows).map(view)) };
    },

    async get(id, options = {}) {
      const limit = options.limit ?? PAGE_DEFAULT;
      if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_MAX) throw bad(`limit must be a whole number from 1 to ${PAGE_MAX}.`);
      const after = options.after;
      const m = after === undefined ? null : /^(\d{1,16}):([\w.:-]{1,100})$/.exec(String(after));
      if (after !== undefined && !m) throw bad('after must be a cursor a call to followed.get gave.');
      const row = await story(id);
      const out = await view(row);
      const { cards, entries } = await entriesOf(row);
      // Keyset by the head's date and id, so a story that grew since the last page repeats nothing.
      const start = m ? entries.findIndex((e) => e.head.pubDateMs < Number(m[1]) || (e.head.pubDateMs === Number(m[1]) && e.head.articleId > m[2])) : 0;
      const page = start < 0 ? [] : entries.slice(start, start + limit);
      const more = start >= 0 && start + limit < entries.length;
      const last = page.at(-1);
      const heads = await Promise.all(page.map(async (e) => {
        const link = await linkOf(e.head.articleId);
        return { head: article(e.head, link.url, link.image), copies: e.copies.length };
      }));
      if (options.markSeen === true) {
        // As the app's timeline: clear the count, and stamp the newest article seen so older ones found later are not new.
        await tracked().markSeen(row.id);
        const newest = Math.max(0, ...cards.map((c) => c.pubDateMs || 0));
        if (newest > 0) await tracked().advanceSeenWatermark(row.id, newest);
      }
      return { story: out, entries: heads, cursor: more && last ? `${last.head.pubDateMs}:${last.head.articleId}` : null, more };
    },

    async follow(input) {
      const text = typeof input?.text === 'string' ? input.text.trim().replace(/\s+/g, ' ') : '';
      if (!plain(text)) throw bad(`text must be 1 to ${MAX_TOPIC} characters.`);
      const label = input.label === undefined ? text : typeof input.label === 'string' ? input.label.trim().replace(/\s+/g, ' ') : '';
      if (!plain(label)) throw bad(`label must be 1 to ${MAX_TOPIC} characters.`);
      const from = input.fromArticleId;
      if (from !== undefined && (typeof from !== 'string' || !ID.test(from))) throw bad('fromArticleId must be an article id.');

      // A follow from typed text has no article, as in the app's own follow chat.
      let subject = { origin: 'article', surface: 'pod', articleId: '', title: '', pubDate: null as string | null, stableClusterId: null as string | null, publicationName: null as string | null, countryCode: null as string | null, languageCode: null as string | null };
      if (from) {
        let a = await localRow(from);
        if (!a) {
          const { ArticleService } = client<{ ArticleService: { getArticlesForTopicsByIds(ids: string[]): Promise<{ articles: (Suggestion & { _id: string; title?: string | null; pubDate?: string | null })[] }> } }>('article-service');
          const found = await ArticleService.getArticlesForTopicsByIds([from]).then((r) => r.articles.find((x) => x._id === from), () => {
            throw new PodError('news_unavailable', 'The news server could not answer, so nothing was followed.', 'try again in a minute');
          });
          if (!found) throw new PodError('unknown_article', 'Mera News has no article with that id now.', 'follow by text alone, or pass an id from a story shown now');
          a = { ...found, title_original: found.title ?? null, firstPubDate: found.pubDate ?? '' };
        }
        subject = {
          ...subject,
          origin: 'suggestion',
          articleId: from,
          title: a.title_en || a.title_original || '',
          pubDate: a.firstPubDate || null,
          stableClusterId: a.clusters?.find((c) => c?.stableClusterId)?.stableClusterId ?? null,
          publicationName: a.publication_name,
          countryCode: a.country_code,
          languageCode: a.language_code,
        };
      }
      const { outcome, id } = await serially(async () => ({
        outcome: await actions().trackStoryWithProposal(subject, { label, searchText: text }),
        id: await tracked().findActiveTrackedId({ stableClusterId: subject.stableClusterId, articleId: subject.articleId || null, searchText: text }),
      }));
      if (outcome === 'skipped' || !id) throw failed();
      const grows = deps.hasAi()
        ? 'It grows each time Mera News reads the news.'
        : 'It grows only while Mera News reads the news, and reading needs an AI service: until one is set, nothing new is added.';
      return { id, state: outcome, hint: `${outcome === 'already' ? 'This story was already followed.' : 'Following this story.'} ${grows}` };
    },

    async unfollow(id) {
      const row = await story(id);
      if (!(await actions().deleteTrackedStoryById(row.id))) throw failed();
      return { removed: true };
    },

    async removeArticle(id, articleId) {
      const row = await story(id);
      if (typeof articleId !== 'string' || !ID.test(articleId)) throw bad('articleId must be the id of an article on the story.');
      // A folded entry is one story to the person, so every copy goes, as in the app.
      const entry = (await entriesOf(row)).entries.find((e) => [e.head, ...e.copies].some((c) => c.articleId === articleId));
      if (!entry) throw new PodError('unknown_article', 'That article is not on the story.', 'call followed.get for the articles on it');
      const results = await Promise.all([entry.head, ...entry.copies].map((c) => actions().disownStoryMember(row.id, c.articleId)));
      if (results.some((ok) => !ok)) throw failed();
      return { removed: true };
    },
  };
}
