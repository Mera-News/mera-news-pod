import { client } from './client';
// Two things the pod does on its own once the client runs. The first read starts as soon as a
// fact's topics are ready, rather than at the next scheduled read. The second keeps the pick ledger
// current as stories finish being rated, so a story that comes and goes is still remembered.
type Fact = { id: string; topicsStatus: string | null };
type Subscription = { unsubscribe(): void };


/**
 * Starts one read the first time a fact has finished topics. A pause covers it. A read already
 * running may have fetched its topics before this fact's were ready, so the read is asked for again
 * once that one ends.
 */
export function watchTopicsReady(log: (line: string) => void): () => void {
  const { getFacts, observeFacts } = client<{ getFacts(): Promise<Fact[]>; observeFacts(): { subscribe(next: (facts: Fact[]) => void): Subscription } }>('database/services/fact-service');
  const { getByFact } = client<{ getByFact(id: string): Promise<{ status: string; pendingDeleteAt: number | null }[]> }>('database/services/topic-service');
  const { AppScheduler } = client<{ AppScheduler: { trigger(name: string): Promise<string> } }>('scheduler/AppScheduler');
  let stopped = false;
  const read = (): void =>
    void AppScheduler.trigger('feed-sync').then(
      (result) => {
        // 'busy' and 'debounced' both mean a read that may predate this fact's topics.
        if ((result === 'busy' || result === 'debounced') && !stopped) setTimeout(read, 1000).unref();
      },
      (error) => log(`The first read could not start: ${(error as Error).message}`),
    );

  const triggered = new Set<string>();
  const hasActiveTopic = async (id: string) => (await getByFact(id)).some((t) => t.status === 'active' && t.pendingDeleteAt == null);
  // Facts ready when the pod started have had their read. Read now, before any later write: the
  // observer's first emission can come after a fact was added, so it cannot tell the two apart.
  const readyAtStart = getFacts().then(async (facts) => {
    for (const fact of facts) if (fact.topicsStatus === 'done' && (await hasActiveTopic(fact.id))) triggered.add(fact.id);
  }).catch((error) => log(`Reading the saved facts failed: ${(error as Error).message}`));
  let turn: Promise<void> = readyAtStart;
  const sub = observeFacts().subscribe((facts) => {
    turn = turn
      .then(async () => {
        for (const fact of facts) {
          if (fact.topicsStatus !== 'done') {
            triggered.delete(fact.id);
            continue;
          }
          if (triggered.has(fact.id)) continue;
          if (!(await hasActiveTopic(fact.id))) continue;
          triggered.add(fact.id);
          read();
        }
      })
      .catch((error) => log(`Watching for new topics failed: ${(error as Error).message}`));
  });
  return () => {
    stopped = true;
    sub.unsubscribe();
  };
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
