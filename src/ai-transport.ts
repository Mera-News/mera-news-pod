// The model transport the pod hands the client. The client keeps the one object it was given, so
// this one forwards each call to whichever AI service is in use, and can be pointed at a new one
// while the pod runs. With none it refuses every call at once: without a transport the client would
// fall back to Mera's gateway.
import { reasoningFor } from './ai-providers';
import type { LoadedConfig } from './config';

/** The part of the client's transport the pod calls, as `createOpenAiTransport` returns it. */
export interface Transport {
  complete(request: { route?: string }, options?: unknown): Promise<string>;
  batch(calls: unknown[], route: string, options?: unknown): Promise<unknown[]>;
  chat(request: unknown): AsyncGenerator<unknown>;
  asyncJobs?: false;
  inFlight(): number;
}
export type CreateOpenAiTransport = (config: Record<string, unknown>) => Transport;

/**
 * One transport per model: articles are rated (the `scoring` lane) by `relevanceModel`, every other
 * call goes to `model`. Each gets the configured concurrency, so rating a large read never holds up a
 * chat; the service may then see up to twice that many requests at once. The same model twice shares
 * one transport. The person's own harness applies to the main model only.
 */
export function aiTransport(create: CreateOpenAiTransport, ai: NonNullable<LoadedConfig['ai']>, harness: boolean): Transport {
  const forModel = (model: string, harnessFolder?: string) =>
    create({
      baseUrl: ai.baseUrl,
      apiKey: ai.apiKey,
      model,
      concurrency: ai.concurrency,
      callTimeoutMs: ai.callTimeoutMs,
      harnessFolder,
      quirks: ai.quirks,
      reasoning: reasoningFor(ai.origin, model),
    });
  const main = forModel(ai.model, harness ? 'user' : undefined);
  // Named, so a mapping of the person's harness to a model the pod started with is never used here.
  const relevance = ai.relevanceModel === ai.model ? main : forModel(ai.relevanceModel, 'cloud-base');
  return {
    complete: (request, options) => (request.route === 'scoring' ? relevance : main).complete(request, options),
    batch: (calls, route, options) => (route === 'scoring' ? relevance : main).batch(calls, route, options),
    chat: (request) => main.chat(request),
    asyncJobs: false,
    inFlight: () => main.inFlight() + (relevance === main ? 0 : relevance.inFlight()),
  };
}

export function switchingTransport() {
  let target: Transport | null = null;
  const none = () => Object.assign(new Error('No AI service is set.'), { code: 'no_ai_service' });
  const transport: Transport = {
    complete: (request, options) => (target ? target.complete(request, options) : Promise.reject(none())),
    batch: (calls, route, options) => (target ? target.batch(calls, route, options) : Promise.reject(none())),
    // Like the client's own, nothing runs until the first next(), so the target is the one in use then.
    async *chat(request) {
      if (!target) throw none();
      yield* target.chat(request);
    },
    asyncJobs: false,
    inFlight: () => target?.inFlight() ?? 0,
  };
  return {
    transport,
    current: () => target,
    use(next: Transport | null) {
      target = next;
    },
  };
}
