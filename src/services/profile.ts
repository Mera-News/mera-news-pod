// The saved facts and their topics: read them, add and remove facts, and shape a fact's topics.
// Every write goes through the client's own functions, so a fact added here is treated exactly like
// one added in the app: its topics are generated, and a removed topic is never generated back.
import type { DataServerInfo } from './status';
import type { AddFactsResult, AddTopicsResult, FactView, PodServices, ProfileSetup, RemoveFactsResult, TopicEditResult, TopicSource, TopicView, TopicsStatus } from '../plugin-api';
import { client } from './client';
import { PodError } from './ledger';

type Fact = { id: string; statement: string; topicsStatus: string | null; createdAt: string; questionnaireAttribute?: string; metadata?: Record<string, unknown> };
type TopicRow = { id: string; factId?: string | null; text: string; weight: number; status: string; provenance: string; pendingDeleteAt: number | null; createdAt: Date };

const facts = () =>
  client<{ getFacts(): Promise<Fact[]>; deleteFact(id: string): Promise<void>; patchMetadata(id: string, patch: Record<string, unknown>): Promise<unknown> }>('database/services/fact-service');
const topics = () =>
  client<{ getByFact(factId: string): Promise<TopicRow[]>; getActive(): Promise<TopicRow[]>; setWeight(id: string, weight: number): Promise<void> }>('database/services/topic-service');

export const PAGE = 50;
export const MAX_STATEMENT = 300;
export const MAX_TOPICS = 12;
export const MAX_TOPIC = 80;
const CONFLICT_NEXT = 'remove the fact it conflicts with first, or reword this one';

const SOURCES: Record<string, TopicSource> = { llm: 'generated', migration: 'generated', exploration: 'generated', combo: 'generated', user: 'added', feedback: 'added', tracked: 'followed' };
const shown = (rows: TopicRow[]) => rows.filter((t) => t.pendingDeleteAt == null && t.status === 'active');

// Only addFacts writes this mark, so facts saved before it existed, or from the app, count as reviewed.
const REVIEW_REQUIRED = 'reviewRequired';
// The app's own key (topic-plan-resolution), a one-item list holding an ISO time.
const REVIEWED_AT = 'topicsReviewedAt';
const PERSON_MADE = new Set(['user', 'feedback', 'tracked']);
const needsReview = (f: Fact) => f.metadata?.[REVIEW_REQUIRED] === true;
const reviewedAt = (f: Fact): string | undefined => {
  const at = f.metadata?.[REVIEWED_AT];
  return Array.isArray(at) && typeof at[0] === 'string' ? at[0] : undefined;
};

/** A topic is reviewed when its fact needs no review, the person made it, or it is no newer than the fact's review. */
export function topicReviewed(fact: Fact, topic: Pick<TopicRow, 'provenance' | 'createdAt'>): boolean {
  const at = reviewedAt(fact);
  return !needsReview(fact) || PERSON_MADE.has(topic.provenance) || (at !== undefined && topic.createdAt.getTime() <= Date.parse(at));
}

/** Where setup stands over the given facts and their shown topics. Combination topics are left out. Without an AI service nothing makes topics, so a pending fact has none. */
export function setupOf(all: Fact[], topicsOf: (factId: string) => TopicRow[], hasAi: boolean): ProfileSetup {
  const setup: ProfileSetup = { complete: true, findingTopics: [], toReview: [], noTopics: [] };
  for (const fact of all.filter(needsReview)) {
    const rows = topicsOf(fact.id).filter((t) => t.provenance !== 'combo');
    if (fact.topicsStatus === 'pending' && hasAi) setup.findingTopics.push(fact.statement);
    else if (fact.topicsStatus !== 'done' || rows.length === 0) setup.noTopics.push(fact.statement);
    else if (rows.some((t) => !topicReviewed(fact, t))) setup.toReview.push(fact.statement);
  }
  setup.complete = !setup.findingTopics.length && !setup.toReview.length && !setup.noTopics.length;
  return setup;
}

/** Setup over every saved fact, with one read of the topics. */
export async function readSetup(hasAi: boolean, all?: Fact[]): Promise<ProfileSetup> {
  const byFact = new Map<string, TopicRow[]>();
  for (const t of await topics().getActive()) if (t.factId) byFact.set(t.factId, [...(byFact.get(t.factId) ?? []), t]);
  return setupOf(all ?? (await facts().getFacts()), (id) => byFact.get(id) ?? [], hasAi);
}

/** Topic texts from outside the pod, checked and tidied: 1 to 12 of them, each 1 to 80 characters on one line. */
export function cleanTopicTexts(texts: unknown): string[] {
  const bad = () => new PodError('bad_topics', `Give 1 to ${MAX_TOPICS} topics, each 1 to ${MAX_TOPIC} characters of plain text. Nothing was saved.`, 'send fewer or shorter topics');
  if (!Array.isArray(texts) || texts.length < 1 || texts.length > MAX_TOPICS) throw bad();
  return texts.map((t) => {
    const text = typeof t === 'string' ? t.replace(/\s+/g, ' ').trim() : '';
    // Format characters (bidi overrides, invisible marks) are refused, except the joiners some scripts need.
    if (text.length < 1 || text.length > MAX_TOPIC || /(?![\u200c\u200d])[\p{Cc}\p{Cf}]/u.test(text)) throw bad();
    return text;
  });
}

