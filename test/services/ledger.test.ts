import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLedger, PodError } from '../../src/services/ledger';

const dirs: string[] = [];
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pod-ledger-'));
  dirs.push(dir);
  return path.join(dir, 'picks.json');
};
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

type Item = { seq: number; id: string };
/** One poll of the feed: the given stories (each a list of member ids) are in it, and these rows exist. */
const poll = (ledger: ReturnType<typeof createLedger>, stories: string[][], live = new Set(stories.flat())) =>
  ledger.run((tx) => tx.register(stories, live).map((seq, i): Item => ({ seq, id: stories[i][0] })));
const read = (ledger: ReturnType<typeof createLedger>, stories: string[][], since: string | undefined, limit = 10, live?: Set<string>) =>
  ledger.run((tx) => {
    const seqs = tx.register(stories, live ?? new Set(stories.flat()));
    return tx.take(seqs.map((seq, i): Item => ({ seq, id: stories[i][0] })), since, limit);
  });
const ids = (r: { items: Item[] }) => r.items.map((i) => i.id);

test('a pick is delivered once: a second read with the returned cursor returns none', async () => {
  const ledger = createLedger(temp());
  const first = await read(ledger, [['a'], ['b']], undefined);
  assert.deepEqual(ids(first), ['a', 'b']);
  const second = await read(ledger, [['a'], ['b']], first.cursor);
  assert.deepEqual(ids(second), []);
  assert.equal(second.cursor, first.cursor);
});

test('a read with no cursor continues from the last pick this pod delivered', async () => {
  const ledger = createLedger(temp());
  await read(ledger, [['a']], undefined);
  const next = await read(ledger, [['a'], ['b']], undefined);
  assert.deepEqual(ids(next), ['b']);
  assert.deepEqual(ids(await read(ledger, [['a'], ['b']], undefined)), []);
});

test('a page ends at the limit, says there is more, and the next read carries on', async () => {
  const ledger = createLedger(temp());
  const stories = [['a'], ['b'], ['c']];
  const page = await read(ledger, stories, undefined, 2);
  assert.deepEqual(ids(page), ['a', 'b']);
  assert.equal(page.more, true);
  const rest = await read(ledger, stories, undefined, 2);
  assert.deepEqual(ids(rest), ['c']);
  assert.equal(rest.more, false);
});

test("'all' replays every pick without moving what was delivered back", async () => {
  const ledger = createLedger(temp());
  const stories = [['a'], ['b']];
  await read(ledger, stories, undefined);
  assert.deepEqual(ids(await read(ledger, stories, 'all')), ['a', 'b']);
  assert.deepEqual(ids(await read(ledger, stories, undefined)), [], 'replaying does not make the picks new again');
});

test('a pick that leaves the Feed and returns is not delivered again', async () => {
  const ledger = createLedger(temp());
  await read(ledger, [['a'], ['b']], undefined);
  // 'a' drops out of the Feed but its row is still stored.
  await read(ledger, [['b']], undefined, 10, new Set(['a', 'b']));
  const back = await read(ledger, [['a'], ['b']], undefined);
  assert.deepEqual(ids(back), []);
});

test('a new representative of a delivered story is not delivered again', async () => {
  const ledger = createLedger(temp());
  await read(ledger, [['a', 'b']], undefined);
  const again = await read(ledger, [['b', 'c']], undefined);
  assert.deepEqual(ids(again), []);
  // The later member counts as known too, so a switch back stays quiet.
  assert.deepEqual(ids(await read(ledger, [['c']], undefined)), []);
});

test('an entry is pruned only when no row exists for its article, and a pruned one is new when it returns', async () => {
  const ledger = createLedger(temp());
  await read(ledger, [['a']], undefined);
  await poll(ledger, [], new Set());
  const again = await read(ledger, [['a']], undefined);
  assert.deepEqual(ids(again), ['a']);
});

test('a cursor from an unknown ledger epoch restarts from the beginning and says so', async () => {
  const ledger = createLedger(temp());
  const stories = [['a'], ['b']];
  await read(ledger, stories, undefined);
  const reply = await read(ledger, stories, 'ffffffffff.99');
  assert.equal(reply.reset, true);
  assert.deepEqual(ids(reply), ['a', 'b']);
  assert.equal((await read(ledger, stories, 'all')).reset, undefined);
});

