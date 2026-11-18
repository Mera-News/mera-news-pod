import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { gql } from '@apollo/client';
import { appSchema, tableSchema } from '@nozbe/watermelondb';
import { loadConfig } from '../../src/config';
import { createNodeHost } from '../../src/host';

const dirs: string[] = [];
const servers: http.Server[] = [];
after(() => {
  servers.forEach((s) => s.close());
  dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
});

function serve(handler: http.RequestListener): Promise<string> {
  return new Promise((resolve) => {
    const s = http.createServer(handler).listen(0, '127.0.0.1', () => {
      servers.push(s);
      resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}`);
    });
  });
}

function setup(dataUrl: string, extra: object = {}, env: NodeJS.ProcessEnv = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pod-host-'));
  dirs.push(home);
  fs.writeFileSync(path.join(home, 'pod.json'), JSON.stringify({ dataServer: { url: dataUrl }, ai: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'm' }, ...extra }));
  const cfg = loadConfig(home, env);
  const lines: string[] = [];
  const made = createNodeHost(cfg, { llmTransport: { fake: true }, sink: (_l, line) => lines.push(line), minLevel: 'debug' });
  return { cfg, lines, ...made };
}

test('the three client addresses, the transport and the fixed session', async () => {
  const { host, cfg } = setup('http://127.0.0.1:3002/');
  assert.equal(host.env.EXPO_PUBLIC_GRAPHQL_SERVER_ENDPOINT, 'http://127.0.0.1:3002/graphql');
  assert.equal(host.env.EXPO_PUBLIC_INFERENCE_ENDPOINT, 'http://127.0.0.1:9');
  assert.equal(host.env.EXPO_PUBLIC_AUTH_ENDPOINT, 'http://127.0.0.1:9');
  assert.deepEqual(host.llmTransport, { fake: true });
  assert.equal(await host.auth.getJwtToken(), 'local');
  assert.equal(host.auth.getCookie(), 'local');
  assert.deepEqual(await host.netInfo.fetch(), { isConnected: true, isInternetReachable: true, type: 'other' });
  assert.equal(host.appState.currentState, 'active');
  assert.equal(cfg.paths.kvFile.endsWith('kv.json'), true);
});

test('locales come from the config, else from the system', () => {
  const set = setup('http://127.0.0.1:3002', { language: 'nl', region: 'NL' });
  assert.deepEqual(set.host.getLocales(), [{ languageTag: 'nl-NL', languageCode: 'nl', regionCode: 'NL' }]);
  const sys = setup('http://127.0.0.1:3002').host.getLocales()[0];
  assert.equal(sys.languageTag, Intl.DateTimeFormat().resolvedOptions().locale);
  assert.ok(sys.languageCode);
});

test('the client fetch reaches only the configured origins', async () => {
  const data = await serve((_req, res) => res.end('ok'));
  const { host, lines } = setup(data, { notify: { webhook: { enabled: true, url: 'http://127.0.0.1:1/hook' } } });
  assert.equal(await (await host.fetch(`${data}/x`)).text(), 'ok');
  await assert.rejects(host.fetch('http://example.com/'), { name: 'BlockedRequestError' });
  assert.ok(lines.some((l) => l.includes('blocked request to http://example.com')));
});

test('the GraphQL client sends the data key only when one is set, and a 401 is reported', async () => {
  const seen: (string | undefined)[] = [];
  const data = await serve((req, res) => {
    seen.push(req.headers['x-api-key'] as string | undefined);
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"errors":[{"message":"no"}]}');
  });
  const query = gql`query Q { hello }`;

  const keyed = setup(data, {}, { MERA_POD_DATA_API_KEY: 'DATAKEY123' });
  await assert.rejects(keyed.host.apolloClient.query({ query }));
  assert.deepEqual(seen, ['DATAKEY123']);
  assert.ok(keyed.lines.some((l) => l.includes('the data server refused the key')));
  assert.ok(keyed.lines.every((l) => !l.includes('DATAKEY123')));

  const open = setup(data);
  await assert.rejects(open.host.apolloClient.query({ query }));
  assert.equal(seen[1], undefined);
});

test('a GraphQL error is captured unless its code is expected, then it is a breadcrumb only', async () => {
  const data = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"data":null,"errors":[{"message":"gone","extensions":{"code":"NOT_FOUND"}}]}');
  });
  const query = gql`query Q { hello }`;
  const a = setup(data);
  await assert.rejects(a.host.apolloClient.query({ query }));
  assert.ok(a.lines.some((l) => l.startsWith('[error]') && l.includes('gone')));

  const b = setup(data);
  await assert.rejects(b.host.apolloClient.query({ query, context: { expectedErrorCodes: ['NOT_FOUND'] } }));
  assert.ok(!b.lines.some((l) => l.startsWith('[error]')));
  assert.ok(b.lines.some((l) => l.startsWith('[debug]') && l.includes('gone')));
});

test('the database adapter opens an absolute mera.db in the data directory and writes nothing to stdout', async () => {
  const { host, cfg } = setup('http://127.0.0.1:3002');
  fs.mkdirSync(cfg.paths.dataDir, { recursive: true });
  const schema = appSchema({ version: 1, tables: [tableSchema({ name: 'things', columns: [{ name: 'a', type: 'string' }] })] });
  const written: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => void written.push(args.join(' '));
  try {
    const adapter = host.createDatabaseAdapter({ schema, dbName: 'relative-name', jsi: true });
    await new Promise((resolve, reject) => (adapter as { batch: (ops: unknown[], cb: (r: unknown) => void) => void }).batch([], (r) => ((r as { error?: Error }).error ? reject((r as { error: Error }).error) : resolve(r))));
  } finally {
    console.log = log;
  }
  assert.ok(fs.existsSync(cfg.paths.dbFile));
  assert.deepEqual(written, []);
});
