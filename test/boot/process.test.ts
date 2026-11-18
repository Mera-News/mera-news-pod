import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { acquireLock } from '../../src/host/lock';
import { killAll, startPod, world } from './helpers';

after(killAll);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('an unhandled rejection is logged once per stack and the pod keeps running', async () => {
  const w = await world();
  try {
    const pod = startPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    await pod.ask('reject');
    await sleep(200);
    assert.equal((await pod.ask('state')).rejections, 3);
    const lines = pod.logs.filter((l) => l.includes('background failure'));
    assert.equal(lines.length, 1);
    assert.equal(pod.logs.filter((l) => l.includes('another failure')).length, 1);
    assert.match(lines[0], /^A background task failed and the pod went on: Error: background failure/);
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});

test('an uncaught exception ends the pod with a non-zero code', async () => {
  const w = await world();
  try {
    const pod = startPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    await pod.ask('throw');
    assert.equal(await pod.exited, 1);
    assert.ok(pod.logs.some((l) => l.startsWith('The pod hit an unexpected error and is stopping: Error: unexpected')));
  } finally {
    await w.close();
  }
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  test(`${signal} stops the plugins, then the client, releases the lock and exits 0`, async () => {
    const w = await world();
    try {
      const log = path.join(w.home, 'stop.log');
      fs.writeFileSync(path.join(w.home, 'p.js'), `exports.podApi = 1; exports.name = 'p'; exports.createPlugin = () => ({ start: async () => {}, stop: async () => require('node:fs').appendFileSync(${JSON.stringify(log)}, 'plugin stopped\\n') });`);
      fs.writeFileSync(path.join(w.home, 'pod.json'), JSON.stringify({ dataServer: { url: w.data.origin }, ai: { baseUrl: w.model.baseUrl, model: 'm' }, language: 'en', plugins: [{ package: './p.js' }] }));
      const pod = startPod(w.home);
      assert.deepEqual(await pod.first, { ready: true });
      pod.proc.kill(signal);
      assert.equal(await pod.exited, 0);
      assert.equal(fs.readFileSync(log, 'utf8'), 'plugin stopped\n');
      acquireLock(path.join(w.home, 'data', 'pod.lock.db')).release();
    } finally {
      await w.close();
    }
  });
}
