import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { killAll, startPod, type Child, type World } from '../boot/helpers';
import { defaultSchemaPath, startFakeDataServer, startFakeModel, type FakeArticle, type FakePlace, type FakeModelOptions } from '../../src/testing';

export { killAll, type World };

/** A temporary home and two local fakes. The data server holds no articles unless given some, so only planted rows exist. */
export async function world(options: { articles?: FakeArticle[]; topics?: Record<string, string[]>; model?: FakeModelOptions; config?: object; extraSchema?: string; places?: FakePlace[] } = {}): Promise<World> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pod-services-'));
  let schemaPath = defaultSchemaPath();
  if (options.extraSchema) {
    // The data server's own schema plus the given definitions, so a test can offer more than it does.
    schemaPath = path.join(home, 'schema.gql');
    fs.writeFileSync(schemaPath, `${fs.readFileSync(defaultSchemaPath(), 'utf8')}\n${options.extraSchema}\n`);
  }
  const data = await startFakeDataServer({ schemaPath, articles: options.articles ?? [], topics: options.topics ?? {}, places: options.places });
  const model = await startFakeModel(options.model);
  fs.writeFileSync(path.join(home, 'pod.json'), JSON.stringify({ dataServer: { url: data.origin }, ai: { baseUrl: model.baseUrl, model: 'm' }, language: 'en', ...options.config }));
  return {
    home,
    data,
    model,
    async close() {
      await data.close();
      await model.close();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

const SERVICES_CHILD = path.join(__dirname, 'fixtures', 'services-child.ts');

/** A pod with the real services in its own process. */
export const startServicesPod = (home: string, env: NodeJS.ProcessEnv = {}): Child => startPod(home, env, SERVICES_CHILD);

export interface Reply {
  ok?: any;
  error?: { message: string; code?: string; next?: string };
}
/** Calls a service in the pod process: `call(pod, 'suggestions.get', { limit: 10 })`. */
export const call = (pod: Child, fn: string, ...args: unknown[]): Promise<Reply> => pod.ask('call', { fn, args });
export const ok = async (pod: Child, fn: string, ...args: unknown[]) => {
  const reply = await call(pod, fn, ...args);
  if (reply.error) throw new Error(`${fn} failed: ${reply.error.message}`);
  return reply.ok;
};

/** Polls until the check passes, or fails the test with the last value. */
export async function until<T>(read: () => Promise<T>, check: (value: T) => boolean, what: string, timeoutMs = 20_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last!: T;
  while (Date.now() < end) {
    last = await read();
    if (check(last)) return last;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${what}; last value ${JSON.stringify(last)}`);
}
