import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endpointQuirks, reasoningFor } from '../../src/ai-providers';

const A = 'https://api.anthropic.com';

test('each known model gets the reasoning switch it accepts, an unknown one gets headroom, other endpoints nothing', () => {
  assert.deepEqual(reasoningFor(A, 'claude-haiku-5-5'), { off: { thinking: { type: 'disabled' } } });
  assert.deepEqual(reasoningFor(A, 'claude-sonnet-5-5'), { off: { thinking: { type: 'between_tools' } } });
  assert.deepEqual(reasoningFor(A, 'claude-opus-5-5'), { headroomTokens: 2048 });
  assert.equal(reasoningFor('https://api.openai.com', 'gpt-6-luna'), undefined);
  assert.deepEqual(endpointQuirks(A), ['no-sampling']);
  assert.deepEqual(endpointQuirks('http://127.0.0.1:11434'), []);
});
