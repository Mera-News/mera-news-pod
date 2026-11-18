import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { call, killAll, ok, startServicesPod, until, world } from './helpers';
import { defaultSchemaPath, startFakeDataServer } from '../../src/testing';
import fs from 'node:fs';
import path from 'node:path';

after(killAll);

const get = (pod: Parameters<typeof ok>[0], options: { since?: string; limit?: number } = {}) => ok(pod, 'suggestions.get', { limit: 10, ...options });
const stateOf = async (pod: Parameters<typeof ok>[0]) => (await get(pod)).state;
/** A hint a person can be told: a sentence, no dash used as punctuation, no leftover template text. */
const plain = (hint: string) => {
  assert.match(hint, /^[A-Z].*[.]$/s, `a sentence: ${hint}`);
  assert.doesNotMatch(hint, /\u2014|\u2013|undefined|\[object/);
};

test('each state says what the pod is doing and when to look again, and an empty list never stands alone', async () => {
  const w = await world();
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    // Reads are held until the "reading is on" step: a read could clear the unscored row planted below.
    await pod.ask('holdReads', true);
    await until(() => ok(pod, 'reading.status'), (s) => !s.readingNow, 'the boot read to end');

    // no facts yet
    let reply = await get(pod);
    assert.equal(reply.state, 'no_facts');
    assert.deepEqual(reply.picks, []);
    plain(reply.hint);
    assert.match(reply.hint, /Add a fact/);
    assert.match(reply.hint, /a few minutes/);

    // facts, and their topics still being made
    await pod.ask('plantFact', { statement: 'Follows chess', status: 'pending' });
    reply = await get(pod);
    assert.equal(reply.state, 'topics_pending');
    assert.deepEqual(reply.picks, []);
    plain(reply.hint);
    assert.match(reply.hint, /Check again in a few minutes/);
    assert.doesNotMatch(JSON.stringify(reply), /chess/, 'no fact text in a status reply');

    // topics made, but news still being rated
    await pod.ask('plantFact', { statement: 'Follows sailing', status: 'done', topics: [{ text: 'sailing races' }] });
    await pod.ask('plant', [{ id: 'unrated', status: 'unscored', relevance: 0 }]);
    reply = await get(pod);
    assert.equal(reply.state, 'first_read_pending');
    assert.deepEqual(reply.picks, []);
    plain(reply.hint);
    assert.match(reply.hint, /next read is/);

    // reading is on and nothing new matched
    await pod.ask('holdReads', false);
    await pod.ask('patchRow', { id: 'unrated', patch: { status: 'complete', relevance: 0.3 } });
    await pod.ask('lastRun');
    // The new topic started a read of its own: wait for it to end.
    await until(() => ok(pod, 'reading.status'), (s) => !s.readingNow && s.unscored === 0, 'the read to end');
    reply = await get(pod);
    assert.equal(reply.state, 'ok');
    assert.deepEqual(reply.picks, []);
    plain(reply.hint);
    assert.match(reply.hint, /next read is in about 1[45] minutes/);
    assert.ok(Date.parse(reply.nextReadAt) > Date.now());

    // paused
    await ok(pod, 'reading.set', { paused: true });
    reply = await get(pod);
    assert.equal(reply.state, 'paused');
    assert.equal(reply.nextReadAt, null);
    plain(reply.hint);
    assert.match(reply.hint, /turned back on/);

    // and back on
    await ok(pod, 'reading.set', { paused: false });
    assert.equal(await stateOf(pod), 'ok');
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});

test('a failing read is a problem a person can fix, with the fix in the hint', async () => {
  const w = await world();
  const keyed = await startFakeDataServer({ schemaPath: defaultSchemaPath(), apiKey: 'right-key', articles: [{ _id: 'a1', title: 'One' }], topics: {} });
  try {
    // The pod is given no key, so the data server refuses every read.
    fs.writeFileSync(path.join(w.home, 'pod.json'), JSON.stringify({ dataServer: { url: keyed.origin }, ai: { baseUrl: w.model.baseUrl, model: 'm' }, language: 'en' }));
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    await pod.ask('plantFact', { statement: 'Follows chess', status: 'done', topics: [{ text: 'chess' }] });
    await pod.ask('trigger');
    const status = await until(() => ok(pod, 'reading.status'), (s) => s.problems.some((p: any) => p.code === 'read_failing'), 'a failed read');
    assert.equal(status.problems.find((p: any) => p.code === 'read_failing').who, 'person');
    const reply = await get(pod);
    assert.equal(reply.state, 'problem');
    assert.deepEqual(reply.picks, []);
    plain(reply.hint);
    assert.match(reply.hint, /secrets\.json/);
    assert.match(reply.hint, /tries again/);
    await pod.ask('stop');
  } finally {
    await keyed.close();
    await w.close();
  }
});

test('an AI service that refuses the key is a problem the person fixes, and the hint names the setting', async () => {
  // One article for the fact's topic: the read the fact starts fetches it and asks the model to rate it.
  const w = await world({ model: { status: 401 }, articles: [{ _id: 'c1', title: 'Chess final goes to a tiebreak' }], topics: { chess: ['c1'] } });
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    await pod.ask('plantFact', { statement: 'Follows chess', status: 'done', topics: [{ text: 'chess' }] });
    const status = await until(() => ok(pod, 'reading.status'), (s) => s.problems.some((p: any) => p.code === 'ai_key_refused'), 'the refused key');
    assert.ok(w.model.bodies.length > 0, 'the pod did ask the AI service');
    const problem = status.problems.find((p: any) => p.code === 'ai_key_refused');
    assert.equal(problem.who, 'person');
    assert.match(problem.fix, /aiApiKey/);
    const reply = await get(pod);
    assert.equal(reply.state, 'problem');
    plain(reply.hint);
    assert.match(reply.hint, /aiApiKey/);
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});

test('a reply with picks is ok even while more news is still being rated', async () => {
  const w = await world();
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    await pod.ask('plantFact', { statement: 'Follows sailing', status: 'done', topics: [{ text: 'sailing races' }] });
    await pod.ask('plant', [{ id: 'rated', relevance: 0.9, publishedHoursAgo: 2 }, { id: 'waiting', status: 'unscored', relevance: 0, publishedHoursAgo: 1 }]);
    const reply = await get(pod);
    assert.deepEqual(reply.picks.map((p: any) => p.url), ['https://example.com/rated']);
    assert.equal(reply.state, 'ok');
    plain(reply.hint);
    assert.match(reply.hint, /still being rated/);
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});

test('picks cut to fit a caller\'s size limit all arrive over successive calls, none twice', async () => {
  const w = await world();
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    await pod.ask('plantFact', { statement: 'Follows sailing', status: 'done', topics: [{ text: 'sailing races' }] });
    const names = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf'];
    await pod.ask('plant', names.map((id, i) => ({ id, publishedHoursAgo: 10 - i, reason: `${id} `.repeat(300).trim() })));
    const seen: string[] = [];
    const sizes: number[] = [];
    for (let call = 0; call < names.length; call++) {
      const reply = await ok(pod, 'suggestions.get', { limit: 10, fitsChars: 4500 });
      seen.push(...reply.picks.map((p: any) => p.url.split('/').pop()));
      sizes.push(reply.picks.length);
      if (!reply.more) break;
    }
    assert.deepEqual([...seen].sort(), [...names].sort(), 'every pick arrived exactly once');
    assert.ok(sizes.every((n) => n >= 1 && n <= 2), `pages cut to fit: ${sizes}`);
    assert.deepEqual((await ok(pod, 'suggestions.get', { limit: 10 })).picks, [], 'nothing is left to deliver');
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});

test('two reports with nearly the same headline are one story, so they come back as one pick', async () => {
  const w = await world();
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    await pod.ask('plantFact', { statement: 'Follows sailing', status: 'done', topics: [{ text: 'sailing races' }] });
    await pod.ask('plant', [
      { id: 'first', title: 'Harbour regatta moved to Sunday after storm warning', publishedHoursAgo: 2 },
      { id: 'second', title: 'Harbour regatta moved to Sunday after a storm warning', publishedHoursAgo: 1 },
      { id: 'other', title: 'Chess olympiad opens in Budapest', publishedHoursAgo: 1 },
    ]);
    const reply = await get(pod);
    assert.equal(reply.picks.length, 2, JSON.stringify(reply.picks.map((p: any) => p.title)));
    assert.equal(reply.picks.filter((p: any) => p.title.startsWith('Harbour regatta')).length, 1);
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});

test('facts that all came back without topics are a problem the assistant can retry', async () => {
  const w = await world();
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    await pod.ask('plantFact', { statement: 'Follows chess', status: 'error' });
    const reply = await get(pod);
    assert.equal(reply.state, 'problem');
    assert.deepEqual(reply.picks, []);
    plain(reply.hint);
    assert.match(reply.hint, /retries/);
    const status = await ok(pod, 'reading.status');
    assert.deepEqual(status.problems.map((p: any) => [p.code, p.who]), [['no_topics', 'assistant']]);
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});

test('a pick is a headline, a link and a reason; the article text is never returned', async () => {
  const w = await world();
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    const fact = await pod.ask('plantFact', { statement: 'Follows sailing', status: 'done', topics: [{ text: 'sailing races' }] });
    await pod.ask('plant', [
      { id: 'greek', titleOriginal: 'Νέα ρεκόρ στην ιστιοπλοΐα', title: 'New records in sailing', lang: 'el', reason: 'Ties to your interest in sailing.', factIds: [fact.id], relevance: 0.85 },
    ]);
    await pod.ask('lastRun');
    const reply = await get(pod);
    assert.equal(reply.picks.length, 1);
    const pick = reply.picks[0];
    assert.deepEqual(Object.keys(pick).sort(), ['facts', 'id', 'lang', 'level', 'publication', 'publishedAt', 'reason', 'title', 'url']);
    assert.equal(pick.title, 'Νέα ρεκόρ στην ιστιοπλοΐα', 'the title stays in its own language');
    assert.equal(pick.lang, 'el');
    assert.equal(pick.url, 'https://example.com/greek');
    assert.equal(pick.reason, 'Ties to your interest in sailing.');
    assert.equal(pick.level, 'high');
    assert.deepEqual(pick.facts, ['Follows sailing']);
    assert.doesNotMatch(JSON.stringify(reply), /ARTICLE BODY/);
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});

test('levels follow the band, and picks come oldest first', async () => {
  const w = await world();
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    await pod.ask('plant', [
      { id: 'lo', relevance: 0.45, publishedHoursAgo: 1 },
      { id: 'md', relevance: 0.65, publishedHoursAgo: 2 },
      { id: 'hi', relevance: 0.85, publishedHoursAgo: 3 },
      { id: 'em', relevance: 1.1, publishedHoursAgo: 4 },
    ]);
    const reply = await get(pod);
    assert.deepEqual(reply.picks.map((p: any) => [p.id, p.level]), [['em', 'emergency'], ['hi', 'high'], ['md', 'medium'], ['lo', 'low']]);
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});

test('a pick is delivered once, "all" replays, and a stale or invented cursor is told what to do', async () => {
  const w = await world();
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    await pod.ask('plant', [{ id: 'one', publishedHoursAgo: 3 }, { id: 'two', publishedHoursAgo: 2 }, { id: 'three', publishedHoursAgo: 1 }]);

    const first = await get(pod, { limit: 2 });
    assert.deepEqual(first.picks.map((p: any) => p.id), ['one', 'two']);
    assert.equal(first.more, true);
    const second = await get(pod, { since: first.cursor });
    assert.deepEqual(second.picks.map((p: any) => p.id), ['three']);
    const third = await get(pod, { since: second.cursor });
    assert.deepEqual(third.picks, []);
    assert.equal(third.cursor, second.cursor);
    assert.deepEqual((await get(pod)).picks, [], 'a read with no cursor carries on from the last delivery');
    assert.deepEqual((await get(pod, { since: 'all' })).picks.map((p: any) => p.id), ['one', 'two', 'three']);

    const reset = await get(pod, { since: 'ffffffffff.4' });
    assert.equal(reset.reset, true);
    assert.deepEqual(reset.picks.map((p: any) => p.id), ['one', 'two', 'three']);

    const epoch = first.cursor.split('.')[0];
    for (const since of [`${epoch}.999`, 'nonsense']) {
      const refused = await call(pod, 'suggestions.get', { since, limit: 5 });
      assert.equal(refused.error?.code, 'unknown_cursor');
      assert.equal(refused.error?.next, 'call without since');
    }
    const badLimit = await call(pod, 'suggestions.get', { limit: 0 });
    assert.equal(badLimit.error?.code, 'bad_limit');
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});

test('a pick that leaves the Feed or changes its lead article is not delivered again', async () => {
  const w = await world();
  try {
    const pod = startServicesPod(w.home);
    assert.deepEqual(await pod.first, { ready: true });
    await pod.ask('plant', [
      { id: 'story-a', cluster: 'story', publishedHoursAgo: 5 },
      { id: 'other', publishedHoursAgo: 4 },
    ]);
    assert.equal((await get(pod)).picks.length, 2);

    // Its note is rewritten: the story drops out of the Feed, then comes back.
    await pod.ask('patchRow', { id: 'other', patch: { status: 'reason_pending' } });
    assert.deepEqual((await get(pod)).picks, []);
    await pod.ask('patchRow', { id: 'other', patch: { status: 'complete' } });
    assert.deepEqual((await get(pod)).picks, []);

    // Older than the Feed's window: gone from the Feed, still stored, and quiet when it returns.
    await pod.ask('patchRow', { id: 'other', patch: { firstPubDate: new Date(Date.now() - 60 * 3_600_000) } });
    assert.deepEqual((await get(pod, { since: 'all' })).picks.map((p: any) => p.id), ['story-a']);
    await pod.ask('patchRow', { id: 'other', patch: { firstPubDate: new Date(Date.now() - 3_600_000) } });
    assert.deepEqual((await get(pod)).picks, []);

    // A second article joins the story and a different one leads: the story is already known.
    await pod.ask('plant', [{ id: 'story-b', cluster: 'story', publishedHoursAgo: 1 }]);
    await pod.ask('patchRow', { id: 'story-a', patch: { status: 'reason_pending' } });
    const lead = (await get(pod, { since: 'all' })).picks.map((p: any) => p.id);
    assert.ok(lead.includes('story-b') && !lead.includes('story-a'), `the lead changed: ${lead}`);
    assert.deepEqual((await get(pod)).picks, []);

    // When the row itself is deleted the entry goes, and a story with the same id is new.
    await pod.ask('deleteRow', 'other');
    assert.deepEqual((await get(pod)).picks, []);
    await pod.ask('plant', [{ id: 'other', publishedHoursAgo: 1 }]);
    assert.deepEqual((await get(pod)).picks.map((p: any) => p.id), ['other']);
    await pod.ask('stop');
  } finally {
    await w.close();
  }
});

test('the ledger survives a restart of the pod', async () => {
  const w = await world();
  try {
    const first = startServicesPod(w.home);
    assert.deepEqual(await first.first, { ready: true });
    await first.ask('plant', [{ id: 'one', publishedHoursAgo: 2 }]);
    const delivered = await get(first);
    assert.equal(delivered.picks.length, 1);
    await first.ask('stop');
    assert.equal(await first.exited, 0);

    const second = startServicesPod(w.home);
    assert.deepEqual(await second.first, { ready: true });
    assert.deepEqual((await get(second)).picks, []);
    await second.ask('plant', [{ id: 'two', publishedHoursAgo: 1 }]);
    const next = await get(second, { since: delivered.cursor });
    assert.deepEqual(next.picks.map((p: any) => p.id), ['two']);
    assert.equal(next.reset, undefined);
    await second.ask('stop');
  } finally {
    await w.close();
  }
});
