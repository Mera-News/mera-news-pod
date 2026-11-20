import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultSchemaPath, startFakeDataServer, type FakeDataServer } from '../../src/testing';

const ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(ROOT, 'scripts', 'first-picks.mjs');

// Every run gets this as its temp folder, so a home left behind shows up here.
let tmp: string;
const servers: FakeDataServer[] = [];
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'first-picks-test-'));
});
after(async () => {
  await Promise.all(servers.map((s) => s.close()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

const serve = async (options: { chess: boolean; apiKey?: string }) => {
  const data = await startFakeDataServer({
    schemaPath: defaultSchemaPath(),
    apiKey: options.apiKey,
    articles: options.chess ? [{ _id: 'chess1', title: 'Chess champion wins the final' }] : [],
    topics: options.chess ? { 'follows chess': ['chess1'], 'chess latest': ['chess1'], 'follows news': ['chess1'] } : {},
  });
  servers.push(data);
  return data;
};

const run = (args: string[], limitMs: number) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp };
    delete env.NODE_OPTIONS;
    const child = spawn(process.execPath, [SCRIPT, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d));
    child.stderr.on('data', (d: Buffer) => (stderr += d));
    const killer = setTimeout(() => child.kill('SIGKILL'), limitMs);
    child.once('close', (code) => {
      clearTimeout(killer);
      resolve({ code, stdout, stderr });
    });
  });

test('first picks: exits 0 once a planted article becomes a pick', async () => {
  const data = await serve({ chess: true });
  const r = await run(['--data-server', data.origin, '--fact', 'Follows chess'], 120_000);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /First picks after/);
});

test('first picks: exits 1 at the timeout when nothing matches, naming the state', async () => {
  const data = await serve({ chess: false });
  const r = await run(['--data-server', `${data.origin}/graphql`, '--fact', 'Follows chess', '--timeout', '20'], 120_000);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /Last state: (ok|no_facts|topics_pending|first_read_pending|paused|problem)/);
});

test('first picks: the key goes to the data server as x-api-key and is printed nowhere', async () => {
  const key = 'marker-key-4f9c1d7a';
  // The server answers 401 without the header, and the recorder drops it, so a pick proves it arrived.
  const data = await serve({ chess: true, apiKey: key });
  const r = await run(['--data-server', data.origin, '--fact', 'Follows chess', '--api-key', key], 120_000);
  assert.equal(r.code, 0, r.stdout.replaceAll(key, '***') + r.stderr.replaceAll(key, '***'));
  assert.ok(!r.stdout.includes(key) && !r.stderr.includes(key), 'the key was printed');
  assert.ok(data.requests.length > 0);
});

test('first picks: a refused key fails the run, and the report that follows never shows it', async () => {
  const wrong = 'wrong-key-8b2e6c0f';
  const data = await serve({ chess: true, apiKey: 'the-right-key' });
  const r = await run(['--data-server', data.origin, '--fact', 'Follows chess', '--api-key', wrong, '--timeout', '15'], 120_000);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /Last state:/);
  assert.ok(!r.stdout.includes(wrong) && !r.stderr.includes(wrong), 'the key was printed');
});

test('first picks: no home is left behind', () => {
  assert.deepEqual(fs.readdirSync(tmp), []);
});
