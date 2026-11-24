import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupOf, topicReviewed } from '../../src/services/profile';

const at = '2026-01-01T00:00:00.000Z';
const fact = (metadata?: Record<string, unknown>, topicsStatus = 'done') => ({ id: 'f', statement: 'Follows chess', topicsStatus, createdAt: at, metadata });
const topic = (provenance: string, ms: number) => ({ id: 't', text: 'chess', weight: 1, status: 'active', provenance, pendingDeleteAt: null, createdAt: new Date(Date.parse(at) + ms) });

test('a topic made at the review time counts reviewed, one a moment later does not, and a person-made one always does', () => {
  const reviewed = fact({ reviewRequired: true, topicsReviewedAt: [at] });
  assert.equal(topicReviewed(reviewed, topic('llm', 0)), true);
  assert.equal(topicReviewed(reviewed, topic('llm', 1)), false);
  for (const p of ['user', 'feedback', 'tracked']) assert.equal(topicReviewed(fact({ reviewRequired: true }), topic(p, 1)), true);
  assert.equal(topicReviewed(fact({ topicsReviewedAt: [] }), topic('llm', 1)), true, 'no mark, no review needed');
});

test('setup leaves combination topics out: a fact with only those has no topics', () => {
  assert.deepEqual(setupOf([fact({ reviewRequired: true })], () => [topic('combo', 0)]).noTopics, ['Follows chess']);
});
