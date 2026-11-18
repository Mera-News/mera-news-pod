import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { call, killAll, ok, startServicesPod, until, world } from './helpers';

after(killAll);
type Pod = Parameters<typeof ok>[0];

const profile = (pod: Pod, offset?: number) => ok(pod, 'profile.get', offset === undefined ? undefined : { offset });
const settled = (pod: Pod) => until(() => profile(pod), (p) => p.facts.every((f: any) => f.topicsStatus !== 'pending'), 'topic generation to finish');

test('a fact added through the services gets topics made, and profile.get shows them nested', async () => {
  const w = await world();
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    const added = await ok(pod, 'profile.addFacts', ['  Follows chess  ']);
    assert.deepEqual(added.added.map((a: any) => a.statement), ['Follows chess']);
    assert.deepEqual([added.already, added.refused], [[], []]);
    const view = await settled(pod);
    assert.equal(view.facts.length, 1);
    assert.equal(view.facts[0].topicsStatus, 'done');
    assert.ok(view.facts[0].topics.length >= 1);
    assert.deepEqual(new Set(view.facts[0].topics.map((t: any) => t.source)), new Set(['generated']));
    assert.equal(view.nextOffset, undefined);
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});

test('a statement already saved goes to already, and one that is empty or too long saves nothing', async () => {
  const w = await world();
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    await pod.ask('plantFact', { statement: 'Follows chess', status: 'done', topics: [{ text: 'chess' }] });
    const again = await ok(pod, 'profile.addFacts', ['follows   CHESS', 'follows chess']);
    assert.equal(again.already.length, 1);
    assert.deepEqual(again.added, []);

    for (const bad of ['   ', 'x'.repeat(301)]) {
      const reply = await call(pod, 'profile.addFacts', ['Follows sailing', bad]);
      assert.match(reply.error?.message ?? '', /1 to 300 characters. Nothing was saved/);
    }
    assert.equal((await profile(pod)).facts.length, 1);
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});

test('a fact that contradicts a saved one is refused with a next step, and the rest are still saved', async () => {
  const w = await world();
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    const old = await pod.ask('plantFact', { statement: 'Works as a software engineer in Utrecht', status: 'done', topics: [{ text: 'software engineering' }] });
    const reply = await ok(pod, 'profile.addFacts', ['Works as a software engineer in Amsterdam', 'Follows chess']);
    assert.deepEqual(reply.refused, [
      {
        statement: 'Works as a software engineer in Amsterdam',
        code: 'conflict',
        conflictsWith: { id: old.id, statement: 'Works as a software engineer in Utrecht' },
        next: 'remove the fact it conflicts with first, or reword this one',
      },
    ]);
    assert.deepEqual(reply.added.map((a: any) => a.statement), ['Follows chess']);
    assert.equal((await profile(pod)).facts.length, 2, 'the refused fact was not saved');
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});

test('a fact whose topics failed is retried when it is added again, and says so', async () => {
  const w = await world();
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    const failed = await pod.ask('plantFact', { statement: 'Follows chess', status: 'error' });
    const reply = await ok(pod, 'profile.addFacts', ['Follows chess']);
    assert.deepEqual(reply.added, [{ id: failed.id, statement: 'Follows chess', retried: true }]);
    assert.deepEqual(reply.already, []);
    const view = await settled(pod);
    assert.equal(view.facts[0].topicsStatus, 'done');
    assert.ok(view.facts[0].topics.length >= 1, 'the retry made topics');
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});

test('a fact that finished with no topics is retried too', async () => {
  const w = await world();
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    const empty = await pod.ask('plantFact', { statement: 'Follows chess', status: 'done', topics: [] });
    const reply = await ok(pod, 'profile.addFacts', ['Follows chess']);
    assert.deepEqual(reply.added.map((a: any) => [a.id, a.retried]), [[empty.id, true]]);
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});

test('a home fact says local coverage is weaker only when the data server has no place lookup', async () => {
  const w = await world();
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    const status = await ok(pod, 'reading.status');
    assert.ok(status.limits.includes('place lookup'), 'the fake data server does not offer it');
    assert.equal((await ok(pod, 'profile.addFacts', ['Follows chess'])).localCoverageWeaker, undefined);
    assert.equal((await ok(pod, 'profile.addFacts', ['Lives in Utrecht'])).localCoverageWeaker, true);
    await pod.ask('stop');
  } finally {
    await w.close();
  }

  const withLookup = await world({ extraSchema: 'extend type Query { placeSearch: String }' });
  try {
    const pod = startServicesPod(withLookup.home);
    assert.deepEqual(await pod.first, { ready: true });
    assert.ok(!(await ok(pod, 'reading.status')).limits.includes('place lookup'));
    assert.equal((await ok(pod, 'profile.addFacts', ['Lives in Utrecht'])).localCoverageWeaker, undefined);
    await pod.ask('stop');
  } finally {
    await withLookup.close();
  }
});

