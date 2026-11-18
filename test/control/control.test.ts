import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { killAll, startPod, world } from '../boot/helpers';

after(killAll);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (check: () => boolean | Promise<boolean>, ms: number) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await check()) return true;
  return check();
};
const reached = (w: Awaited<ReturnType<typeof world>>) => w.data.requests.length + w.model.requests.length;

test('paused: no request reaches the data server or the model, from the triggers, the lifecycle cycle or a job queued before the pause', async () => {
  const w = await world();
  try {
    // A pod that reads every second, so a resumed pod reads at once.
    const pod = startPod(w.home, { MERA_POD_INTERVAL_SECONDS: '1' });
    assert.deepEqual(await pod.first, { ready: true });
    await pod.ask('pause');
    assert.ok(await until(async () => (await pod.ask('state')).reading === 'paused', 15_000), 'the first read finished');
    // A request sent just before the pause can still be on its way to a fake: let it land, so what is
    // counted below is only what the pod sends while paused.
    await sleep(1_000);
    const before = reached(w);

    const job = await pod.ask('plant');
    await pod.ask('cycle');
    assert.equal(await pod.ask('trigger'), 'paused');
    // The queue polls at once after a notify and the scheduler ticks every 5 seconds: one tick and two polls.
    await sleep(5_500);
    assert.equal(reached(w), before, 'nothing was requested while paused');
    assert.equal(await pod.ask('job', job), 'pending');

    // Resumed, the same pod reads and the queued job reaches the model, so the silence was the pause.
    await pod.ask('resume');
    assert.ok(await until(async () => ['done', 'failed'].includes(await pod.ask('job', job)), 15_000), 'the held job ran after the pause');
    assert.equal(await pod.ask('job', job), 'done');
    assert.ok(w.model.requests.length > 0, 'the held job asked the model');
    assert.ok(await until(async () => w.data.requests.length > 0, 15_000), 'a resumed pod reads');
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});

test('reading is pausing while a run is in flight and paused once it ends', async () => {
  const w = await world();
  try {
    const pod = startPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    assert.equal((await pod.ask('state')).reading, 'on');
    // The fixture's article is new, so a real read runs at start: let it end first, since its end
    // clears the run this test plants.
    await pod.ask('pause');
    assert.ok(await until(async () => (await pod.ask('state')).reading === 'paused', 15_000), 'the read at start ended');
    await pod.ask('resume');
    await pod.ask('hold', true);
    await pod.ask('pause');
    assert.equal((await pod.ask('state')).reading, 'pausing');
    await pod.ask('hold', false);
    assert.equal((await pod.ask('state')).reading, 'paused');
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});

test('the pause and the schedule survive a restart, and an out of range schedule is refused', async () => {
  const w = await world();
  try {
    const first = startPod(w.home);
    assert.deepEqual(await first.first, { ready: true });
    assert.deepEqual(await first.ask('every', 3), { error: 'everyMinutes must be a whole number between 5 and 1440.' });
    assert.deepEqual(await first.ask('every', 1441), { error: 'everyMinutes must be a whole number between 5 and 1440.' });
    assert.equal(await first.ask('every', 30), null);
    await first.ask('pause');
    assert.equal(await first.ask('frequency'), 30 * 60_000);
    await first.ask('stop');
    assert.equal(await first.exited, 0);

    const second = startPod(w.home);
    assert.deepEqual(await second.first, { ready: true });
    const state = await second.ask('state');
    assert.equal(state.paused, true);
    assert.equal(state.everyMinutes, 30);
    assert.equal(await second.ask('frequency'), 30 * 60_000);
    assert.equal(await second.ask('trigger'), 'paused');
    await second.ask('stop');
    // Paused from the first moment: the restart never asked the data server anything.
    const asked = w.data.requests.length;
    assert.ok(asked <= 1, 'only the first run, before the pause, may have asked');
  } finally {
    await w.close();
  }
});

test("a pause does not freeze the interval: pod.json's reading.everyMinutes still applies after a restart", async () => {
  const w = await world();
  try {
    const first = startPod(w.home);
    assert.deepEqual(await first.first, { ready: true });
    await first.ask('pause');
    await first.ask('resume');
    await first.ask('stop');
    assert.equal(await first.exited, 0);
    assert.ok(fs.existsSync(path.join(w.home, 'data', 'control.json')), 'the pause wrote control.json');

    const podJson = path.join(w.home, 'pod.json');
    fs.writeFileSync(podJson, JSON.stringify({ ...JSON.parse(fs.readFileSync(podJson, 'utf8')), reading: { everyMinutes: 40 } }));
    const second = startPod(w.home);
    assert.deepEqual(await second.first, { ready: true });
    assert.equal(await second.ask('frequency'), 40 * 60_000);
    await second.ask('stop');
  } finally {
    await w.close();
  }
});
