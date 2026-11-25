// Starts the pod. The order is the safety of it: take the home's lock, check the database is not
// from a newer version, and only then load the client, because the client reads its host as it
// loads and a second pod or a downgraded database must be refused before anything is opened.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, podHome, type LoadedConfig } from './config';
import { createControl, type Control } from './control';
import { createNodeHost } from './host';
import { assertClientNotLoaded } from './host/boot-guard';
import type { Level, Sink } from './host/telemetry';
import type { PodServices } from './plugin-api';
import { loadPlugins, unavailableServices, type LoadedPlugins } from './plugins';
import { seedOnce } from './seed';

export interface BootOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  sink?: Sink;
  minLevel?: Level;
  /** Builds what plugins are handed. Called once the client is running. `cli start` passes the pod's own. */
  createServices?: (context: ServicesContext) => { services: PodServices; stop?(): void };
}

export interface ServicesContext {
  cfg: LoadedConfig;
  control: Control;
  log(level: Level, line: string): void;
  /** True while the AI service or the data server refuses the configured key. */
  keyRefused(server: 'ai' | 'data'): boolean;
}

export interface Pod {
  cfg: LoadedConfig;
  control: Control;
  plugins: LoadedPlugins;
  /** Sends the client through background and back to active, which wakes its scheduled work. */
  cycle(): Promise<void>;
  /** Blanks configured secrets out of text before it is printed. */
  redact(text: string): string;
  stop(): Promise<void>;
}

const READY_TIMEOUT_MS = 120_000;
const DRAIN_TIMEOUT_MS = 10_000;
/** The client's dist folder, or null in a bundle, where the client is not separate files. */
function clientDistDir(): string | null {
  try {
    return path.join(fs.realpathSync(path.dirname(require.resolve('mera-news-client/package.json'))), 'dist') + path.sep;
  } catch {
    return null;
  }
}

function readHarness(cfg: LoadedConfig) {
  const dir = cfg.paths.harnessDir;
  const manifest = path.join(dir, 'harness.json');
  if (!fs.existsSync(manifest)) return undefined;
  const { slotText } = require('mera-news-client/dist/lib/harnesses/slot-text') as { slotText(raw: string): string | null };
  let file: { extends?: string };
  try {
    file = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  } catch {
    throw new Error(`${manifest} is not valid JSON.`);
  }
  const slots: Record<string, string> = {};
  const walk = (at: string) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.md')) {
        const text = slotText(fs.readFileSync(full, 'utf8'));
        if (text === null) throw new Error(`${full} must end with exactly one newline.`);
        slots[path.relative(dir, full).slice(0, -3).split(path.sep).join('/')] = text;
      }
    }
  };
  walk(dir);
  return {
    folder: 'user',
    file: { params: {}, ...file, extends: file.extends ?? 'cloud-base' },
    slots,
    mapping: cfg.ai ? { [`openai:${cfg.ai.model}`]: 'user' } : {},
  };
}

