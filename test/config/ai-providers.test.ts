import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AI_PROVIDERS, endpointQuirks, modelsPath, reasoningFor } from '../../src/ai-providers';

const A = 'https://api.anthropic.com';

test('each known model gets the reasoning switch it accepts, an unknown one gets headroom, other endpoints nothing', () => {
  assert.deepEqual(reasoningFor(A, 'claude-haiku-5-5'), { off: { thinking: { type: 'disabled' } } });
  assert.deepEqual(reasoningFor(A, 'claude-sonnet-5-5'), { off: { thinking: { type: 'between_tools' } } });
  assert.deepEqual(reasoningFor(A, 'claude-opus-5-5'), { headroomTokens: 2048 });
  assert.equal(reasoningFor('https://api.openai.com', 'gpt-6-luna'), undefined);
  assert.deepEqual(endpointQuirks(A), ['no-sampling']);
  assert.deepEqual(endpointQuirks('http://127.0.0.1:11434'), []);
  assert.equal(modelsPath(A), '/models?limit=1000');
  assert.equal(modelsPath('http://127.0.0.1:11434'), '/models');
});

test('every known service has an https address and both suggested models or neither; only Other has no address', () => {
  const ids = AI_PROVIDERS.map((p) => p.id);
  assert.deepEqual(ids, ['anthropic', 'openai', 'openrouter', 'gemini', 'mistral', 'groq', 'other']);
  for (const p of AI_PROVIDERS) {
    if (p.id === 'other') assert.equal(p.baseUrl, null);
    else assert.equal(new URL(p.baseUrl!).protocol, 'https:');
    assert.equal(!!p.chatModel, !!p.relevanceModel, p.id);
  }
});
