// What the Feed holds right now, as picks. A pick is one story: a headline, a link and a one-line
// reason the model wrote. The article's own text is never read here, so it cannot be returned.
import type { PickLevel, PickView } from '../plugin-api';

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

const client = <T>(file: string) => require(`mera-news-client/dist/lib/${file}`) as T;

export interface Candidate {
  memberIds: string[];
  pick: PickView;
}

const LEVELS: Record<string, PickLevel> = { EMERGENCY: 'emergency', HIGH: 'high', MEDIUM: 'medium', LOW: 'low' };

/** The stories in the Feed that have a reason, oldest first, and the id of every stored article row. */
export async function readFeed(): Promise<{ candidates: Candidate[]; liveIds: Set<string> }> {
  const { loadSuggestions } = client<{ loadSuggestions(): Promise<Suggestion[]> }>('database/services/article-suggestion-reads');
  const { buildFeedList } = client<{ buildFeedList(rows: Suggestion[], excluded: Set<string>, nowMs?: number): FeedItem[] }>('stores/feed-list-selector');
  const { bandOf } = client<{ bandOf(relevance: number | null): string }>('news-harness/feed-select/ownership');
  const { getFacts } = client<{ getFacts(): Promise<{ id: string; statement: string }[]> }>('database/services/fact-service');

  const rows = await loadSuggestions();
  const statements = new Map((await getFacts()).map((f) => [f.id, f.statement]));
  const candidates: Candidate[] = [];
  for (const item of buildFeedList(rows, new Set())) {
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
  // New stories are numbered in this order, so the oldest is delivered first.
  candidates.sort((a, b) => a.pick.publishedAt.localeCompare(b.pick.publishedAt) || a.pick.id.localeCompare(b.pick.id));
  return { candidates, liveIds: new Set(rows.map((r) => r.articleId)) };
}
