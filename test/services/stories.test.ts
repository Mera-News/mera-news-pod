import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { call, killAll, ok, startServicesPod, world } from './helpers';

after(killAll);

const ARTICLES = [
  { _id: 'h1', title: 'Utrecht housing rents rise sharply', story_key: 'rent' },
  { _id: 'h2', title: 'Landlords in Utrecht lift prices', story_key: 'rent' },
  { _id: 'h3', title: 'New tram line opens near Overvecht' },
  { _id: 'h4', title: 'Hospital nurses walk out over pay' },
];
const TOPICS = { 'utrecht housing': ['h1', 'h2'], 'utrecht transport': ['h3'], 'nurse strikes': ['h4'] };

async function profile(pod: Parameters<typeof ok>[0]) {
  const a = await pod.ask('plantFact', { statement: 'Lives in Utrecht', status: 'done', topics: [{ text: 'utrecht housing' }, { text: 'utrecht transport' }] });
  await new Promise((r) => setTimeout(r, 10)); // facts come oldest first
  const b = await pod.ask('plantFact', { statement: 'Works as a nurse', status: 'done', topics: [{ text: 'nurse strikes' }] });
  return { a: a.id as string, b: b.id as string };
}

const keys = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap(keys) : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...keys(x)]) : []);
const ids = (page: { stories: { id: string }[] }) => page.stories.map((s) => s.id);

