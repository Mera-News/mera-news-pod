import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultSchemaPath, startFakeDataServer, startFakeModel, type FakeDataServer, type FakeModel } from '../../src/testing';

export const fixture = (name: string) => path.join(__dirname, 'fixtures', name);

export interface World {
  home: string;
  data: FakeDataServer;
  model: FakeModel;
  close(): Promise<void>;
}

/** A temporary home, a pod.json that points at two local fakes, and the fakes. */
export async function world(extraConfig: object = {}): Promise<World> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pod-boot-'));
  const data = await startFakeDataServer({ schemaPath: defaultSchemaPath(), articles: [{ _id: 'a1', title: 'One' }], topics: {} });
  const model = await startFakeModel();
  fs.writeFileSync(path.join(home, 'pod.json'), JSON.stringify({ dataServer: { url: data.origin }, ai: { baseUrl: model.baseUrl, model: 'm' }, language: 'en', ...extraConfig }));
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

export interface Child {
  proc: ChildProcess;
  /** Resolves with the first message that is not a log line: { ready } or { error }. */
  first: Promise<{ ready?: true; error?: string }>;
  logs: string[];
  exited: Promise<number | null>;
  ask(cmd: string, arg?: unknown): Promise<any>;
  kill(): void;
}

const alive = new Set<ChildProcess>();
/** Every test file calls this in its `after`, so a failed run leaves no pod behind. */
export const killAll = () => alive.forEach((p) => p.kill('SIGKILL'));

export function startPod(home: string, env: NodeJS.ProcessEnv = {}, script = fixture('pod-child.ts')): Child {
  const proc = spawn(process.execPath, ['--import', 'tsx', script], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    env: { ...process.env, MERA_POD_HOME: home, ...env },
  });
  alive.add(proc);
  const logs: string[] = [];
  const waiting = new Map<number, (v: unknown) => void>();
  let id = 0;
  let resolveFirst!: (v: { ready?: true; error?: string }) => void;
  const first = new Promise<{ ready?: true; error?: string }>((r) => (resolveFirst = r));
  const exited = new Promise<number | null>((r) =>
    proc.once('exit', (code) => {
      alive.delete(proc);
      resolveFirst({ error: 'the pod process ended before it reported' });
      r(code);
    }),
  );
  proc.on('message', (m: any) => {
    if (m.log) logs.push(m.log);
    else if (m.ready || m.error) resolveFirst(m);
    else if (m.id !== undefined) waiting.get(m.id)?.(m.value);
  });
  return {
    proc,
    first,
    logs,
    exited,
    ask: (cmd, arg) => new Promise((resolve) => {
      waiting.set(++id, resolve);
      proc.send({ id, cmd, arg });
    }),
    kill: () => proc.kill('SIGKILL'),
  };
}
