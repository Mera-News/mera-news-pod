import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { call, killAll, ok, startServicesPod, until, world } from './helpers';
import { defaultSchemaPath, startFakeDataServer } from '../../src/testing';

after(killAll);

test('status says what the pod is and what it talks to, without secrets or fact text', async () => {
  const w = await world();
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    await pod.ask('plantFact', { statement: 'Follows chess', status: 'done', topics: [{ text: 'chess' }] });
    await pod.ask('plantFact', { statement: 'Follows sailing', status: 'pending' });
    await pod.ask('plant', [{ id: 'one' }]);
    const status = await until(() => ok(pod, 'reading.status'), (s) => !s.readingNow, 'the read at start to end');
    assert.equal(status.reading, 'on');
    assert.equal(status.everyMinutes, 15);
    assert.equal(status.counts.facts, 2);
    assert.equal(status.counts.topics, 1);
    assert.equal(status.counts.topicsPending, 1);
    assert.equal(status.counts.picks, 1);
    assert.equal(typeof status.unscored, 'number');
    assert.deepEqual(status.ai, { host: new URL(w.model.baseUrl).host, model: 'm' });
    assert.deepEqual(status.dataServer, { host: new URL(w.data.origin).host });
    assert.deepEqual(status.limits, ['followed stories', 'place lookup', 'story grouping refresh', 'world headlines']);
    assert.doesNotMatch(JSON.stringify(status), /chess|sailing/);
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});

test('pausing and resuming change the reading state and are kept across a restart', async () => {
  const w = await world();
  try {
    const first = startServicesPod(w.home);
    assert.deepEqual(await first.first, { ready: true });
    await ok(first, 'reading.set', { paused: true });
    const paused = await until(() => ok(first, 'reading.status'), (s) => s.reading === 'paused', 'reading to be paused');
    assert.equal(paused.nextReadAt, null);
    await first.ask('stop');

    const second = startServicesPod(w.home);
    assert.deepEqual(await second.first, { ready: true });
    assert.equal((await ok(second, 'reading.status')).reading, 'paused');
    const resumed = await ok(second, 'reading.set', { paused: false });
    assert.equal(resumed.reading, 'on');
    await second.ask('stop');
  } finally {
    await w.close();
  }
});

test('the schedule changes, and a value outside 5 to 1440 minutes is refused and changes nothing', async () => {
  const w = await world();
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    assert.equal((await ok(pod, 'reading.set', { everyMinutes: 30 })).everyMinutes, 30);
    for (const bad of [4, 1441, 7.5]) {
      const reply = await call(pod, 'reading.set', { everyMinutes: bad });
      assert.match(reply.error?.message ?? '', /between 5 and 1440/);
    }
    assert.equal((await ok(pod, 'reading.status')).everyMinutes, 30);
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});

test('a data server that will not describe itself is reported as missing every optional feature', async () => {
  const w = await world();
  const keyed = await startFakeDataServer({ schemaPath: defaultSchemaPath(), apiKey: 'right-key', articles: [], topics: {} });
  try {
    fs.writeFileSync(path.join(w.home, 'pod.json'), JSON.stringify({ dataServer: { url: keyed.origin }, ai: { baseUrl: w.model.baseUrl, model: 'm' }, language: 'en' }));
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    const status = await ok(pod, 'reading.status');
    assert.deepEqual(status.limits, ['followed stories', 'place lookup', 'story grouping refresh', 'windowed headlines', 'world headlines']);
    await pod.ask('stop');
  } finally {
    await keyed.close();
    await w.close();
  }
});

test('a pick history that cannot be read is listed as a problem that names the file it was moved to', async () => {
  const w = await world();
  try {
    const data = path.join(w.home, 'data');
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(data, 'picks.json'), '{"epoch":');
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    const status = await ok(pod, 'reading.status');
    const problem = status.problems.find((p: any) => p.code === 'picks_history_reset');
    assert.ok(problem, JSON.stringify(status.problems));
    assert.equal(problem.who, 'person');
    assert.ok(problem.fix.includes(path.join(data, 'picks.json.unreadable')), problem.fix);
    assert.ok(fs.existsSync(path.join(data, 'picks.json.unreadable')));
    // Not a reason to stop reading: the reply still says what the pod is doing.
    assert.equal((await ok(pod, 'suggestions.get', { limit: 5 })).state, 'no_facts');
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});
