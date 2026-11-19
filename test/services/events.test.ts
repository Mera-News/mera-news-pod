import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { killAll, ok, startServicesPod, until, world, type World } from './helpers';

after(killAll);
type Pod = Parameters<typeof ok>[0];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A plugin speaking 2 that logs one line per `changed` it hears. The first listener throws, the second logs. */
async function withListener(w: World, name = 'ears') {
  const file = path.join(w.home, `${name}.js`);
  const log = path.join(w.home, `${name}.log`);
  fs.writeFileSync(
    file,
    `exports.podApi = 2; exports.name = '${name}';
exports.createPlugin = (ctx) => {
  const off = [];
  return {
    start: async () => {
      off.push(ctx.services.events.on('changed', () => { throw new Error('a listener that fails'); }));
      off.push(ctx.services.events.on('changed', (...args) => require('node:fs').appendFileSync(${JSON.stringify(log)}, 'changed ' + args.length + '\\n')));
    },
    stop: async () => off.forEach((f) => f()),
  };
};`,
  );
  const config = JSON.parse(fs.readFileSync(path.join(w.home, 'pod.json'), 'utf8'));
  fs.writeFileSync(path.join(w.home, 'pod.json'), JSON.stringify({ ...config, plugins: [{ package: file }] }));
  const count = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).length : 0);
  // The read at start writes too: wait for it to end, then for a quiet stretch longer than the debounce.
  const settle = async (pod: Pod) => {
    await until(() => ok(pod, 'reading.status'), (s) => s.firstReadDone && !s.readingNow, 'the read at start to end');
    for (let last = -1; last !== count(); ) {
      last = count();
      await sleep(2500);
    }
  };
  return { count, settle, log };
}
const row = (id: string) => ({ id });
const plant = (pod: Pod, ...ids: string[]) => pod.ask('plant', ids.map(row));

test('ten writes inside the debounce fire one change, with no payload, and a throwing listener harms nobody', async () => {
  const w = await world();
  try {
    const { count, settle } = await withListener(w);
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    await settle(pod);
    const base = count();
    for (let i = 0; i < 10; i++) await plant(pod, `burst${i}`);
    await sleep(3500);
    assert.equal(count() - base, 1);
    assert.equal(fs.readFileSync(path.join(w.home, 'ears.log'), 'utf8').trim().split('\n').pop(), 'changed 0');
    assert.equal((await pod.ask('state')).reading, 'on');
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});

test('a read, a job and a command write each fire a change', async () => {
  const w = await world();
  try {
    const { count, settle } = await withListener(w);
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    await settle(pod);
    const fired = async (what: string, act: () => Promise<unknown>) => {
      const base = count();
      await act();
      await sleep(3500);
      assert.equal(count() - base, 1, what);
    };
    // A read adds scored stories, a job updates one, a command writes a fact.
    await fired('read', () => plant(pod, 'story1'));
    await fired('job', () => pod.ask('patchRow', { id: 'story1', patch: { reason: 'Rated again.' } }));
    await fired('command', () => pod.ask('plantFact', { statement: 'Follows chess', status: 'done', topics: [{ text: 'chess' }] }));
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});

test('a paused pod fires nothing on its own, and still fires for a profile edit', async () => {
  const w = await world();
  try {
    const { count, settle } = await withListener(w);
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    await settle(pod);
    await ok(pod, 'reading.set', { paused: true });
    // Work that began before the pause may still finish ('pausing'); count from when it is paused and quiet.
    await until(() => ok(pod, 'reading.status'), (s) => s.reading === 'paused', 'the pause to settle');
    for (let last = -1; last !== count(); ) {
      last = count();
      await sleep(2500);
    }
    const base = count();
    await sleep(4500);
    assert.equal(count(), base);
    await ok(pod, 'profile.addFacts', ['Follows sailing']);
    await sleep(3500);
    assert.ok(count() > base);
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});

const fixedSentence = "A plugin's notify listener failed.";
const podJsonPlugin = (w: World, file: string, extra: object = {}) => {
  const config = JSON.parse(fs.readFileSync(path.join(w.home, 'pod.json'), 'utf8'));
  fs.writeFileSync(path.join(w.home, 'pod.json'), JSON.stringify({ ...config, ...extra, plugins: [{ package: file }] }));
};

test('events: a notify listener never runs on a change, and a change listener never on notify', async () => {
  const w = await world();
  try {
    const file = path.join(w.home, 'both.js');
    const log = path.join(w.home, 'both.log');
    fs.writeFileSync(
      file,
      `exports.podApi = 2; exports.name = 'both';
exports.createPlugin = (ctx) => {
  const add = (line) => require('node:fs').appendFileSync(${JSON.stringify(log)}, line + '\\n');
  return {
    start: async () => {
      ctx.services.events.on('changed', () => add('changed'));
      ctx.services.events.on('notify', (picks) => add('notify ' + (Array.isArray(picks) ? picks.length : 'none')));
    },
    stop: async () => {},
  };
};`,
    );
    podJsonPlugin(w, file);
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    await until(() => ok(pod, 'reading.status'), (s) => s.firstReadDone && !s.readingNow, 'the read at start to end');
    await plant(pod, 'one');
    await sleep(3500);
    const lines = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
    assert.ok(lines.includes('changed'));
    assert.deepEqual(lines.filter((l) => l.startsWith('notify')), []);
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});

test('events: a notify listener that rejects is logged as a fixed sentence and raises no unhandled rejection; a throwing one does not stop the next', async () => {
  const w = await world();
  try {
    const file = path.join(w.home, 'bad.js');
    const log = path.join(w.home, 'bad.log');
    fs.writeFileSync(
      file,
      `exports.podApi = 2; exports.name = 'bad';
exports.createPlugin = (ctx) => ({
  start: async () => {
    ctx.services.events.on('notify', () => Promise.reject(new Error('MARKER')));
    ctx.services.events.on('notify', () => { throw new Error('MARKER'); });
    ctx.services.events.on('notify', (picks) => require('node:fs').appendFileSync(${JSON.stringify(log)}, picks.length + '\\n'));
  },
  stop: async () => {},
});`,
    );
    podJsonPlugin(w, file, { notify: { meraNewsApp: { enabled: true, url: 'https://relay.example.org' } } });
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    await plant(pod, 'urgent');
    await until(async () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').length : 0), (n) => n >= 1, 'the third listener to run');
    await sleep(500);
    const lines = pod.logs.filter((l) => l.includes(fixedSentence));
    assert.equal(lines.length, 2);
    assert.ok(lines.every((l) => l.trim().endsWith(fixedSentence)));
    assert.doesNotMatch(pod.logs.join('\n'), /MARKER/);
    assert.equal((await pod.ask('state')).reading, 'on');
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});
