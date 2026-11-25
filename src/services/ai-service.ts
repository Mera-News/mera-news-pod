// The person's AI service: tested at the address they typed, saved (the address and models into
// pod.json, the key into secrets.json) and then switched to while the pod runs. Nothing is saved
// until every model answered a short test request.
import fs from 'node:fs';
import path from 'node:path';
import { AI_PROVIDERS, modelsPath, reasoningFor } from '../ai-providers';
import type { PodPaths } from '../config';
import type { PodServices } from '../plugin-api';
import { client } from './client';
import { PodError } from './ledger';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
// Printable characters only, so a key cannot break a header or hide another value.
const KEY = /^[\x21-\x7e]{1,2000}$/;
const MODEL = /^[^\p{Cc}\p{Cf}]{1,200}$/u;
const TEST_TIMEOUT_MS = 20_000;
// Ids of models that do not chat, for a list that does not say what each model can do.
const NOT_CHAT = /embed|tts|whisper|dall-e|image|audio|moderation|transcribe|realtime|rerank|search/i;
// How a service says it does not know a model in a 400.
const UNKNOWN_MODEL = /model.*(not found|not exist|does not exist|unknown|invalid|not supported|unsupported|no such)|(unknown|invalid|unsupported) model/i;

const bad = (message: string, next: string) => new PodError('bad_input', `${message} Nothing was saved.`, next);

function address(value: unknown): URL {
  const next = 'Use the address your AI service gives for OpenAI-compatible requests, such as https://api.example.com/v1.';
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    throw bad('The AI service address is not a web address.', next);
  }
  const local = LOOPBACK.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw bad('The AI service address must start with https://, or http:// for a service on this computer.', next);
  }
  if (url.username || url.password || url.search || url.hash) throw bad('The AI service address must not hold a name, password, query or #.', next);
  return url;
}

/** The address that holds /chat/completions and /models, also when the full request address was pasted. */
const baseOf = (url: URL) => url.href.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');

function modelName(value: unknown): string {
  const model = typeof value === 'string' ? value.trim() : '';
  if (!MODEL.test(model)) throw bad('The model name must be 1 to 200 characters on one line.', 'Use the model name your AI service lists.');
  return model;
}

function keyOf(value: unknown): string | undefined {
  if (value !== undefined && (typeof value !== 'string' || !KEY.test(value))) {
    throw bad('The key must be 1 to 2000 characters with no spaces.', 'Paste the key your AI service gave you, or leave it out to keep the saved one.');
  }
  return value;
}

