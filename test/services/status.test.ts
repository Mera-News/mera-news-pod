// What the pod says about itself, decided from a snapshot of its tables and the scheduler.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judge, problemsOf, type Snapshot } from '../../src/services/status';
import { cleanTopicTexts } from '../../src/services/profile';

const snap = (over: Partial<Snapshot>): Snapshot => ({
  facts: 0, topics: 0, topicsPending: 0, topicsFailed: 0, unscored: 0, lastRunMs: null, frequencyMs: 60_000,
  readingNow: false, readFailing: false, aiKeyRefused: false, dataKeyRefused: false, ...over,
});

test('news-only with nothing saved: the person is sent to their assistant, and the assistant is told to set up the profile', () => {
  const s = snap({ noAi: true });
  const { state, hint } = judge(s, false);
  assert.equal(state, 'no_facts');
  // A plugin's page shows this hint to the person, so it names no tool and gives the assistant no orders.
  assert.equal(hint, 'Nothing is saved about what you want to read yet. Ask your assistant to set up your news profile.');
  const [problem] = problemsOf(s);
  assert.deepEqual([problem.code, problem.who], ['no_ai_service', 'assistant']);
  assert.match(problem.fix, /one question at a time: where they live first, then their work, then the news they care about/);
  assert.match(problem.fix, /Read each fact back and ask before saving it/);
});

test('news-only with facts is usable: the assistant picks, and nothing asks for setup', () => {
  for (const s of [snap({ noAi: true, facts: 2, topicsPending: 2 }), snap({ noAi: true, facts: 2, topics: 5 })]) {
    const { state, hint } = judge(s, false);
    assert.equal(state, 'ok');
    assert.equal(hint, 'This pod makes no picks on its own. Ask your assistant for the news.');
  }
  const problems = problemsOf(snap({ noAi: true, facts: 1 }));
  assert.deepEqual(problems.map((p) => [p.code, p.who]), [['no_ai_service', 'assistant']]);
  assert.match(problems[0].fix, /Pick for the person yourself/);
  assert.doesNotMatch(problems[0].fix, /pod\.json|key/i);
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
  // Persian and Indic scripts join letters with U+200C and U+200D, so those two stay.
  assert.deepEqual(cleanTopicTexts(['\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645']), ['\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645']);
  // Bidi overrides and invisible marks would show a topic as other text than what was saved.
  for (const bad of [[], Array(13).fill('t'), ['  '], ['x'.repeat(81)], [42], ['a\u0000b'], ['a\u202eb'], ['a\u200bb'], ['a\u2066b'], 'chess', null]) {
    assert.throws(() => cleanTopicTexts(bad), /1 to 12 topics/);
  }
});