test('a cursor the ledger never issued is an error with a next step', async () => {
  const ledger = createLedger(temp());
  const first = await read(ledger, [['a']], undefined);
  const epoch = first.cursor.split('.')[0];
  for (const since of [`${epoch}.99`, 'banana', `${epoch}.-1`, '']) {
    await assert.rejects(read(ledger, [['a']], since), (error: PodError) => {
      assert.equal(error.code, 'unknown_cursor');
      assert.equal(error.next, 'call without since');
      return true;
    }, `since=${JSON.stringify(since)}`);
  }
  // A refused cursor moves nothing.
  assert.deepEqual(ids(await read(ledger, [['a']], undefined)), []);
});

test('the ledger survives a restart: nothing is delivered twice and the cursor still counts', async () => {
  const file = temp();
  const before = createLedger(file);
  const first = await read(before, [['a'], ['b']], undefined);
  const after = createLedger(file);
  assert.deepEqual(ids(await read(after, [['a'], ['b']], undefined)), []);
  const reply = await read(after, [['a'], ['b'], ['c']], first.cursor);
  assert.deepEqual(ids(reply), ['c']);
  assert.equal(reply.reset, undefined, 'the epoch is the same after a restart');
});

test('the epoch is saved as soon as a cursor leaves, even when nothing was delivered', async () => {
  const file = temp();
  const first = await read(createLedger(file), [], undefined);
  const again = await read(createLedger(file), [], first.cursor);
  assert.equal(again.reset, undefined);
});

test('a ledger file that cannot be read is set aside and the history starts over', async () => {
  const file = temp();
  fs.writeFileSync(file, '{"epoch":');
  const ledger = createLedger(file);
  assert.deepEqual(ids(await read(ledger, [['a']], undefined)), ['a']);
  assert.ok(fs.existsSync(`${file}.unreadable`), 'the old file is kept for a person to look at');
});

test('two writers on one promise chain never lose an entry', async () => {
  const file = temp();
  const ledger = createLedger(file);
  const all = new Set(Array.from({ length: 30 }, (_, i) => `a${i}`));
  await Promise.all([...all].map((id) => ledger.run((tx) => tx.register([[id]], all))));
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(Object.keys(saved.byArticle).length, 30);
  assert.equal(new Set(Object.values(saved.byArticle)).size, 30, 'every entry has its own number');
  assert.equal(saved.seq, 30);
});

test('a failed task does not stop the next one, and its change is not lost', async () => {
  const ledger = createLedger(temp());
  await assert.rejects(ledger.run(() => { throw new Error('boom'); }));
  assert.deepEqual(ids(await read(ledger, [['a']], undefined)), ['a']);
});

test('a write is atomic: a reader never sees a half-written file while the ledger saves', async () => {
  const file = temp();
  const ledger = createLedger(file);
  // A large history makes each write take several steps of the event loop.
  const all = new Set(Array.from({ length: 40_000 }, (_, i) => `article-${i}`));
  await ledger.run((tx) => tx.register([...all].map((id) => [id]), all));
  let reads = 0;
  let bad = 0;
  let stop = false;
  const watcher = (async () => {
    while (!stop) {
      try {
        JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        bad++;
      }
      reads++;
      await new Promise((r) => setImmediate(r));
    }
  })();
  for (let i = 0; i < 25; i++) await ledger.run((tx) => tx.register([[`extra-${i}`]], all));
  stop = true;
  await watcher;
  assert.ok(reads > 25, 'the reader ran during the writes');
  assert.equal(bad, 0);
});

test('a leftover temporary file from a killed write is ignored and replaced', async () => {
  const file = temp();
  await read(createLedger(file), [['a']], undefined);
  fs.writeFileSync(`${file}.tmp`, '{"epoch":"half');
  const ledger = createLedger(file);
  assert.deepEqual(ids(await read(ledger, [['a'], ['b']], undefined)), ['b']);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, 'utf8')));
});

test('a process killed in the middle of saving leaves a ledger that still loads', async () => {
  const file = temp();
  for (let round = 0; round < 6; round++) {
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(__dirname, 'fixtures', 'ledger-writer.ts'), file], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((resolve) => child.stdout.once('data', () => resolve()));
    await new Promise((r) => setTimeout(r, 20 + round * 13));
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(typeof saved.epoch, 'string');
    assert.ok(Object.keys(saved.byArticle).length >= 1000);
  }
});