function readJson(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path.basename(file)} is not a JSON object`);
  return value as Record<string, unknown>;
}

/** Written whole, by temp file and rename, readable only by this user. */
function writeJson(file: string, value: unknown) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, file);
}

/** One line of what a service said, with the key blanked out, at most 200 characters. */
function scrub(text: string, key: string | undefined): string {
  const blanked = key ? text.split(key).join('[key]') : text;
  return blanked.replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim().slice(0, 200);
}

function messageOf(text: string): string {
  try {
    const body = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
    const message = typeof body.error === 'string' ? body.error : (body.error?.message ?? body.message);
    if (typeof message === 'string') return message;
  } catch {
    // not JSON: the text itself
  }
  return text;
}

type Protocol = { useMeraProtocolStore: { getState(): { skipNotes: boolean; setSkipNotes(on: boolean): void } } };
const protocol = () => client<Protocol>('stores/mera-protocol-store').useMeraProtocolStore.getState();

/** False while the pod writes no reason for a pick. */
export const reasonsOn = () => !protocol().skipNotes;

export interface AiServiceDeps {
  paths: Pick<PodPaths, 'configFile' | 'secretsFile'>;
  /** Not the pod's guarded fetch: only for the test and the model list, to the address given. */
  fetch: typeof fetch;
  /** Switches the running pod to the service saved in pod.json and secrets.json, which must hold the key tested. */
  apply(testedKey: string | undefined): void;
  /** True while MERA_POD_AI_API_KEY is set: it replaces any saved key, so a key set here would not be the one used. */
  keyFromEnv: boolean;
  hasAi(): boolean;
  readNow(): Promise<string>;
  log(level: 'warning', line: string): void;
}

export function createAiService(deps: AiServiceDeps) {
  let chain: Promise<unknown> = Promise.resolve();
  const queued = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn);
    chain = run.catch(() => {});
    return run;
  };

  const readFiles = () => {
    try {
      return { config: readJson(deps.paths.configFile), secrets: readJson(deps.paths.secretsFile) };
    } catch {
      throw new PodError('config_unreadable', 'pod.json or secrets.json could not be read, so nothing was saved.', 'Fix or remove the file, then try again.');
    }
  };
  const savedAi = (config: Record<string, unknown>) => (config.ai && typeof config.ai === 'object' ? (config.ai as Record<string, unknown>) : {});
  /** The key typed, else the saved one when it was saved for this same origin. A key never goes to another address. */
  const keyFor = (url: URL, typed: string | undefined, config: Record<string, unknown>, secrets: Record<string, unknown>) => {
    if (typed !== undefined) return typed;
    let sameOrigin = false;
    try {
      sameOrigin = new URL(String(savedAi(config).baseUrl)).origin === url.origin;
    } catch {
      // no address saved before
    }
    return sameOrigin && typeof secrets.aiApiKey === 'string' ? secrets.aiApiKey : undefined;
  };

  /** A request to the address the person gave, and to no other origin, with no redirect followed. */
  const send = async (url: URL, at: string, init: RequestInit, key: string | undefined, code: string) => {
    const target = new URL(`${baseOf(url)}${at}`);
    if (target.origin !== url.origin) throw new Error('a request left the address it was given');
    try {
      const res = await deps.fetch(target, {
        ...init,
        headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...(key ? { authorization: `Bearer ${key}` } : {}) },
        redirect: 'error',
        signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
      });
      return { status: res.status, text: await res.text() };
    } catch (error) {
      const late = (error as Error).name === 'TimeoutError';
      throw new PodError(
        code,
        late ? `${url.host} did not answer within ${TEST_TIMEOUT_MS / 1000} seconds.` : `The pod cannot reach ${url.host}.`,
        'Check the address and that the service is running, then try again.',
      );
    }
  };
  const failure = (code: string, status: number, text: string, key: string | undefined, model?: string) => {
    const message = messageOf(text);
    if (status === 401 || status === 403) return new PodError(code, 'The AI service refused the key.', 'Check the key, or paste a new one from your AI service.');
    if (model !== undefined && (status === 404 || (status === 400 && UNKNOWN_MODEL.test(message)))) {
      return new PodError(code, `The AI service does not know the model "${model}".`, 'Pick a model the service lists, and check the address.');
    }
    if (status === 404) return new PodError(code, 'The address does not list models.', 'Check the address, or type the model name.');
    return new PodError(code, `The service answered: ${scrub(message, key) || `status ${status}`}`, 'Check the address, the key and the model, then try again.');
  };

  /** One short completion. The endpoint's reasoning-off rule is applied; no sampling field is sent, which every endpoint takes. */
  const test = async (url: URL, model: string, key: string | undefined) => {
    const reasoning = reasoningFor(url.origin, model);
    const body = { model, messages: [{ role: 'user', content: 'Reply with the word ok.' }], max_tokens: 16 + (reasoning?.headroomTokens ?? 0), ...reasoning?.off };
    const { status, text } = await send(url, '/chat/completions', { method: 'POST', body: JSON.stringify(body) }, key, 'ai_test_failed');
    if (status < 200 || status > 299) throw failure('ai_test_failed', status, text, key, model);
  };

  const retryFailedTopics = async () => {
    const { getFacts } = client<{ getFacts(): Promise<{ id: string; statement: string; topicsStatus: string | null }[]> }>('database/services/fact-service');
    const { retryTopicGeneration } = client<{ retryTopicGeneration(id: string, statement: string): Promise<void> }>('chat-tools/tool-handlers');
    let failed = 0;
    for (const fact of (await getFacts()).filter((f) => f.topicsStatus === 'error')) {
      await retryTopicGeneration(fact.id, fact.statement).catch(() => failed++);
    }
    if (failed) deps.log('warning', `Topics for ${failed} facts could not be asked for again.`);
  };

  const noEnvKey = () => {
    if (deps.keyFromEnv) {
      throw new PodError('bad_input', 'The AI key comes from MERA_POD_AI_API_KEY, so the AI service cannot be set here. Nothing was saved.', 'Remove MERA_POD_AI_API_KEY and restart the pod, then set the AI service here.');
    }
  };

  const service: PodServices['aiService'] = {
    set(change) {
      return queued(async () => {
        noEnvKey();
        const url = address(change?.baseUrl);
        const model = modelName(change?.model);
        const relevanceModel = change?.relevanceModel === undefined ? model : modelName(change.relevanceModel);
        const typed = keyOf(change?.apiKey);
        if (change?.reasons !== undefined && typeof change.reasons !== 'boolean') throw bad('reasons must be true or false.', 'Leave it out to keep the current choice.');
        let { config, secrets } = readFiles();
        const key = keyFor(url, typed, config, secrets);

        for (const m of new Set([model, relevanceModel])) await test(url, m, key);

        // The old key is gone before the address changes, so a failure between the two writes
        // leaves no key rather than a key at the wrong service.
        if (secrets.aiApiKey !== key) {
          const { aiApiKey: _dropped, ...rest } = secrets;
          secrets = rest;
          writeJson(deps.paths.secretsFile, secrets);
        }
        const { relevanceModel: _old, ...before } = savedAi(config);
        writeJson(deps.paths.configFile, { ...config, ai: { ...before, baseUrl: baseOf(url), model, ...(relevanceModel !== model ? { relevanceModel } : {}) } });
        if (key !== undefined && secrets.aiApiKey !== key) writeJson(deps.paths.secretsFile, { ...secrets, aiApiKey: key });

        // Kept by the store itself, so the choice holds even if the switch below fails.
        if (change.reasons !== undefined) protocol().setSkipNotes(!change.reasons);
        try {
          deps.apply(key);
        } catch (error) {
          throw new PodError(
            'ai_not_applied',
            `The AI service was saved, but the pod could not switch to it (${scrub((error as Error).message, key)}). It is used from the next start.`,
            'Restart the pod.',
          );
        }
        await retryFailedTopics().catch(() => deps.log('warning', 'Failed topics could not be asked for again.'));
        void deps.readNow().catch(() => deps.log('warning', 'A read could not start after the AI service was set.'));
        return { set: true as const };
      });
    },

    async models(query) {
      noEnvKey();
      const url = address(query?.baseUrl);
      const { config, secrets } = readFiles();
      const key = keyFor(url, keyOf(query?.apiKey), config, secrets);
      const { status, text } = await send(url, modelsPath(url.origin), { method: 'GET' }, key, 'ai_models_failed');
      if (status < 200 || status > 299) throw failure('ai_models_failed', status, text, key);
      let entries: unknown;
      try {
        const body = JSON.parse(text) as { data?: unknown; models?: unknown };
        entries = Array.isArray(body) ? body : (body.data ?? body.models);
      } catch {
        // checked below
      }
      if (!Array.isArray(entries)) throw new PodError('ai_models_failed', 'The service did not send a list of models.', 'Type the model name instead.');
      const rows = entries.filter((e): e is { id: string; capabilities?: { completion_chat?: boolean } } => typeof e?.id === 'string');
      const tagged = rows.some((e) => typeof e.capabilities?.completion_chat === 'boolean');
      const ids = rows.filter((e) => (tagged ? e.capabilities?.completion_chat === true : !NOT_CHAT.test(e.id))).map((e) => e.id.replace(/^models\//, ''));
      return { models: [...new Set(ids)].sort() };
    },

    providers: () => AI_PROVIDERS,

    async setReasons(on) {
      if (typeof on !== 'boolean') throw new PodError('bad_input', 'Reasons must be turned on with true or off with false.', 'Pass true or false.');
      if (!deps.hasAi()) throw new PodError('no_ai_service', 'No AI service is set, so the pod writes no reasons.', 'Set an AI service first.');
      protocol().setSkipNotes(!on);
      return { set: true as const };
    },
  };
  return service;
}
