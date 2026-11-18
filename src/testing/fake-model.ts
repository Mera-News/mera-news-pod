import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readBody, record, sendJson, type RecordedRequest } from './recorder';

export interface ChatMessage {
  role: string;
  content: string;
}

export interface ChatRequestBody {
  model?: string;
  messages: ChatMessage[];
  [key: string]: unknown;
}

export interface FakeModel {
  /** Origin, for example `http://127.0.0.1:41234`. */
  origin: string;
  /** Base URL of the endpoint, ending in `/v1`. */
  baseUrl: string;
  requests: RecordedRequest[];
  /** Bodies of the accepted chat completion requests, in arrival order. */
  bodies: ChatRequestBody[];
  close(): Promise<void>;
}

export interface FakeModelOptions {
  responder?: (body: ChatRequestBody) => string | Promise<string>;
  delayMs?: number;
  /** Answer every chat request with this HTTP status instead, as an endpoint that refuses the key does with 401. */
  status?: number;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const FENCE = /<<ARTICLE ([a-f0-9]{12})>>([\s\S]*?)<<\/ARTICLE \1>>/g;
const blocksOf = (user: string) => [...user.matchAll(FENCE)].map((m) => m[2]);
const lineOf = (block: string, label: string) => new RegExp(`${label}: (.*)`).exec(block)?.[1]?.trim() ?? '';
const textOf = (messages: ChatMessage[], role: string) => messages.find((m) => m.role === role)?.content ?? '';

/**
 * Same input, same reply: every value is a function of the text the endpoint was sent. The kind of
 * call is read from the user message, which the client's code builds; a harness override changes
 * only system prompts, so it cannot change what this reads.
 */
export function defaultResponder(body: ChatRequestBody): string {
  const system = textOf(body.messages, 'system');
  const user = [...body.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const blocks = blocksOf(user);
  if (blocks.length > 0 && user.includes('===== Article ')) {
    const scores = blocks.map((b) => {
      const n = parseInt(sha256(system + '\n' + b).slice(0, 4), 16) % 91;
      return Math.round((0.05 + n / 100) * 100) / 100;
    });
    return JSON.stringify(scores);
  }
  if (blocks.length > 0) {
    const block = blocks.join('\n');
    return `${lineOf(block, 'News Title')}, which ties to ${lineOf(block, 'Related User Fact')}.`;
  }
  const fact = /^Fact: "([^"]+)"/.exec(user)?.[1];
  if (fact) {
    const words = fact.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2);
    const first = words[0] ?? fact;
    return JSON.stringify([`${first} news`, words.slice(0, 2).join(' ') || fact, `${words.at(-1) ?? fact} latest`]);
  }
  return 'ok';
}

export async function startFakeModel(options: FakeModelOptions = {}): Promise<FakeModel> {
  const responder = options.responder ?? defaultResponder;
  const requests: RecordedRequest[] = [];
  const bodies: ChatRequestBody[] = [];
  const server: Server = createServer(async (req, res) => {
    const entry = record(req, await readBody(req));
    requests.push(entry);
    const fail = (status: number, message: string) => sendJson(res, status, { error: { message, type: 'fake_model_error' } });
    if (entry.path !== '/v1/chat/completions') return fail(404, `unknown path ${entry.path}`);
    if (entry.method !== 'POST') return fail(405, `unsupported method ${entry.method}`);
    const body = entry.body as ChatRequestBody | null;
    if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) return fail(400, 'body has no messages array');
    if (body.stream) return fail(400, 'streaming is not supported');
    bodies.push(body);
    if (options.status) return fail(options.status, `refused with ${options.status}`);
    if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
    let content: string;
    try {
      content = await responder(body);
    } catch (err) {
      return fail(500, err instanceof Error ? err.message : String(err));
    }
    sendJson(res, 200, {
      id: 'chatcmpl-fake',
      object: 'chat.completion',
      created: 0,
      model: body.model ?? 'fake',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    baseUrl: `${origin}/v1`,
    requests,
    bodies,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
