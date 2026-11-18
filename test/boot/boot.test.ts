import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { acquireLock } from '../../src/host/lock';
import { fixture, killAll, startPod, world } from './helpers';

after(killAll);

const rows = (home: string, sql: string) => {
  const db = new DatabaseSync(path.join(home, 'data', 'mera.db'), { readOnly: true });
  try {
    return db.prepare(sql).all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
};
const sha = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('a fresh start seeds the local reader once, and a restart keeps the data', async () => {
  const w = await world();
  try {
    const first = startPod(w.home);
    assert.deepEqual(await first.first, { ready: true });
    await first.ask('stop');
    assert.equal(await first.exited, 0);

    const persona = rows(w.home, 'select * from user_personas');
    assert.equal(persona.length, 1);
    assert.equal(persona[0].user_id, 'local');
    assert.equal(persona[0].processing_mode, 'CLOUD');
    assert.equal(persona[0].onboarding_stage, 'FINISHED');
    assert.equal(persona[0].language_codes_json, '["en"]');
    const settings = Object.fromEntries(rows(w.home, 'select key, value from settings').map((r) => [r.key, r.value]));
    assert.equal(settings.cached_user_id, 'local');
    assert.equal(settings.mera_web_search_in_chat, 'false');
    assert.equal(settings.app_language, 'en');

    const second = startPod(w.home);
    assert.deepEqual(await second.first, { ready: true });
    await second.ask('stop');
    assert.equal(await second.exited, 0);
    const again = rows(w.home, 'select * from user_personas');
    assert.equal(again.length, 1);
    assert.equal(again[0].id, persona[0].id, 'the seeded row is the same row');
    assert.equal(again[0].created_at, persona[0].created_at);
    assert.equal(rows(w.home, `select key from settings where key = 'mera_web_search_in_chat'`).length, 1);
  } finally {
    await w.close();
  }
});

test('a seed cut off before it finished runs again on the next start and leaves one reader', async () => {
  const w = await world();
  try {
    const first = startPod(w.home);
    assert.deepEqual(await first.first, { ready: true });
    await first.ask('stop');
    assert.equal(await first.exited, 0);
    // The seed writes cached_user_id last: without it the seed counts as unfinished.
    const db = new DatabaseSync(path.join(w.home, 'data', 'mera.db'));
    db.exec("delete from settings where key = 'cached_user_id'");
    db.close();

    const second = startPod(w.home);
    assert.deepEqual(await second.first, { ready: true });
    await second.ask('stop');
    assert.equal(rows(w.home, 'select * from user_personas').length, 1);
    assert.equal(rows(w.home, "select value from settings where key = 'cached_user_id'")[0]?.value, 'local');
  } finally {
    await w.close();
  }
});

test('web search in chat stays off after the client has hydrated its settings', async () => {
  const w = await world();
  try {
    const pod = startPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    assert.deepEqual(await pod.ask('web'), { store: false, row: 'false' });
    await pod.ask('stop');
    // And again after a restart, when the client hydrates a stored row instead of a seeded one.
    const again = startPod(w.home);
    assert.deepEqual(await again.first, { ready: true });
    assert.deepEqual(await again.ask('web'), { store: false, row: 'false' });
    await again.ask('stop');
  } finally {
    await w.close();
  }
});

test('a second pod on the same home refuses to start and the first keeps running', async () => {
  const w = await world();
  try {
    const first = startPod(w.home);
    assert.deepEqual(await first.first, { ready: true });
    const second = startPod(w.home);
    assert.deepEqual(await second.first, { error: 'another pod is running on this home' });
    assert.equal(await second.exited, 1);
    assert.equal((await first.ask('state')).reading, 'on');
    await first.ask('stop');
    assert.equal(await first.exited, 0);
  } finally {
    await w.close();
  }
});

test('a database from a newer version refuses to start and is left byte for byte as it was', async () => {
  const w = await world();
  try {
    fs.mkdirSync(path.join(w.home, 'data'));
    const file = path.join(w.home, 'data', 'mera.db');
    const db = new DatabaseSync(file);
    db.exec('create table t (a); pragma user_version = 9999');
    db.close();
    const before = sha(file);
    const before_files = fs.readdirSync(path.join(w.home, 'data')).sort();

    const pod = startPod(w.home);
    assert.deepEqual(await pod.first, { error: 'this database was written by a newer version, refusing to start' });
    assert.equal(await pod.exited, 1);
    assert.equal(sha(file), before);
    assert.deepEqual(fs.readdirSync(path.join(w.home, 'data')).sort(), before_files.concat('pod.lock.db').sort());
    acquireLock(path.join(w.home, 'data', 'pod.lock.db')).release();
    assert.equal(w.data.requests.length + w.model.requests.length, 0);
  } finally {
    await w.close();
  }
});

test('a client module loaded before the host is registered is caught and named', async () => {
  const w = await world();
  try {
    const pod = startPod(w.home, {}, fixture('early-client.ts'));
    const result = await pod.first;
    assert.match(result.error ?? '', /^the client was loaded before the host was registered: .*database-store\.js$/);
    assert.equal(await pod.exited, 1);
    acquireLock(path.join(w.home, 'data', 'pod.lock.db')).release();
  } finally {
    await w.close();
  }
});
