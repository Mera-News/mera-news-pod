// Tells plugins when what a snapshot serves has changed. WatermelonDB reports every write to a
// table, because runtime writes never use raw SQL, so one subscription sees reads, jobs and commands.
import type { PickView, PodServices } from '../plugin-api';

type Subscription = { unsubscribe(): void };
const client = <T>(file: string) => require(`mera-news-client/dist/lib/${file}`) as T;

export const DEBOUNCE_MS = 2000;

export function createEvents(log: (line: string) => void): { events: PodServices['events']; poke(): void; emitNotify(picks: readonly PickView[]): void; stop(): void } {
  const { default: database } = client<{ default: { withChangesForTables(tables: string[]): { subscribe(next: () => void): Subscription } } }>('database/index');
  const { SYNC_TABLES } = client<{ SYNC_TABLES: { name: string }[] }>('sync/tables');
  const listeners = { changed: new Set<() => void>(), notify: new Set<(picks: PickView[]) => void | Promise<void>>() };
  let timer: NodeJS.Timeout | undefined;

  // The window opens at the first change and does not move, so a steady stream of writes still fires.
  const poke = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      for (const listener of [...listeners.changed]) {
        try {
          Promise.resolve(listener()).catch((error) => log(`A change listener failed: ${(error as Error).message}`));
        } catch (error) {
          log(`A change listener failed: ${(error as Error).message}`);
        }
      }
    }, DEBOUNCE_MS);
    timer.unref();
  };
  // The settings table is in the list, so this also sees a changed setting a snapshot serves.
  const sub = database.withChangesForTables(SYNC_TABLES.map((t) => t.name)).subscribe(poke);

  return {
    events: {
      on(event: 'changed' | 'notify', listener: any) {
        const set = listeners[event] as Set<unknown>;
        set.add(listener);
        return () => void set.delete(listener);
      },
    } as PodServices['events'],
    poke,
    // Fixed sentence only: an error here could carry a pick or a pass.
    emitNotify(picks) {
      const failed = () => log("A plugin's notify listener failed.");
      for (const listener of [...listeners.notify]) {
        try {
          Promise.resolve(listener([...picks])).catch(failed);
        } catch {
          failed();
        }
      }
    },
    stop() {
      sub.unsubscribe();
      clearTimeout(timer);
      timer = undefined;
      listeners.changed.clear();
      listeners.notify.clear();
    },
  };
}