test('news-only: every matching story once per event, judged once, a pick becomes a real pick and a story left out never does', async () => {
  const w = await world({ articles: ARTICLES, topics: TOPICS, config: { ai: undefined } });
  try {
    let pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    const facts = await profile(pod);

    const first = await ok(pod, 'stories.forProfile', { peek: true });
    assert.deepEqual(ids(first), ['h1', 'h4', 'h3'], 'each topic in turn, two reports of one story shown once');
    assert.equal(first.stories[0].reports, 2);
    assert.deepEqual(first.stories[0].facts, [{ id: facts.a, statement: 'Lives in Utrecht' }]);
    assert.equal(first.stories[0].verdict, undefined);
    assert.deepEqual(keys(first).filter((k) => /description/i.test(k)), [], 'no article text');
    assert.doesNotMatch(JSON.stringify(first), /Details of/);
    const { summary } = first;
    assert.deepEqual(
      { articles: summary.articles, stories: summary.stories, merged: summary.merged, unjudged: summary.unjudged, windowHours: summary.windowHours, complete: summary.complete, languages: summary.languages, publishers: summary.publishers },
      { articles: 4, stories: 3, merged: 1, unjudged: 3, windowHours: 48, complete: true, languages: 1, publishers: 3 },
    );
    assert.deepEqual(summary.topics, [{ text: 'utrecht housing', matches: 2 }, { text: 'nurse strikes', matches: 1 }, { text: 'utrecht transport', matches: 1 }]);
    assert.deepEqual(summary.facts.map((f: any) => [f.statement, f.matched, f.picked, f.leftOut]), [['Lives in Utrecht', 2, 0, 0], ['Works as a nurse', 1, 0, 0]]);
    assert.deepEqual(ids(await ok(pod, 'stories.forProfile', { peek: true })), ['h1', 'h4', 'h3'], 'a peek records nothing');
    assert.doesNotMatch(JSON.stringify(w.data.requests), /Lives in Utrecht|Works as a nurse/, 'only topic texts leave the computer, never a fact');

    // Pages by cursor, and a cursor from nowhere says to start again.
    const one = await ok(pod, 'stories.forProfile', { peek: true, limit: 1 });
    const two = await ok(pod, 'stories.forProfile', { peek: true, limit: 1, after: one.nextCursor });
    const three = await ok(pod, 'stories.forProfile', { peek: true, limit: 1, after: two.nextCursor });
    assert.deepEqual([...ids(one), ...ids(two), ...ids(three)], ['h1', 'h4', 'h3']);
    assert.equal(three.nextCursor, undefined);
    assert.equal((await call(pod, 'stories.forProfile', { after: 'feedbeef.0' })).error?.code, 'run_expired');

    assert.equal((await call(pod, 'stories.judge', [{ id: 'h1', verdict: 'picked', reason: 'Rents in Utrecht are rising.' }])).error?.code, 'bad_input', 'a pick needs a level');
    const judged = await ok(pod, 'stories.judge', [
      { id: 'h1', verdict: 'picked', level: 'high', reason: 'Rents in Utrecht, where you live, are rising.' },
      { id: 'h4', verdict: 'left_out', reason: 'A strike at a hospital you do not work at.' },
    ]);
    assert.deepEqual(judged, { saved: [{ id: 'h1', verdict: 'picked' }, { id: 'h4', verdict: 'left_out' }], already: [], refused: [] });
    // Another report of the same story, and the same story again, keep the first verdict.
    assert.deepEqual(await ok(pod, 'stories.judge', [{ id: 'h2', verdict: 'left_out', reason: 'Seen it.' }, { id: 'h4', verdict: 'picked', level: 'low', reason: 'Hospital nurses walk out.' }]), {
      saved: [],
      already: [{ id: 'h2', verdict: 'picked' }, { id: 'h4', verdict: 'left_out' }],
      refused: [],
    });
    // A pick's reason the client cannot tie to the article is refused, and the story stays unjudged.
    const refused = await ok(pod, 'stories.judge', [{ id: 'h3', verdict: 'picked', level: 'medium', reason: 'Zzyzx quorble.' }]);
    assert.deepEqual(refused.refused.map((r: any) => r.code), ['reason_not_grounded']);

    const picks = await ok(pod, 'suggestions.get', { since: 'all', limit: 10, peek: true });
    assert.deepEqual(
      picks.picks.map((p: any) => [p.url.split('/').pop(), p.level, p.reason, p.facts]),
      [['h1', 'high', 'Rents in Utrecht, where you live, are rising.', ['Lives in Utrecht']]],
      'the pick is one of the pod\'s own, and the story left out is no pick at any level',
    );

    // Without peek: judged stories carry their verdict, the unjudged one is recorded as shown.
    const seen = await ok(pod, 'stories.forProfile');
    assert.deepEqual(seen.stories.map((s: any) => [s.id, s.verdict?.verdict ?? null, s.verdict?.by ?? null]), [['h1', 'picked', 'assistant'], ['h4', 'left_out', 'assistant'], ['h3', null, null]]);
    assert.equal(seen.stories[0].verdict.level, 'high');
    assert.deepEqual([seen.summary.picked, seen.summary.leftOut, seen.summary.unjudged], [1, 1, 1]);
    assert.deepEqual(seen.summary.facts.map((f: any) => [f.picked, f.leftOut]), [[1, 0], [0, 1]]);
    const again = await ok(pod, 'stories.forProfile');
    assert.deepEqual(ids(again), ['h1', 'h4'], 'a story shown unjudged waits; judged ones are shown again with their verdict');
    assert.equal(again.shownBefore, 1);
    assert.deepEqual(ids(await ok(pod, 'stories.forProfile', { peek: true })), ['h1', 'h4', 'h3'], 'a peek still sees it');

    // Verdicts outlive the process.
    await pod.ask('stop');
    pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    assert.deepEqual((await ok(pod, 'stories.judge', [{ id: 'h4', verdict: 'picked', level: 'high', reason: 'Hospital nurses walk out.' }])).already, [{ id: 'h4', verdict: 'left_out' }]);
    const after = await ok(pod, 'stories.forProfile', { peek: true });
    assert.deepEqual(after.stories.map((s: any) => s.verdict?.verdict ?? null), ['picked', 'left_out', null]);
    assert.deepEqual((await ok(pod, 'suggestions.get', { since: 'all', limit: 10, peek: true })).picks.map((p: any) => p.url.split('/').pop()), ['h1']);
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});

test('with an AI service too, a peek never records a story as shown', async () => {
  const w = await world({ articles: ARTICLES, topics: TOPICS });
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    await pod.ask('holdReads', true);
    await profile(pod);
    await ok(pod, 'stories.forProfile', { peek: true });
    await ok(pod, 'stories.forProfile', { peek: true });
    const first = await ok(pod, 'stories.forProfile');
    assert.equal(first.shownBefore, 0, 'the peeks recorded nothing');
    const unjudged = first.stories.filter((s: any) => !s.verdict).map((s: any) => s.id);
    assert.ok(unjudged.length > 0);
    // The pod's own reading may judge a story in between; one still unjudged is not returned again.
    const second = await ok(pod, 'stories.forProfile');
    assert.deepEqual(second.stories.filter((s: any) => !s.verdict && unjudged.includes(s.id)), []);
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});