export async function boot(options: BootOptions = {}): Promise<Pod> {
  const env = options.env ?? process.env;
  const cfg = loadConfig(options.home ?? podHome(env), env);
  fs.mkdirSync(cfg.paths.dataDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(cfg.paths.home, 0o700);

  const { host, guards } = createNodeHost(cfg, { llmTransport: undefined, sink: options.sink, minLevel: options.minLevel });
  const write: Sink = options.sink ?? ((level, line) => (level === 'error' || level === 'warning' || level === 'fatal' ? console.error(line) : console.log(line)));
  const log = (level: Level, line: string) => write(level, guards.redact(line));

  // 1. The lock: one pod per home.
  guards.installGlobalFetch();
  const lock = guards.acquireLock();
  const cleanups: (() => unknown)[] = [() => lock.release()];
  const unwind = async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await (async () => cleanup())().catch(() => {});
  };

  try {
    // 2. The database version, read from the one client module that is safe to load first.
    // Every client require is a literal path so a bundler can follow it; a bundle has no client files on disk.
    const clientDist = clientDistDir();
    const { default: schema } = require('mera-news-client/dist/lib/database/schema') as { default: { version: number } };
    guards.guardDatabaseVersion(schema.version);

    // 3. The reader's own prompt harness, if there is one.
    const harness = readHarness(cfg);

    // 4. Nothing else from the client may be loaded yet.
    if (clientDist) assertClientNotLoaded(clientDist, ['lib/platform/index.js', 'lib/harnesses/slot-text.js', 'lib/database/schema.js'].map((f) => path.join(clientDist, f)));

    // 5. Register the host.
    if (harness) (host as Record<string, unknown>).harness = harness;
    const { registerPlatform } = require('mera-news-client/dist/lib/platform/index') as { registerPlatform(host: never): void };
    registerPlatform(host as never);

    // 6. Load the client for real, seed, apply the saved control state, run.
    const { createOpenAiTransport } = require('mera-news-client/dist/lib/llm/openai-transport') as {
      createOpenAiTransport(config: Record<string, unknown>): { inFlight(): number };
    };
    // The transport for the AI service in pod.json, or, with none, one that refuses every call.
    if (cfg.ai) {
      (host as Record<string, unknown>).llmTransport = createOpenAiTransport({
        baseUrl: cfg.ai.baseUrl,
        apiKey: cfg.ai.apiKey,
        model: cfg.ai.model,
        concurrency: cfg.ai.concurrency,
        callTimeoutMs: cfg.ai.callTimeoutMs,
        harnessFolder: harness ? 'user' : undefined,
        quirks: cfg.ai.quirks,
      });
    } else {
      // Without a transport the client falls back to Mera's gateway, so this one refuses every call at once.
      const err = Object.assign(new Error('No AI service is set in pod.json.'), { code: 'no_ai_service' });
      (host as Record<string, unknown>).llmTransport = {
        complete: () => Promise.reject(err),
        batch: () => Promise.reject(err),
        // eslint-disable-next-line require-yield
        async *chat() {
          throw err;
        },
        asyncJobs: false,
      };
    }
    require('mera-news-client/dist/lib/database/index');
    require('mera-news-client/dist/lib/scheduler/tasks/data-cleanup-task');
    require('mera-news-client/dist/lib/scheduler/tasks/feed-sync-task');
    require('mera-news-client/dist/lib/scheduler/tasks/feedback-cycle-task');
    require('mera-news-client/dist/lib/scheduler/tasks/inference-recover-task');
    require('mera-news-client/dist/lib/scheduler/tasks/persona-geo-task');
    require('mera-news-client/dist/lib/scheduler/tasks/persona-hygiene-task');
    require('mera-news-client/dist/lib/scheduler/tasks/persona-migration-task');
    require('mera-news-client/dist/lib/scheduler/tasks/sanity-backfill-task');
    const { inferenceQueue } = require('mera-news-client/dist/lib/inference/InferenceQueue') as { inferenceQueue: { start(): Promise<void>; stop(): Promise<void> } };
    const { AppScheduler } = require('mera-news-client/dist/lib/scheduler/AppScheduler') as { AppScheduler: { tasks: Map<string, unknown> } };
    const { useSchedulerStore } = require('mera-news-client/dist/lib/scheduler/scheduler-store') as { useSchedulerStore: { getState(): { isRunning(name: string): boolean } } };
    const { initNetworkListener } = require('mera-news-client/dist/lib/stores/network-store') as { initNetworkListener(): void };
    const { useDatabaseStore } = require('mera-news-client/dist/lib/stores/database-store') as { useDatabaseStore: { getState(): { ready: boolean } } };
    const { startClient } = require('mera-news-client/dist/lib/scheduler/start-client') as { startClient(o?: { afterHydrate?: () => void }): () => void };

    await seedOnce(cfg);
    const control = createControl(cfg, env);
    control.apply();
    initNetworkListener();
    const stopClient = startClient({
      afterHydrate: () => {
        if (cfg.ai) void inferenceQueue.start().catch((e) => log('error', `The inference queue did not start: ${(e as Error).message}`));
      },
    });
    cleanups.push(async () => {
      stopClient();
      await inferenceQueue.stop();
      const deadline = Date.now() + DRAIN_TIMEOUT_MS;
      const busy = () => [...AppScheduler.tasks.keys()].some((t) => useSchedulerStore.getState().isRunning(t));
      while (busy() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    });

    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (!useDatabaseStore.getState().ready) {
      if (Date.now() > deadline) throw new Error('The database did not open in time.');
      await new Promise((r) => setTimeout(r, 25));
    }

    // 7. Watchers and plugins.
    const everyMs = Number(env.MERA_POD_INTERVAL_SECONDS) * 1000 || undefined;
    guards.appState.startCycle(everyMs, () => control.get().paused);
    cleanups.push(() => guards.appState.stop());
    const made = options.createServices?.({ cfg, control, log, keyRefused: (server) => guards.refusedBy(server === 'ai' ? (cfg.ai?.origin ?? '') : cfg.dataServer.origin) });
    if (made?.stop) cleanups.push(() => made.stop!());
    const plugins = await loadPlugins(cfg, {
      services: made?.services ?? unavailableServices,
      write: log,
      podRoot: path.resolve(__dirname, '..'),
    });
    cleanups.push(() => plugins.stop());
    await plugins.start();

    return { cfg, control, plugins, cycle: () => guards.appState.cycle(), redact: guards.redact, stop: unwind };
  } catch (error) {
    await unwind();
    throw error;
  }
}
