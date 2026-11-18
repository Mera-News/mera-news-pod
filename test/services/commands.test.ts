import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { call, killAll, ok, startServicesPod, until, world } from './helpers';

after(killAll);
type Pod = Parameters<typeof ok>[0];

const REGISTRY = 3;
const SCHEMA = (require('mera-news-client/dist/lib/database/schema') as { default: { version: number } }).default.version;
const run = (pod: Pod, commands: { name: string; args?: unknown[] }[], extra: object = {}) =>
  ok(pod, 'commands.run', { schemaVersion: SCHEMA, registry: REGISTRY, hashes: {}, commands, ...extra });
const rows = (reply: any, table: string): any[] => reply.snapshot.tables[table].rows ?? [];
const empty = (pod: Pod) => run(pod, []);

test('a batch runs the registered writers in order and answers one result per command, with the changed tables', async () => {
  const w = await world();
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    const reply = await run(pod, [
      { name: 'addFact', args: ['Follows chess', null, null, { topicsStatus: 'done' }] },
      { name: 'setSetting', args: ['app_language', 'nl'] },
    ]);
    assert.equal(reply.results.length, 2);
    const facts = rows(reply, 'facts');
    assert.deepEqual(facts.map((f) => f.statement), ['Follows chess']);
    // A model the writer returned crosses as its id.
    assert.equal(reply.results[0].ok.id, facts[0].id);
    assert.deepEqual(rows(reply, 'settings').filter((r) => r.key === 'app_language').map((r) => r.value), ['nl']);
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});

test('a list of models comes back as ids, and the snapshot skips tables the caller already holds', async () => {
  const w = await world();
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    const fact = await pod.ask('plantFact', { statement: 'Follows chess', status: 'done', topics: [{ text: 'chess' }] });
    const before = await empty(pod);
    const reply = await run(
      pod,
      [{ name: 'createTopics', args: [[{ factId: fact.id, text: 'rook endgames', weight: 1, provenance: 'user' }]] }],
      { hashes: { declined_topics: before.snapshot.tables.declined_topics.hash } },
    );
    const topicRows = rows(reply, 'topics');
    assert.deepEqual(reply.results[0].ok.ids, topicRows.filter((t) => t.text === 'rook endgames').map((t) => t.id));
    assert.equal(reply.snapshot.tables.declined_topics.rows, undefined, 'declined topics did not change and the caller holds them');
    assert.ok(reply.snapshot.tables.topics.rows, 'topics changed');
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});

test('a change made by a command still starts the first read when its topics are ready', async () => {
  const w = await world();
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    assert.equal(await pod.ask('lastTrigger'), null);
    const reply = await run(pod, [{ name: 'commitFactChoices', args: [[{ statement: 'Follows chess' }]] }]);
    assert.ok('ok' in reply.results[0], JSON.stringify(reply.results[0]));
    await until(() => pod.ask('lastTrigger'), (t) => t !== null, 'the pod to ask for a read after the topics were made');
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});

test('an unknown command is refused and nothing after it runs', async () => {
  const w = await world();
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    for (const name of ['noSuchCommand', 'constructor']) {
      const reply = await run(pod, [
        { name: 'setSetting', args: ['app_language', 'nl'] },
        { name },
        { name: 'addFact', args: ['Follows chess'] },
      ]);
      assert.deepEqual(reply.results.map((r: any) => r.ok !== undefined || r.error.code), [true, 'unknown_command', 'earlier_change_failed']);
      assert.equal(rows(reply, 'facts').length, 0);
      assert.equal(rows(reply, 'settings').length, 1, 'the one before it ran');
    }
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});

test('a failing command stops the batch, and its error holds a code and no argument value', async () => {
  const w = await world();
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    const reply = await run(pod, [
      { name: 'deleteTopicWithDecline', args: ['ZZ-secret-topic-id'] },
      { name: 'addFact', args: ['ZZ-secret-statement'] },
    ]);
    assert.equal(reply.results[0].error.code, 'failed');
    assert.equal(reply.results[1].error.code, 'earlier_change_failed');
    assert.doesNotMatch(JSON.stringify(reply.results), /ZZ-secret/);
    assert.equal(rows(reply, 'facts').length, 0);
    await new Promise((r) => setTimeout(r, 300));
    assert.doesNotMatch(pod.logs.join('\n'), /ZZ-secret/, 'no argument reaches a log');
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});

test('a different registry or schema version is refused before anything runs, naming the older side', async () => {
  const w = await world();
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    const cases = [
      [{ registry: REGISTRY - 1, schemaVersion: SCHEMA }, 'phone'],
      [{ registry: REGISTRY + 1, schemaVersion: SCHEMA }, 'pod'],
      [{ registry: REGISTRY, schemaVersion: SCHEMA - 1 }, 'phone'],
      [{ registry: REGISTRY, schemaVersion: SCHEMA + 1 }, 'pod'],
    ] as const;
    for (const [versions, which] of cases) {
      const reply = await call(pod, 'commands.run', { ...versions, hashes: {}, commands: [{ name: 'addFact', args: ['Follows chess'] }] });
      assert.equal(reply.error?.code, 'version_mismatch');
      assert.match(reply.error!.message, new RegExp(`The ${which} is older`));
    }
    assert.equal(await pod.ask('rowCount', 'facts'), 0);
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});

