// Chat for a paired phone: the request goes to the pod's own AI endpoint with the pod's own key.
import type { LoadedConfig } from '../config';
import type { PodServices } from '../plugin-api';
import { PodError } from './ledger';

// Only these fields of the caller's body pass. The model, the address and the key are never the caller's.
const PASSED = ['messages', 'stream', 'temperature', 'max_tokens', 'max_completion_tokens', 'top_p', 'n', 'presence_penalty', 'frequency_penalty', 'chat_template_kwargs'];

// Read at call time, so it is the guarded fetch the pod installs once it has booted.
const globalFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

export function createModelService(cfg: LoadedConfig, fetchFn: typeof fetch = globalFetch): PodServices['model'] {
  return {
    async chatCompletions(body, signal) {
      const asked = (body ?? {}) as Record<string, unknown>;
      if (asked.tools !== undefined) throw new PodError('tools_not_allowed', 'This endpoint does not take tools.', 'send the messages without a tools field');
      if (!Array.isArray(asked.messages)) throw new PodError('bad_request', 'The request needs a messages list.', 'send a messages list');
      const ai = cfg.ai;
      if (!ai) throw new PodError('no_ai_service', 'No AI service is set.', 'set ai.baseUrl and ai.model in pod.json and restart the pod');
      const sent: Record<string, unknown> = { model: ai.model };
      for (const field of PASSED) if (asked[field] !== undefined) sent[field] = asked[field];
      return fetchFn(`${ai.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(ai.apiKey ? { authorization: `Bearer ${ai.apiKey}` } : {}) },
        body: JSON.stringify(sent),
        redirect: 'error',
        signal,
      });
    },
  };
}
