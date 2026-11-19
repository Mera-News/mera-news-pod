import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigError, loadConfig, podHome } from '../../src/config';

function home(podJson: unknown, secrets?: unknown, secretsMode = 0o600): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pod-config-'));
  fs.writeFileSync(path.join(dir, 'pod.json'), JSON.stringify(podJson));
  if (secrets !== undefined) {
    const file = path.join(dir, 'secrets.json');
    fs.writeFileSync(file, JSON.stringify(secrets));
    fs.chmodSync(file, secretsMode);
  }
  return dir;
}

const minimal = { dataServer: { url: 'http://127.0.0.1:3002' }, ai: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b' } };

test('the home comes from MERA_POD_HOME, else ~/.mera-news-pod', () => {
  assert.equal(podHome({ MERA_POD_HOME: '/tmp/x' }), '/tmp/x');
  assert.equal(podHome({}), path.join(os.homedir(), '.mera-news-pod'));
});

test('defaults, absolute paths and the GraphQL address with or without /graphql', () => {
  const dir = home(minimal);
  const c = loadConfig(dir, {});
  assert.equal(c.dataServer.graphqlUrl, 'http://127.0.0.1:3002/graphql');
  assert.equal(c.dataServer.origin, 'http://127.0.0.1:3002');
  assert.equal(c.dataServer.apiKey, undefined);
  assert.equal(c.reading.everyMinutes, 15);
  assert.equal(c.ai.origin, 'http://127.0.0.1:11434');
  assert.equal(c.paths.dbFile, path.join(dir, 'data', 'mera.db'));
  assert.ok(path.isAbsolute(c.paths.dbFile));
  assert.deepEqual(c.plugins, []);

  const withPath = loadConfig(home({ ...minimal, dataServer: { url: 'https://news.example.org/graphql/' } }), {});
  assert.equal(withPath.dataServer.graphqlUrl, 'https://news.example.org/graphql');
});

test('secrets come from secrets.json, env wins, and every value is listed for redaction', () => {
  const dir = home(minimal, { aiApiKey: 'file-ai', dataApiKey: 'file-data' });
  const c = loadConfig(dir, { MERA_POD_AI_API_KEY: 'env-ai' });
  assert.equal(c.ai.apiKey, 'env-ai');
  assert.equal(c.dataServer.apiKey, 'file-data');
  assert.deepEqual([...c.secrets].sort(), ['env-ai', 'file-data']);
});

test('a secrets file others can read is refused', () => {
  const dir = home(minimal, { aiApiKey: 'k' }, 0o644);
  assert.throws(() => loadConfig(dir, {}), (e: unknown) => e instanceof ConfigError && /secrets\.json/.test((e as Error).message));
});

test('plain errors for a missing file, a bad address and an interval out of range', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'pod-config-'));
  assert.throws(() => loadConfig(empty, {}), /mera-news-pod init/);
  assert.throws(() => loadConfig(home({ ...minimal, ai: { baseUrl: 'ftp://x', model: 'm' } }), {}), /ai\.baseUrl/);
  assert.throws(() => loadConfig(home({ ...minimal, reading: { everyMinutes: 2 } }), {}), /between 5 and 1440/);
  assert.throws(() => loadConfig(home({ ...minimal, plugins: [{ package: '' }] }), {}), /plugins/);
});

test('notify.meraNewsApp on needs an https origin, and the error names the key', () => {
  const on = (url: unknown) => home({ ...minimal, notify: { meraNewsApp: { enabled: true, url } } });
  assert.deepEqual(loadConfig(on('https://relay.example.org'), {}).notify.meraNewsApp, { origin: 'https://relay.example.org' });
  assert.deepEqual(loadConfig(on('HTTPS://Relay.Example.org:443'), {}).notify.meraNewsApp, { origin: 'https://relay.example.org' });
  for (const bad of ['http://relay.example.org', 'https://relay.example.org/api', 'https://relay.example.org/?a=1', 'https://u:p@relay.example.org', 'https://relay.example.org/#x', 'not a url', undefined, 1]) {
    assert.throws(
      () => loadConfig(on(bad), {}),
      (e: Error) => e instanceof ConfigError && e.message === 'notify.meraNewsApp.url must be an https origin, such as https://relay.example.org.',
      String(bad),
    );
  }
});

test('notify.meraNewsApp off when absent, disabled, or wakeRelay alone is set', () => {
  assert.equal(loadConfig(home(minimal), {}).notify.meraNewsApp, undefined);
  assert.equal(loadConfig(home({ ...minimal, notify: {} }), {}).notify.meraNewsApp, undefined);
  assert.equal(loadConfig(home({ ...minimal, notify: { meraNewsApp: { enabled: false, url: 'https://relay.example.org' } } }), {}).notify.meraNewsApp, undefined);
  const old = loadConfig(home({ ...minimal, wakeRelay: 'https://relay.example.org' }), {}) as unknown as Record<string, unknown>;
  assert.equal(old.wakeRelay, undefined);
  assert.equal((old.notify as { meraNewsApp?: unknown }).meraNewsApp, undefined);
});
