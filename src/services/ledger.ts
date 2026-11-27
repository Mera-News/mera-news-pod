// The pick ledger: which stories the pod has already handed out, kept in picks.json so a restart
// neither repeats a story nor loses one. A story is known by every article id it has had, so a new
// lead article for the same story is not delivered again. Every read and write goes through one
// promise chain, and a file is only ever replaced whole, so a crash leaves the old or the new one.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { cutToFit } from './cut';

/** An error a plugin can show as it is: a stable code and what to do next. */
export class PodError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly next: string,
  ) {
    super(message);
  }
}

interface State {
  epoch: string;
  seq: number;
  lastDelivered: number;
  byArticle: Record<string, number>;
}

export interface Take<T> {
  items: T[];
  cursor: string;
  more: boolean;
  /** The cursor came from another history, so the picks count from the beginning. */
  reset?: true;
}

export interface Tx {
  /**
   * Gives each story (a list of article ids) its number: the lowest one any of its ids already has,
   * else a new one. Ids whose row no longer exists are forgotten. Returns one number per story.
   */
  register(stories: readonly (readonly string[])[], liveIds: ReadonlySet<string>): number[];
  /**
   * The items after the cursor, oldest first. `since` is a cursor, 'all', or absent for "after the
   * last delivered". `fits` shortens the page to its longest start that fits, never below one item,
   * so only what is returned counts as delivered. `peek` delivers nothing.
   */
  take<T extends { seq: number }>(items: readonly T[], since: string | undefined, limit: number, fits?: (page: T[]) => boolean, peek?: boolean): Take<T>;
}

const CURSOR = /^([0-9a-f]+)\.(\d+)$/;
const unknownCursor = () => new PodError('unknown_cursor', 'That cursor was not issued by this pod.', 'call without since');

const fresh = (): State => ({ epoch: randomBytes(5).toString('hex'), seq: 0, lastDelivered: 0, byArticle: {} });

const valid = (s: any): s is State =>
  s && typeof s.epoch === 'string' && /^[0-9a-f]+$/.test(s.epoch) && Number.isInteger(s.seq) && Number.isInteger(s.lastDelivered) && s.byArticle && typeof s.byArticle === 'object';

function load(file: string): { state: State; saved: boolean; setAside: string | undefined } {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { state: fresh(), saved: false, setAside: undefined };
  }
  try {
    const parsed = JSON.parse(text);
    if (valid(parsed)) return { state: parsed, saved: true, setAside: undefined };
  } catch {
    // falls through to the same handling as a file with the wrong shape
  }
  // Starting over repeats stories, so the old file is kept for a person to look at.
  fs.renameSync(file, `${file}.unreadable`);
  return { state: fresh(), saved: false, setAside: `${file}.unreadable` };
}

async function save(file: string, state: State): Promise<void> {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  const handle = await fs.promises.open(tmp, 'w', 0o600);
  try {
    await handle.writeFile(JSON.stringify(state));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.promises.rename(tmp, file);
}

export function createLedger(file: string) {
  const loaded = load(file);
  const state = loaded.state;
  // A new ledger is saved on its first run, because a cursor carries its epoch.
  let dirty = !loaded.saved;
  let chain: Promise<unknown> = Promise.resolve();

  const tx: Tx = {
    register(stories, liveIds) {
      const used = new Set<number>();
      const seqs = stories.map((members) => {
        const known = members.map((id) => state.byArticle[id]).filter((n): n is number => n !== undefined);
        let seq = known.length ? Math.min(...known) : undefined;
        // Two stories cannot share a number, or a page could end between them and lose one.
        if (seq === undefined || used.has(seq)) {
          seq = ++state.seq;
          dirty = true;
        }
        used.add(seq);
        for (const id of members) {
          if (state.byArticle[id] !== seq) {
            state.byArticle[id] = seq;
            dirty = true;
          }
        }
        return seq;
      });
      for (const id of Object.keys(state.byArticle)) {
        if (!liveIds.has(id)) {
          delete state.byArticle[id];
          dirty = true;
        }
      }
      return seqs;
    },

    take(items, since, limit, fits, peek) {
      let from: number;
      let reset = false;
      if (since === undefined) from = state.lastDelivered;
      else if (since === 'all') from = 0;
      else {
        const match = CURSOR.exec(since);
        if (!match) throw unknownCursor();
        if (match[1] !== state.epoch) {
          from = 0;
          reset = true;
        } else {
          from = Number(match[2]);
          if (from > state.seq) throw unknownCursor();
        }
      }
      const later = items.filter((item) => item.seq > from).sort((a, b) => a.seq - b.seq);
      let page = later.slice(0, limit);
      if (fits) page = cutToFit(page, fits);
      const last = page.length ? page[page.length - 1].seq : from;
      // Delivered when the reply is returned: a reply that is lost on the way repeats, never skips.
      if (!peek && last > state.lastDelivered) {
        state.lastDelivered = last;
        dirty = true;
      }
      return { items: page, cursor: `${state.epoch}.${last}`, more: later.length > page.length, ...(reset ? { reset: true as const } : {}) };
    },
  };

  return {
    /** The file an unreadable history was moved to at start, when that happened. */
    setAside: loaded.setAside,
    /** The history's epoch and the highest number it has given a story. */
    position: () => ({ epoch: state.epoch, head: state.seq }),
    /** Runs `fn` after every earlier call has finished, then saves once if it changed anything. */
    run<T>(fn: (tx: Tx) => T | Promise<T>): Promise<T> {
      const result = chain.then(async () => {
        const out = await fn(tx);
        if (dirty) {
          await save(file, state);
          dirty = false;
        }
        return out;
      });
      chain = result.catch(() => {});
      return result;
    },
  };
}

export type Ledger = ReturnType<typeof createLedger>;