test('commands run while paused, and a read now answers paused without asking the data server', async () => {
  const w = await world();
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    await until(() => ok(pod, 'reading.status'), (s) => !s.readingNow, 'the first read to end');
    await ok(pod, 'reading.set', { paused: true });
    await until(() => ok(pod, 'reading.status'), (s) => s.reading === 'paused', 'reading to be paused');
    const asked = w.data.requests.length;
    const reply = await run(pod, [{ name: 'addFact', args: ['Follows chess'] }, { name: 'resync' }]);
    assert.equal(rows(reply, 'facts').length, 1, 'the change was made');
    assert.deepEqual(reply.results[1], { ok: 'paused' });
    assert.equal(await ok(pod, 'reading.readNow'), 'paused');
    assert.equal(w.data.requests.length, asked);
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});

test('a read now while reading is on asks for a read and answers what the scheduler answered', async () => {
  const w = await world();
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    await until(() => ok(pod, 'reading.status'), (s) => !s.readingNow, 'the first read to end');
    assert.equal(await ok(pod, 'reading.readNow'), 'ran');
    assert.notEqual(await pod.ask('lastTrigger'), null);
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});

test('a topic delete honours the undo window: an undo inside it restores the same row, and without one the row is gone after it', async () => {
  const w = await world();
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    const fact = await pod.ask('plantFact', { statement: 'Follows chess', status: 'done', topics: [{ text: 'chess' }, { text: 'sailing' }] });
    const [kept, dropped] = fact.topicIds;
    const staged = await run(pod, [
      { name: 'deleteTopicWithDecline', args: [kept, { undoWindowMs: 1000 }] },
      { name: 'deleteTopicWithDecline', args: [dropped, { undoWindowMs: 1000 }] },
    ]);
    assert.deepEqual(rows(staged, 'topics').map((t) => t.pending_delete_at != null), [true, true]);
    const undone = await run(pod, [{ name: 'undoPendingDelete', args: [kept] }]);
    assert.deepEqual(undone.results[0], { ok: true });
    await new Promise((r) => setTimeout(r, 1500));
    const after = await run(pod, []);
    assert.deepEqual(rows(after, 'topics').map((t) => [t.id, t.pending_delete_at]), [[kept, null]]);
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});

test('the marks command applies opens, visits, seen marks, watermarks and card state', async () => {
  const w = await world();
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    const reply = await run(pod, [
      {
        name: 'marks',
        args: [
          {
            opens: [{ articleId: 'a1', surface: 'feed' }],
            visits: [{ publicationName: 'Paper One', articleId: 'a1', articleUrl: 'https://example.com/a1' }],
            seen: ['no-such-story'],
            watermarks: [{ id: 'no-such-story', ms: 5 }],
            cardState: { a1: { state: 'viewed', at: 5 } },
          },
        ],
      },
    ]);
    assert.ok('ok' in reply.results[0], JSON.stringify(reply.results[0]));
    assert.deepEqual(rows(reply, 'story_impressions').map((r) => [r.article_id, r.opened]), [['a1', 1]]);
    assert.deepEqual(rows(reply, 'publication_visits').map((r) => r.publication_name), ['Paper One']);
    assert.deepEqual(rows(reply, 'settings').filter((r) => r.key === 'feed_card_state_v1').map((r) => JSON.parse(r.value)), [{ states: { a1: ['v', 5] } }]);
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});

test('seen marks and a watermark reach a real followed story', async () => {
  const w = await world();
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    await pod.ask('plant', [{ id: 'story-a', title: 'Chess olympiad opens in Budapest' }]);
    const subject = { origin: 'suggestion', surface: 'for_you', articleId: 'story-a', title: 'Chess olympiad opens in Budapest', pubDate: new Date().toISOString(), publicationName: 'Paper story-a' };
    const followed = await run(pod, [{ name: 'trackStoryWithProposal', args: [subject, { label: 'Chess', searchText: 'chess olympiad' }] }]);
    assert.ok('ok' in followed.results[0], JSON.stringify(followed.results[0]));
    const [story] = rows(followed, 'tracked_stories');
    assert.ok(story, 'a followed story exists');
    // A following stamps the story's watermark, and the writer keeps the larger one, so mark a later time.
    const later = Number(story.seen_pub_watermark_ms ?? 0) + 60_000;
    const marked = await run(pod, [{ name: 'marks', args: [{ opens: [], visits: [], seen: [story.id], watermarks: [{ id: story.id, ms: later }], cardState: null }] }]);
    assert.ok('ok' in marked.results[0], JSON.stringify(marked.results[0]));
    const after = rows(marked, 'tracked_stories').find((r) => r.id === story.id);
    assert.equal(after.seen_pub_watermark_ms, later);
    assert.equal(after.unseen_count, 0);
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});

test('no log line carries a command argument, a fact or a topic', async () => {
  const w = await world();
  const MARK = 'Zqmarker7731';
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    await run(pod, [{ name: 'addFact', args: [`Lives near ${MARK} lake`] }]);
    // A failing command: its argument must not be quoted in the log either.
    await run(pod, [{ name: 'updateFact', args: [`missing-${MARK}`, { statement: `Works at ${MARK}` }] }]);
    await run(pod, [{ name: 'noSuchCommand', args: [MARK] }]);
    await call(pod, 'commands.run', { schemaVersion: SCHEMA, registry: REGISTRY + 1, commands: [{ name: 'addFact', args: [MARK] }] });
    await ok(pod, 'display.snapshot', {});
    await pod.ask('stop');
    assert.ok(pod.logs.length > 0, 'the pod logged something');
    assert.deepEqual(pod.logs.filter((line) => line.includes(MARK)), []);
  } finally {
    await w.close();
  }
});
