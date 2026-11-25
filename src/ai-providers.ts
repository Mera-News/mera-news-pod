// What a known AI service needs that the OpenAI-compatible request does not say by itself: request
// changes its endpoint needs whatever the model, and how each model's reasoning is turned off.
// A model these rules do not know is sent as it is.

export interface Reasoning {
  /** Merged into the body of a call that does not ask for thinking. */
  off?: Record<string, unknown>;
  /** Added to every token limit, for a model whose reasoning cannot be turned off. */
  headroomTokens?: number;
}

const ANTHROPIC = 'https://api.anthropic.com';

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
