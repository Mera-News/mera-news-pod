// What a known AI service needs that the OpenAI-compatible request does not say by itself: request
// changes its endpoint needs whatever the model, and how each model's reasoning is turned off.
// A model these rules do not know is sent as it is.
import type { AiProvider } from './plugin-api';

/** The services a person can pick on the pod's settings page, with the models suggested for each. */
export const AI_PROVIDERS: readonly AiProvider[] = [
  { id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', chatModel: 'claude-sonnet-5-5', relevanceModel: 'claude-haiku-5-5', listsModels: true },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', chatModel: 'gpt-6.2-astra', relevanceModel: 'gpt-6-luna', listsModels: true },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', chatModel: 'anthropic/claude-sonnet-5.5', relevanceModel: 'anthropic/claude-haiku-5.5', listsModels: true },
  { id: 'gemini', name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', chatModel: 'gemini-4-hydrogen', relevanceModel: 'gemini-3.5-flash-lite', listsModels: true },
  { id: 'mistral', name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', chatModel: 'mistral-large-latest', relevanceModel: 'mistral-small-latest', listsModels: true },
  { id: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', listsModels: true },
  { id: 'other', name: 'Other', baseUrl: null, listsModels: true },
];

export interface Reasoning {
  /** Merged into the body of a call that does not ask for thinking. */
  off?: Record<string, unknown>;
  /** Added to every token limit, for a model whose reasoning cannot be turned off. */
  headroomTokens?: number;
}

const ANTHROPIC = 'https://api.anthropic.com';

/** Where the endpoint lists its models: this one sends a short page unless asked for more. */
export function modelsPath(origin: string): string {
  return origin === ANTHROPIC ? '/models?limit=1000' : '/models';
}

/** Request changes an endpoint needs whatever the model: this one refuses temperature and top_p with a 400. */
export function endpointQuirks(origin: string): string[] {
  return origin === ANTHROPIC ? ['no-sampling'] : [];
}

/**
 * This endpoint's models reason before every answer and the reasoning shares the answer's token
 * limit, so a short call comes back empty. The way to turn it off differs by model; a model with
 * none gets headroom instead.
 */
export function reasoningFor(origin: string, model: string): Reasoning | undefined {
  if (origin !== ANTHROPIC) return undefined;
  if (/^claude-haiku-/.test(model)) return { off: { thinking: { type: 'disabled' } } };
  if (/^claude-sonnet-5-5/.test(model)) return { off: { thinking: { type: 'between_tools' } } };
  return { headroomTokens: 2048 };
}