/** `hasAi`: the pod makes its own topics too, which a reply to `addTopics` says. */
export function createProfile(server: () => Promise<DataServerInfo>, hasAi: boolean): PodServices['profile'] {
  const byCreated = (a: Fact, b: Fact) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

  return {
    async get(options) {
      const offset = Math.max(0, Math.floor(options?.offset ?? 0));
      const all = (await facts().getFacts()).sort(byCreated);
      const page = all.slice(offset, offset + PAGE);
      const views: FactView[] = [];
      for (const fact of page) {
        const rows = shown(await topics().getByFact(fact.id));
        views.push({
          id: fact.id,
          statement: fact.statement,
          topicsStatus: (fact.topicsStatus ?? 'none') as TopicsStatus,
          addedAt: fact.createdAt,
          topics: rows.map((t): TopicView => ({ id: t.id, text: t.text, weight: t.weight, source: SOURCES[t.provenance] ?? 'generated', reviewed: topicReviewed(fact, t) })),
          needsReview: needsReview(fact),
          ...(reviewedAt(fact) ? { reviewedAt: reviewedAt(fact) } : {}),
        });
      }
      return { facts: views, ...(offset + PAGE < all.length ? { nextOffset: offset + PAGE } : {}), setup: await readSetup(hasAi, all) };
    },

    async addFacts(statements) {
      const wanted = statements.map((s) => String(s).trim());
      if (wanted.some((s) => s.length < 1 || s.length > MAX_STATEMENT)) {
        throw new Error(`Each statement must be 1 to ${MAX_STATEMENT} characters. Nothing was saved.`);
      }
      const { normalizeStatement } = client<{ normalizeStatement(s: string): string }>('news-harness/persona-management/fact-rules');
      const { detectFactConflicts } = client<{
        detectFactConflicts(
          added: { id: string; statement: string; questionnaireAttribute: string | null }[],
          saved: { id: string; statement: string; questionnaireAttribute: string | null }[],
        ): { newFactId: string; existingFactId: string; existingStatement: string }[];
      }>('news-harness/persona-management/fact-conflict');
      const { commitFactChoices } = client<{
        commitFactChoices(choices: { statement: string; questionnaire?: { attribute: string }; skillId?: string }[]): Promise<{ savedFacts: { id: string; statement: string }[] }>;
      }>('chat-tools/fact-commit');
      const { retryTopicGeneration } = client<{ retryTopicGeneration(id: string, statement: string): Promise<void> }>('chat-tools/tool-handlers');
      const { isHomeEntry } = client<{ isHomeEntry(entry: { statement: string }): boolean }>('mera-harness/core/fact-normalise');
      const { CANONICAL_LOCATION_KEY } = client<{ CANONICAL_LOCATION_KEY: string }>('mera-harness/core/combined-fact');
      // A home fact carries the app's residence attribute, which anchors where every later topic is set.
      const homeAttribute = (statement: string) => (isHomeEntry({ statement }) ? CANONICAL_LOCATION_KEY : null);

      const saved = await facts().getFacts();
      const byStatement = new Map(saved.map((f) => [normalizeStatement(f.statement), f]));
      const result: AddFactsResult = { added: [], already: [], refused: [] };
      const fresh: string[] = [];
      const seen = new Set<string>();

      for (const statement of wanted) {
        const key = normalizeStatement(statement);
        if (seen.has(key)) continue;
        seen.add(key);
        const existing = byStatement.get(key);
        if (existing) {
          const noTopics = shown(await topics().getByFact(existing.id)).length === 0;
          if (existing.topicsStatus === 'error' || (existing.topicsStatus === 'done' && noTopics)) {
            await retryTopicGeneration(existing.id, existing.statement);
            result.added.push({ id: existing.id, statement: existing.statement, retried: true });
          } else result.already.push({ id: existing.id, statement: existing.statement });
          continue;
        }
        const conflict = detectFactConflicts(
          [{ id: `new-${fresh.length}`, statement, questionnaireAttribute: homeAttribute(statement) }],
          saved.map((f) => ({ id: f.id, statement: f.statement, questionnaireAttribute: f.questionnaireAttribute ?? null })),
        )[0];
        if (conflict) {
          result.refused.push({ statement, code: 'conflict', conflictsWith: { id: conflict.existingFactId, statement: conflict.existingStatement }, next: CONFLICT_NEXT });
        } else fresh.push(statement);
      }

      // One call, so topic generation for all of them is a single batch.
      if (fresh.length) {
        const { savedFacts } = await commitFactChoices(
          fresh.map((statement) => {
            const attribute = homeAttribute(statement);
            return attribute ? { statement, questionnaire: { attribute }, skillId: 'topics/residence' } : { statement };
          }),
        );
        // shortcut: a second write right after the save, since commitFactChoices takes no metadata; a crash between them leaves the fact counted as reviewed. Upgrade when the client takes metadata on commit.
        const before = new Set(saved.map((f) => f.id));
        for (const f of savedFacts) if (!before.has(f.id)) await facts().patchMetadata(f.id, { [REVIEW_REQUIRED]: true });
        result.added.push(...savedFacts.map((f) => ({ id: f.id, statement: f.statement })));
      }
      if (result.added.some((a) => isHomeEntry({ statement: a.statement })) && (await server().then((d) => d.limits.includes('place lookup') || d.placesNotLoaded))) {
        result.localCoverageWeaker = true;
      }
      return result;
    },

    async addTopics(factId, texts) {
      const wanted = cleanTopicTexts(texts);
      const { normalizeTopicText } = client<{ normalizeTopicText(s: string): string }>('database/services/topic-service');
      const { getAllDeclinedNormalizedTexts } = client<{ getAllDeclinedNormalizedTexts(): Promise<Set<string>> }>('database/services/topic-decline-service');
      const { completeTopicGeneration } = client<{ completeTopicGeneration(factId: string, texts: string[]): Promise<{ id: string; text: string }[]> }>(
        'database/services/topic-generation-status-service',
      );
      if (!(await facts().getFacts()).some((f) => f.id === factId)) throw new PodError('unknown_fact', 'No saved fact has this id. Nothing was saved.', 'call get_profile for the fact ids');

      // A removed topic stays removed, and a topic the fact already has is not added twice.
      const skip = await getAllDeclinedNormalizedTexts();
      for (const t of await topics().getByFact(factId)) skip.add(normalizeTopicText(t.text));
      const fresh: string[] = [];
      const skipped: string[] = [];
      for (const text of wanted) {
        const key = normalizeTopicText(text);
        if (skip.has(key)) skipped.push(text);
        else {
          skip.add(key);
          fresh.push(text);
        }
      }
      // Writes the topics as the pod's own generator does and marks the fact's topics done.
      const minted = fresh.length ? await completeTopicGeneration(factId, fresh) : [];
      const result: AddTopicsResult = { added: minted.map((t) => ({ id: t.id, text: t.text })), skipped };
      if (hasAi) result.note = 'This pod also makes its own topics for each fact, so more may appear.';
      return result;
    },

    async removeFacts(ids) {
      const result: RemoveFactsResult = { removed: [], notFound: [] };
      const saved = new Map((await facts().getFacts()).map((f) => [f.id, f]));
      for (const id of ids) {
        const fact = saved.get(id);
        if (!fact) {
          result.notFound.push(id);
          continue;
        }
        const texts = shown(await topics().getByFact(id)).map((t) => t.text);
        await facts().deleteFact(id);
        saved.delete(id);
        result.removed.push({ id, statement: fact.statement, topics: texts });
      }
      return result;
    },

    async editTopics(edit) {
      const { deleteTopicWithDecline, flushPendingDeletes } = client<{ deleteTopicWithDecline(id: string): Promise<unknown>; flushPendingDeletes(): Promise<number> }>(
        'database/services/topic-decline-service',
      );
      const { default: database } = client<{ default: { get(table: string): { find(id: string): Promise<unknown> } } }>('database/index');
      const exists = (id: string) => database.get('topics').find(id).then(() => true, () => false);
      const result: TopicEditResult = { results: [] };

      // Checked before anything changes, so a refusal leaves the topics as they were.
      const toReview = edit.reviewed ?? [];
      if (toReview.length) {
        const saved = new Map((await facts().getFacts()).map((f) => [f.id, f]));
        if (toReview.some((id) => !saved.has(id))) throw new PodError('unknown_fact', 'No saved fact has this id. Nothing was changed.', 'call get_profile for the fact ids');
        if (toReview.some((id) => saved.get(id)!.topicsStatus === 'pending')) {
          throw new PodError('topics_pending', 'Topics for this fact are still being made. Nothing was changed.', 'wait until its topics are ready, then review them');
        }
      }

      for (const [index, id] of (edit.remove ?? []).entries()) {
        if (!(await exists(id))) {
          result.results.push({ op: 'remove', index, ok: false, id, error: 'no topic with this id' });
          continue;
        }
        // Declined first, so the topic is not generated again, then the delete is made final now.
        await deleteTopicWithDecline(id);
        await flushPendingDeletes();
        result.results.push({ op: 'remove', index, ok: true, id });
      }
      for (const [index, { topicId, weight }] of (edit.weight ?? []).entries()) {
        if (typeof weight !== 'number' || !Number.isFinite(weight)) {
          result.results.push({ op: 'weight', index, ok: false, id: topicId, error: 'weight must be a number from -1 to 1' });
        } else if (!(await exists(topicId))) {
          result.results.push({ op: 'weight', index, ok: false, id: topicId, error: 'no topic with this id' });
        } else {
          // The client keeps the weight between -1 and 1.
          await topics().setWeight(topicId, weight);
          result.results.push({ op: 'weight', index, ok: true, id: topicId });
        }
      }
      // One merge inside one write, so a concurrent metadata change is kept.
      const at = new Date().toISOString();
      for (const id of toReview) await facts().patchMetadata(id, { [REVIEWED_AT]: [at] });
      return result;
    },
  };
}
