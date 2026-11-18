import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireLock } from '../../src/host/lock';
import { defaultSchemaPath, startFakeDataServer } from '../../src/testing';
import { fixture, killAll, world } from './helpers';

after(killAll);

interface Run {
  out: string[];
  err: string[];
  exited: Promise<number | null>;
  running: Promise<void>;
  signal(s: NodeJS.Signals): void;
}

function cli(home: string, args: string[], env: NodeJS.ProcessEnv = {}): Run {
  const proc = spawn(process.execPath, ['--import', 'tsx', fixture('cli-child.ts'), ...args], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, MERA_POD_HOME: home, ...env } });
  const out: string[] = [];
  const err: string[] = [];
  let seen!: () => void;
  const running = new Promise<void>((r) => (seen = r));
  proc.stdout!.on('data', (d) => {
    out.push(...String(d).trim().split('\n'));
    if (out.some((l) => l.startsWith('The pod is running'))) seen();
  });
  proc.stderr!.on('data', (d) => err.push(...String(d).trim().split('\n')));
  const exited = new Promise<number | null>((r) => proc.once('exit', r));
  // A failed test leaves nothing running: the child also ends when this process does.
  process.once('exit', () => proc.kill('SIGKILL'));
  return { out, err, exited, running, signal: (s) => proc.kill(s) };
}

test('init writes a starting config with a private mode, a random topic, and refuses to overwrite', async () => {
  const home = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pod-init-')), 'home');
  try {
    const first = cli(home, ['init']);
    assert.equal(await first.exited, 0);
    const config = JSON.parse(fs.readFileSync(path.join(home, 'pod.json'), 'utf8'));
    assert.match(config.notify.ntfy.url, /^https:\/\/ntfy\.sh\/mera-[a-z2-7]{24}$/);
    assert.equal(config.notify.ntfy.enabled, false);
    assert.ok(config.language);
    assert.equal(fs.statSync(path.join(home, 'secrets.json')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(home).mode & 0o777, 0o700);
    const again = cli(home, ['init']);
    assert.equal(await again.exited, 1);
    assert.match(again.err.join('\n'), /pod\.json already exists, so nothing was changed\.$/);
  } finally {
    fs.rmSync(path.dirname(home), { recursive: true, force: true });
  }
});

test('check answers for both servers, prints one plain line per failure and exits 1', async () => {
  const w = await world();
  try {
    const good = cli(w.home, ['check']);
    assert.equal(await good.exited, 0);
    assert.deepEqual(good.out, ['Everything answered.']);
    assert.equal(w.data.requests.length, 1);
    assert.equal(w.model.bodies.length, 1);
    assert.equal((w.model.bodies[0] as { max_tokens?: number }).max_tokens, 4);

    await w.model.close();
    const bad = cli(w.home, ['check']);
    assert.equal(await bad.exited, 1);
    assert.equal(bad.out.length, 1);
    assert.match(bad.out[0], /^The model endpoint at 127\.0\.0\.1:\d+ did not answer\. Check ai\.baseUrl in pod\.json/);
  } finally {
    await w.data.close();
    fs.rmSync(w.home, { recursive: true, force: true });
  }
});

test('check names a refused data key without printing it', async () => {
  const w = await world();
  try {
    await w.data.close();
    const keyed = await startFakeDataServer({ schemaPath: defaultSchemaPath(), apiKey: 'right-key', articles: [], topics: {} });
    fs.writeFileSync(path.join(w.home, 'pod.json'), JSON.stringify({ dataServer: { url: keyed.origin }, ai: { baseUrl: w.model.baseUrl, model: 'm' } }));
    fs.writeFileSync(path.join(w.home, 'secrets.json'), JSON.stringify({ dataApiKey: 'wrong-key' }), { mode: 0o600 });
    const run = cli(w.home, ['check']);
    assert.equal(await run.exited, 1);
    assert.deepEqual(run.out, [`The data server at ${new URL(keyed.origin).host} refused the key. Set dataApiKey in secrets.json.`]);
    assert.ok(!run.out.concat(run.err).join('').includes('wrong-key'));
    await keyed.close();
  } finally {
    await w.model.close();
    fs.rmSync(w.home, { recursive: true, force: true });
  }
});

test('start runs, reports it, and SIGTERM ends it with exit 0 and the lock released', async () => {
  const w = await world();
  try {
    const run = cli(w.home, ['start']);
    await run.running;
    assert.match(run.out.join('\n'), /The pod is running and reads every 15 minutes\./);
    run.signal('SIGTERM');
    assert.equal(await run.exited, 0);
    acquireLock(path.join(w.home, 'data', 'pod.lock.db')).release();
  } finally {
    await w.close();
  }
});

test('start prints the problem and exits 1 when a server does not answer, before it opens anything', async () => {
  const w = await world();
  try {
    await w.data.close();
    const run = cli(w.home, ['start']);
    assert.equal(await run.exited, 1);
    assert.match(run.err.join('\n'), /^The data server at 127\.0\.0\.1:\d+ did not answer\./);
    assert.ok(!fs.existsSync(path.join(w.home, 'data', 'mera.db')));
  } finally {
    await w.model.close();
    fs.rmSync(w.home, { recursive: true, force: true });
  }
});

test('an unknown command prints the usage line', async () => {
  const run = cli(os.tmpdir(), ['nonsense']);
  assert.equal(await run.exited, 1);
  assert.deepEqual(run.err, ['Usage: mera-news-pod init | check | start']);
});
