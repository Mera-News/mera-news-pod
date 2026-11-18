// Two things the pod does on its own once the client runs. The first read starts as soon as a
// fact's topics are ready, rather than at the next scheduled read. The second keeps the pick ledger
// current as stories finish being rated, so a story that comes and goes is still remembered.
type Fact = { id: string; topicsStatus: string | null };
type Subscription = { unsubscribe(): void };

const client = <T>(file: string) => require(`mera-news-client/dist/lib/${file}`) as T;

/** Starts one read the first time a fact has finished topics. A read already in progress or a pause covers it. */
export function watchTopicsReady(log: (line: string) => void): () => void {
  const { observeFacts } = client<{ observeFacts(): { subscribe(next: (facts: Fact[]) => void): Subscription } }>('database/services/fact-service');
  const { getByFact } = client<{ getByFact(id: string): Promise<{ status: string; pendingDeleteAt: number | null }[]> }>('database/services/topic-service');
  const { AppScheduler } = client<{ AppScheduler: { trigger(name: string): Promise<string> } }>('scheduler/AppScheduler');

  const triggered = new Set<string>();
  let first = true;
  let turn: Promise<void> = Promise.resolve();
  const sub = observeFacts().subscribe((facts) => {
    turn = turn
      .then(async () => {
        const startup = first;
        first = false;
        for (const fact of facts) {
          if (fact.topicsStatus !== 'done') {
            triggered.delete(fact.id);
            continue;
          }
          if (triggered.has(fact.id)) continue;
          const active = (await getByFact(fact.id)).some((t) => t.status === 'active' && t.pendingDeleteAt == null);
          if (!active) continue;
          triggered.add(fact.id);
          // Facts that were ready before the pod started have already had their read.
          if (!startup) void AppScheduler.trigger('feed-sync').catch((error) => log(`The first read could not start: ${(error as Error).message}`));
        }
      })
      .catch((error) => log(`Watching for new topics failed: ${(error as Error).message}`));
  });
  return () => sub.unsubscribe();
}

/** Calls `onChange` whenever a story finishes or stops being finished. Calls that pile up run once more, not once each. */
export function watchFinishedStories(onChange: () => Promise<void>, log: (line: string) => void): () => void {
  const { default: database } = client<{ default: { get(table: string): { query(...clauses: unknown[]): { observeWithColumns(columns: string[]): { subscribe(next: () => void): Subscription } } } } }>('database/index');
  const { Q } = require('@nozbe/watermelondb') as { Q: { where(column: string, value: unknown): unknown } };

  let running = false;
  let again = false;
  let stopped = false;
  const run = async () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        await onChange().catch((error) => log(`Updating the pick history failed: ${(error as Error).message}`));
      } while (again && !stopped);
    } finally {
      running = false;
    }
  };
  const sub = database.get('article_suggestions').query(Q.where('status', 'complete')).observeWithColumns(['status']).subscribe(() => void run());
  return () => {
    stopped = true;
    sub.unsubscribe();
  };
}