test('a removed topic is declined, and generating topics again does not bring it back', async () => {
  const w = await world();
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    await ok(pod, 'profile.addFacts', ['Follows chess']);
    const before = (await settled(pod)).facts[0];
    const victim = before.topics[0];
    const result = await ok(pod, 'profile.editTopics', { remove: [victim.id, 'no-such-topic'] });
    assert.deepEqual(result.results, [
      { op: 'remove', index: 0, ok: true, id: victim.id },
      { op: 'remove', index: 1, ok: false, id: 'no-such-topic', error: 'no topic with this id' },
    ]);
    const after = (await profile(pod)).facts[0];
    assert.ok(!after.topics.some((t: any) => t.id === victim.id), 'the topic is gone at once');

    await pod.ask('regenerate', before.id);
    const regenerated = (await settled(pod)).facts[0];
    assert.ok(!regenerated.topics.some((t: any) => t.text === victim.text), 'the declined text did not come back');
    assert.ok(regenerated.topics.length >= 1);
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});

test('topic weights are set, kept inside -1 to 1, and a bad one is reported per entry', async () => {
  const w = await world();
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    const { topicIds } = await pod.ask('plantFact', { statement: 'Follows chess', status: 'done', topics: [{ text: 'chess' }, { text: 'openings' }] });
    const result = await ok(pod, 'profile.editTopics', {
      weight: [{ topicId: topicIds[0], weight: 5 }, { topicId: topicIds[1], weight: -0.5 }, { topicId: 'missing', weight: 0.2 }, { topicId: topicIds[0], weight: Number.NaN }],
    });
    assert.deepEqual(result.results.map((r: any) => [r.index, r.ok]), [[0, true], [1, true], [2, false], [3, false]]);
    const topics = (await profile(pod)).facts[0].topics;
    assert.equal(topics.find((t: any) => t.id === topicIds[0]).weight, 1);
    assert.equal(topics.find((t: any) => t.id === topicIds[1]).weight, -0.5);
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});

test('a topic says where it came from: generated, added or followed', async () => {
  const w = await world();
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    await pod.ask('plantFact', {
      statement: 'Follows chess',
      status: 'done',
      topics: [{ text: 'a', provenance: 'llm' }, { text: 'b', provenance: 'migration' }, { text: 'c', provenance: 'exploration' }, { text: 'd', provenance: 'user' }, { text: 'e', provenance: 'feedback' }, { text: 'f', provenance: 'tracked' }],
    });
    const bySource = Object.fromEntries((await profile(pod)).facts[0].topics.map((t: any) => [t.text, t.source]));
    assert.deepEqual(bySource, { a: 'generated', b: 'generated', c: 'generated', d: 'added', e: 'added', f: 'followed' });
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});

test('removing facts returns what was removed with its topics, and names the ids it did not find', async () => {
  const w = await world();
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    const fact = await pod.ask('plantFact', { statement: 'Follows chess', status: 'done', topics: [{ text: 'chess' }, { text: 'openings' }] });
    const result = await ok(pod, 'profile.removeFacts', [fact.id, 'gone']);
    assert.deepEqual(result.removed, [{ id: fact.id, statement: 'Follows chess', topics: ['chess', 'openings'] }]);
    assert.deepEqual(result.notFound, ['gone']);
    assert.deepEqual((await profile(pod)).facts, []);
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});

test('facts are paged by 50 with nextOffset until the last page', async () => {
  const w = await world();
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    for (let i = 0; i < 52; i++) await pod.ask('plantFact', { statement: `Interest number ${i}`, status: 'done', topics: [] });
    const first = await profile(pod);
    assert.equal(first.facts.length, 50);
    assert.equal(first.nextOffset, 50);
    const second = await profile(pod, 50);
    assert.equal(second.facts.length, 2);
    assert.equal(second.nextOffset, undefined);
    const ids = new Set([...first.facts, ...second.facts].map((f: any) => f.id));
    assert.equal(ids.size, 52, 'no fact on two pages');
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});

test('a fact whose topics are ready starts a read at once, once, and not while reading is paused', async () => {
  const w = await world();
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    assert.equal(await pod.ask('lastTrigger'), null);
    // The fact is written straight to the database, so only the pod's own watcher can notice it. The
    // schedule would pick it up within seconds anyway, which is why this looks at who asked.
    await pod.ask('plantFact', { statement: 'Follows chess', status: 'done', topics: [{ text: 'chess' }] });
    const asked = await until(() => pod.ask('lastTrigger'), (t) => t !== null, 'the pod to ask for a read');
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(await pod.ask('lastTrigger'), asked, 'asked once for this fact');

    await until(() => ok(pod, 'reading.status'), (s) => !s.readingNow, 'that read to end');
    await ok(pod, 'reading.set', { paused: true });
    const reads = () => w.data.requests.length;
    const before = reads();
    await pod.ask('plantFact', { statement: 'Follows sailing', status: 'done', topics: [{ text: 'sailing' }] });
    await new Promise((r) => setTimeout(r, 2000));
    assert.equal(await pod.ask('lastTrigger'), asked, 'a paused pod is not asked to read');
    assert.equal(reads(), before, 'and makes no request');
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});
