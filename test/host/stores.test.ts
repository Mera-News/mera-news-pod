import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAsyncStorage } from '../../src/host/kv-file';
import { createSecureStore } from '../../src/host/secure-file';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pod-store-'));

test('the key-value store round-trips and removes', async () => {
  const dir = tmp();
  const kv = createAsyncStorage(path.join(dir, 'kv.json'));
  assert.equal(await kv.getItem('a'), null);
  await Promise.all([kv.setItem('a', '1'), kv.setItem('b', '2'), kv.setItem('c', '3')]);
  assert.equal(await createAsyncStorage(path.join(dir, 'kv.json')).getItem('b'), '2');
  await kv.removeItem('b');
  assert.equal(await kv.getItem('b'), null);
  assert.equal(await kv.getItem('c'), '3');
  fs.rmSync(dir, { recursive: true });
});

test('a crash between the write and the rename leaves the old contents, and a reload ignores the tmp file', async () => {
  const dir = tmp();
  const file = path.join(dir, 'kv.json');
  const kv = createAsyncStorage(file);
  await kv.setItem('a', 'old');
  fs.writeFileSync(`${file}.tmp`, '{"a":"half written');
  const reloaded = createAsyncStorage(file);
  assert.equal(await reloaded.getItem('a'), 'old');
  await reloaded.setItem('b', 'new');
  assert.equal(await reloaded.getItem('a'), 'old');
  assert.equal(fs.existsSync(`${file}.tmp`), false);
  fs.rmSync(dir, { recursive: true });
});

test('the secure store: a missing key is null, a bad file rejects and is never rewritten', async () => {
  const dir = tmp();
  const file = path.join(dir, 'secure.json');
  const store = createSecureStore(file);
  assert.equal(await store.getItemAsync('token'), null);
  await store.setItemAsync('token', 'abc');
  assert.equal(await store.getItemAsync('token'), 'abc');
  assert.equal(await store.getItemAsync('other'), null);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  fs.writeFileSync(file, '{not json');
  await assert.rejects(store.getItemAsync('token'));
  await assert.rejects(store.setItemAsync('token', 'x'));
  assert.equal(fs.readFileSync(file, 'utf8'), '{not json');
  fs.writeFileSync(file, '[]');
  await assert.rejects(store.getItemAsync('token'));
  fs.rmSync(dir, { recursive: true });
});

test('the secure store keeps mode 0600 across rewrites', async () => {
  const dir = tmp();
  const file = path.join(dir, 'secure.json');
  const store = createSecureStore(file);
  await store.setItemAsync('a', '1');
  await store.setItemAsync('a', '2');
  await store.deleteItemAsync('a');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true });
});
