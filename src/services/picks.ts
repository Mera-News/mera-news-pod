// What the Feed holds right now, as picks. A pick is one story: a headline, a link and a one-line
// reason the model wrote. The article's own text is never read here, so it cannot be returned.
import type { PickLevel, PickView } from '../plugin-api';
import { client } from './client';

type Suggestion = {
  articleId: string;
  status: string;
  reason: string | null;
  relevance: number | null;
  firstPubDate: string;
  title_en: string | null;
  title_original: string | null;
  article_url: string | null;
  publication_name: string | null;
  language_code: string | null;
  factIds?: string[];
};
type FeedItem = { id: string; suggestion: Suggestion; memberIds: string[] };


export interface Candidate {
  memberIds: string[];
  pick: PickView;
}

const LEVELS: Record<string, PickLevel> = { EMERGENCY: 'emergency', HIGH: 'high', MEDIUM: 'medium', LOW: 'low' };

/**
 * The stories in the Feed that have a reason, oldest first, and every stored article row. A story
 * with an article in `leftOut` (the assistant left it out) is never a pick: its rows are marked
 * excluded, which the client's scorer never moves, so a paired phone does not show it either.
 */
export async function readFeed(leftOut: ReadonlySet<string> = new Set()): Promise<{ candidates: Candidate[]; liveIds: Set<string>; rows: { articleId: string; status: string }[] }> {
  const { loadSuggestions } = client<{ loadSuggestions(): Promise<Suggestion[]> }>('database/services/article-suggestion-reads');
  const { buildFeedList } = client<{ buildFeedList(rows: Suggestion[], excluded: Set<string>, nowMs?: number): FeedItem[] }>('stores/feed-list-selector');
  const { bandOf } = client<{ bandOf(relevance: number | null): string }>('news-harness/feed-select/ownership');
  const { getFacts } = client<{ getFacts(): Promise<{ id: string; statement: string }[]> }>('database/services/fact-service');

  const rows = await loadSuggestions();
  const dropped = new Set(rows.filter((r) => leftOut.has(r.articleId)).map((r) => r.articleId));
  const statements = new Map((await getFacts()).map((f) => [f.id, f.statement]));
  const candidates: Candidate[] = [];
  for (const item of buildFeedList(rows, new Set())) {
    if (item.memberIds.some((id) => leftOut.has(id))) {
      for (const id of item.memberIds) dropped.add(id);
      continue;
    }
    const rep = item.suggestion;
    const reason = rep.reason?.trim();
    if (rep.status !== 'complete' || !reason || !rep.article_url) continue;
    candidates.push({
      memberIds: item.memberIds,
      pick: {
        id: item.id,
        // The title stays in the article's own language.
        title: (rep.title_original || rep.title_en || '').trim(),
        publication: rep.publication_name ?? '',
        url: rep.article_url,
        publishedAt: rep.firstPubDate,
        level: LEVELS[bandOf(rep.relevance)] ?? 'low',
        lang: rep.language_code || 'und',
        reason,
        facts: (rep.factIds ?? []).flatMap((id) => statements.get(id) ?? []),
      },
    });
  }
  const toExclude = rows.filter((r) => dropped.has(r.articleId) && r.status !== 'excluded' && r.status !== 'already_read');
  if (toExclude.length) {
    await client<{ batchMarkExcluded(ids: string[]): Promise<void> }>('database/services/article-suggestion-scoring-writes').batchMarkExcluded(toExclude.map((r) => r.articleId));
    for (const r of toExclude) r.status = 'excluded';
  }
  // New stories are numbered in this order, so the oldest is delivered first.
  candidates.sort((a, b) => a.pick.publishedAt.localeCompare(b.pick.publishedAt) || a.pick.id.localeCompare(b.pick.id));
  return { candidates, liveIds: new Set(rows.map((r) => r.articleId)), rows };
}
