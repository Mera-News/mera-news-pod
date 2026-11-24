// What the pod says about itself, decided from a snapshot of its tables and the scheduler.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judge, problemsOf, type Snapshot } from '../../src/services/status';
import { cleanTopicTexts } from '../../src/services/profile';

const snap = (over: Partial<Snapshot>): Snapshot => ({
  facts: 0, topics: 0, topicsPending: 0, topicsFailed: 0, unscored: 0, lastRunMs: null, frequencyMs: 60_000,
  readingNow: false, readFailing: false, aiKeyRefused: false, dataKeyRefused: false, ...over,
});

test('news-only with nothing saved offers to set up the profile, one question at a time', () => {
  const { state, hint } = judge(snap({ noAi: true }), false);
  assert.equal(state, 'no_facts');
  assert.match(hint, /one question at a time: where they live first, then their work, then the news they care about/);
  assert.match(hint, /Read each fact back and ask before saving it/);
});

test('news-only with facts is usable: the assistant picks, and nothing asks for setup', () => {
  for (const s of [snap({ noAi: true, facts: 2, topicsPending: 2 }), snap({ noAi: true, facts: 2, topics: 5 })]) {
    const { state, hint } = judge(s, false);
    assert.equal(state, 'ok');
    assert.match(hint, /Pick for the person yourself/);
    assert.doesNotMatch(hint, /pod\.json|key/i);
  }
  assert.deepEqual(problemsOf(snap({ noAi: true, facts: 1 })).map((p) => [p.code, p.who]), [['no_ai_service', 'assistant']]);
});

test('news-only still says when the data server refuses the key, without promising a retry', () => {
  const s = snap({ noAi: true, facts: 1, dataKeyRefused: true });
  assert.deepEqual(problemsOf(s).map((p) => p.code), ['no_ai_service', 'data_key_refused']);
  const { state, hint } = judge(s, false);
  assert.equal(state, 'problem');
  assert.doesNotMatch(hint, /tries again/);
});

test('a refused AI key also names removing the ai block', () => {
  assert.match(problemsOf(snap({ aiKeyRefused: true }))[0].fix, /Or remove the ai block from pod\.json and let your assistant pick\.$/);
});

test('topic texts are tidied to one line and refused outside 1 to 12 texts of 1 to 80 characters', () => {
  assert.deepEqual(cleanTopicTexts([' a\n b ', 'x'.repeat(80)]), ['a b', 'x'.repeat(80)]);
  for (const bad of [[], Array(13).fill('t'), ['  '], ['x'.repeat(81)], [42], ['a\u0000b'], 'chess', null]) {
    assert.throws(() => cleanTopicTexts(bad), /1 to 12 topics/);
  }
});
