import type { IncomingMessage, ServerResponse } from 'node:http';

export interface RecordedRequest {
  method: string;
  path: string;
  /** Lower-cased header names. Credentials are removed. */
  headers: Record<string, string>;
  body: unknown;
}

const SECRET_HEADERS = new Set(['authorization', 'x-api-key', 'cookie', 'proxy-authorization']);

export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export function record(req: IncomingMessage, raw: string): RecordedRequest {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (SECRET_HEADERS.has(name) || value === undefined) continue;
    headers[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  let body: unknown = raw;
  try {
    body = raw === '' ? null : JSON.parse(raw);
  } catch {
    // not JSON: keep the raw text so a test can see what arrived
  }
  return { method: req.method ?? '', path: (req.url ?? '').split('?')[0], headers, body };
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/** The origins (scheme and host) a set of recordings reached, from each request's Host header. */
export function originsOf(requests: readonly RecordedRequest[]): string[] {
  return [...new Set(requests.map((r) => `http://${r.headers.host ?? 'unknown'}`))].sort();
}
