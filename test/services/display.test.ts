import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { call, killAll, ok, startServicesPod, until, world, type World } from './helpers';

after(killAll);
type Pod = Parameters<typeof ok>[0];

const client = <T>(file: string) => require(`mera-news-client/dist/lib/${file}`) as T;
const { SYNC_TABLES, PHONE_ONLY_TABLES } = client<{ SYNC_TABLES: { name: string }[]; PHONE_ONLY_TABLES: string[] }>('sync/tables');

const snapshot = (pod: Pod, options: object = {}) => ok(pod, 'display.snapshot', options);
const hashesOf = (snap: { tables: Record<string, { hash: string }> }) => Object.fromEntries(Object.entries(snap.tables).map(([name, t]) => [name, t.hash]));

test('a snapshot holds every synced table with a hash and no phone-only table, whatever hashes the caller sends', async () => {
  const w = await world();
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    const snap = await snapshot(pod, { hashes: { conversations: 'x', messages: 'x', scheduler_jobs: 'x', made_up: 'x' } });
    assert.deepEqual(Object.keys(snap.tables).sort(), SYNC_TABLES.map((t) => t.name).sort());
    for (const table of Object.values<any>(snap.tables)) assert.match(table.hash, /^[0-9a-f]{64}$/);
    for (const name of PHONE_ONLY_TABLES) assert.equal(snap.tables[name], undefined, name);
    assert.ok(Number.isInteger(snap.schemaVersion) && Number.isInteger(snap.registry));
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});

test('a caller that sends the hashes it holds gets no rows, and a write to a served table changes only that table\'s hash', async () => {
  const w = await world();
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    // Boot writes settle first, so two reads in a row agree.
    let before = await snapshot(pod);
    const same = await until(
      async () => {
        const hashes = hashesOf(before);
        const next = await snapshot(pod, { hashes });
        if (Object.values<any>(next.tables).every((t) => t.rows === undefined)) return { next, hashes };
        before = next;
        return undefined;
      },
      (v) => v !== undefined,
      'the tables to settle',
    );
    assert.ok(same);
    await pod.ask('plantFact', { statement: 'Follows chess', status: 'done', topics: [{ text: 'chess' }] });
    const after = await snapshot(pod, { hashes: same!.hashes });
    assert.notEqual(after.tables.facts.hash, same!.hashes.facts);
    assert.ok(after.tables.facts.rows.length >= 1);
    assert.equal(after.tables.facts.rows[0].statement, 'Follows chess');
    assert.equal(after.tables.persona_suppressions.rows, undefined);
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});

test('a fact added through profile.addFacts changes the facts hash', async () => {
  const w = await world();
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    const before = await snapshot(pod);
    await ok(pod, 'profile.addFacts', ['Follows sailing']);
    const after = await snapshot(pod);
    assert.notEqual(after.tables.facts.hash, before.tables.facts.hash);
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});

test('a caller on another schema or registry version is refused and told which side is older', async () => {
  const w = await world();
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    const { schemaVersion: SCHEMA_VERSION, registry: COMMAND_REGISTRY_VERSION } = await snapshot(pod);
    const refused = async (peer: object) => {
      const reply = await call(pod, 'display.snapshot', { peer });
      assert.equal(reply.error?.code, 'version_mismatch', JSON.stringify(reply));
      return reply.error!.message;
    };
    assert.match(await refused({ schemaVersion: SCHEMA_VERSION - 1, registry: COMMAND_REGISTRY_VERSION }), /^The phone is older than the pod\./);
    assert.match(await refused({ schemaVersion: SCHEMA_VERSION + 1, registry: COMMAND_REGISTRY_VERSION }), /^The pod is older than the phone\./);
    assert.match(await refused({ schemaVersion: SCHEMA_VERSION, registry: COMMAND_REGISTRY_VERSION - 1 }), /^The phone is older than the pod\./);
    assert.match(await refused({ schemaVersion: SCHEMA_VERSION, registry: COMMAND_REGISTRY_VERSION + 1 }), /^The pod is older than the phone\./);
    const fine = await call(pod, 'display.snapshot', { peer: { schemaVersion: SCHEMA_VERSION, registry: COMMAND_REGISTRY_VERSION } });
    assert.equal(fine.error, undefined);
    const bad = await call(pod, 'display.snapshot', { hashes: 'nope' });
    assert.equal(bad.error?.code, 'bad_request');
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});

test('a plugin speaking 2 is given a snapshot reader and a listener, and no database handle or paused-pod difference', async () => {
  const w: World = await world();
  try {
    const file = path.join(w.home, 'plugin.js');
    fs.writeFileSync(
      file,
      `exports.podApi = 2; exports.name = 'peek';
exports.createPlugin = (ctx) => ({
  start: async () => {
    const snap = await ctx.services.display.snapshot({});
    require('node:fs').writeFileSync(require('node:path').join(ctx.dataDir, 'peek.json'), JSON.stringify({
      display: Object.keys(ctx.services.display), events: Object.keys(ctx.services.events), tables: Object.keys(snap.tables).length,
    }));
  },
  stop: async () => {},
});`,
    );
    const config = JSON.parse(fs.readFileSync(path.join(w.home, 'pod.json'), 'utf8'));
    fs.writeFileSync(path.join(w.home, 'pod.json'), JSON.stringify({ ...config, plugins: [{ package: file }] }));
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    const peek = JSON.parse(fs.readFileSync(path.join(w.home, 'data', 'plugins', 'peek', 'peek.json'), 'utf8'));
    assert.deepEqual(peek, { display: ['versions', 'snapshot'], events: ['on'], tables: SYNC_TABLES.length });
    // A paused pod still serves snapshots.
    await ok(pod, 'reading.set', { paused: true });
    assert.equal((await snapshot(pod)).tables.facts.hash.length, 64);
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});

test('versions answers the schema and registry versions a snapshot carries, without reading a table', async () => {
  const w = await world();
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    const versions = await ok(pod, 'display.versions');
    const snapshot = await ok(pod, 'display.snapshot', {});
    assert.deepEqual(versions, { schemaVersion: snapshot.schemaVersion, registry: snapshot.registry });
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});
