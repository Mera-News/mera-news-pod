// The saved facts and their topics: read them, add and remove facts, and shape a fact's topics.
// Every write goes through the client's own functions, so a fact added here is treated exactly like
// one added in the app: its topics are generated, and a removed topic is never generated back.
import type { DataServerInfo } from './status';
import type { AddFactsResult, FactView, PodServices, RemoveFactsResult, TopicEditResult, TopicSource, TopicView, TopicsStatus } from '../plugin-api';
import { client } from './client';

type Fact = { id: string; statement: string; topicsStatus: string | null; createdAt: string; questionnaireAttribute?: string };
type TopicRow = { id: string; text: string; weight: number; status: string; provenance: string; pendingDeleteAt: number | null };

const facts = () => client<{ getFacts(): Promise<Fact[]>; deleteFact(id: string): Promise<void> }>('database/services/fact-service');
const topics = () => client<{ getByFact(factId: string): Promise<TopicRow[]>; setWeight(id: string, weight: number): Promise<void> }>('database/services/topic-service');

export const PAGE = 50;
export const MAX_STATEMENT = 300;
const CONFLICT_NEXT = 'remove the fact it conflicts with first, or reword this one';

const SOURCES: Record<string, TopicSource> = { llm: 'generated', migration: 'generated', exploration: 'generated', combo: 'generated', user: 'added', feedback: 'added', tracked: 'followed' };
const shown = (rows: TopicRow[]) => rows.filter((t) => t.pendingDeleteAt == null && t.status === 'active');


export function createProfile(server: () => Promise<DataServerInfo>): PodServices['profile'] {
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
          topics: rows.map((t): TopicView => ({ id: t.id, text: t.text, weight: t.weight, source: SOURCES[t.provenance] ?? 'generated' })),
        });
      }
      return { facts: views, ...(offset + PAGE < all.length ? { nextOffset: offset + PAGE } : {}) };
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
      const { commitFactChoices } = client<{ commitFactChoices(choices: { statement: string }[]): Promise<{ savedFacts: { id: string; statement: string }[] }> }>('chat-tools/fact-commit');
      const { retryTopicGeneration } = client<{ retryTopicGeneration(id: string, statement: string): Promise<void> }>('chat-tools/tool-handlers');
      const { isHomeEntry } = client<{ isHomeEntry(entry: { statement: string }): boolean }>('mera-harness/core/fact-normalise');

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
          [{ id: `new-${fresh.length}`, statement, questionnaireAttribute: null }],
          saved.map((f) => ({ id: f.id, statement: f.statement, questionnaireAttribute: f.questionnaireAttribute ?? null })),
        )[0];
        if (conflict) {
          result.refused.push({ statement, code: 'conflict', conflictsWith: { id: conflict.existingFactId, statement: conflict.existingStatement }, next: CONFLICT_NEXT });
        } else fresh.push(statement);
      }

      // One call, so topic generation for all of them is a single batch.
      if (fresh.length) {
        const { savedFacts } = await commitFactChoices(fresh.map((statement) => ({ statement })));
        result.added.push(...savedFacts.map((f) => ({ id: f.id, statement: f.statement })));
      }
      if (result.added.some((a) => isHomeEntry({ statement: a.statement })) && (await server().then((d) => d.limits.includes('place lookup') || d.placesNotLoaded))) {
        result.localCoverageWeaker = true;
      }
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
      return result;
    },
  };
}
