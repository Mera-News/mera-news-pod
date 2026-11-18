// Loads the plugins named in pod.json, starts them in order and stops them in reverse. A plugin is
// trusted code with the pod's access, so the only checks here are that it can be found, that it
// speaks this contract version, and that it starts.
import fs from 'node:fs';
import path from 'node:path';
import type { LoadedConfig } from './config';
import { POD_API, POD_API_VERSIONS, type CreatePlugin, type PodApiVersion, type Logger, type PodPlugin, type PodServices } from './plugin-api';

export class PluginError extends Error {}

const STOP_TIMEOUT_MS = 5_000;

const unavailable = () => Promise.reject(new Error('the pod is not running, so this is not available'));
/** What a plugin gets when it is only being described, not run. */
export const unavailableServices: PodServices = {
  profile: { get: unavailable, addFacts: unavailable, removeFacts: unavailable, editTopics: unavailable },
  suggestions: { get: unavailable },
  reading: { status: unavailable, set: unavailable, readNow: unavailable },
  commands: { run: unavailable },
  model: { chatCompletions: unavailable },
  news: { graphql: unavailable },
  display: { snapshot: unavailable, versions: () => ({ schemaVersion: 0, registry: 0 }) },
  events: { on: () => () => {} },
};

/** Exactly the members a version 1 plugin was given, so a newer pod adds nothing to it. */
const v1Services = (s: PodServices) => ({
  profile: { get: s.profile.get, addFacts: s.profile.addFacts, removeFacts: s.profile.removeFacts, editTopics: s.profile.editTopics },
  suggestions: { get: s.suggestions.get },
  reading: { status: s.reading.status, set: s.reading.set },
  model: s.model,
  news: s.news,
});

export interface PluginDeps {
  services: PodServices;
  /** Writes one log line at a level. The pod's logger blanks secrets out of it. */
  write(level: 'debug' | 'info' | 'warning' | 'error', line: string): void;
  /** Where the pod's package is installed, searched after the home when resolving a plugin. */
  podRoot: string;
}

export interface LoadedPlugins {
  start(): Promise<void>;
  stop(): Promise<void>;
  describe(): string[];
}

const oneLine = (error: unknown) => String((error as Error)?.message ?? error).split('\n')[0];

/** A plugin's own name: it is the name of its data directory, so it can never leave that folder. */
const PLUGIN_NAME = /^[a-z][a-z0-9-]{0,39}$/;

export async function loadPlugins(cfg: LoadedConfig, deps: PluginDeps): Promise<LoadedPlugins> {
  const { estimateTokens } = require('mera-news-client/dist/lib/algorithms/estimate-tokens') as { estimateTokens(text: string): number };
  const loaded: { spec: string; name: string; plugin: PodPlugin; unlisten: (() => void)[] }[] = [];

  for (const entry of cfg.plugins) {
    const spec = entry.package;
    const fail = (why: string) => new PluginError(`The plugin ${spec} ${why}`);
    let file: string;
    try {
      file = require.resolve(spec, { paths: [cfg.paths.home, deps.podRoot] });
    } catch {
      throw fail('was not found. Install it in the pod home or fix its name in pod.json.');
    }
    let mod: { createPlugin?: CreatePlugin; podApi?: unknown; name?: unknown };
    try {
      mod = require(file);
    } catch (error) {
      throw fail(`could not be loaded: ${oneLine(error)}`);
    }
    if (typeof mod.createPlugin !== 'function') throw fail('does not export createPlugin.');
    if (mod.podApi === undefined) throw fail(`does not say which plugin API it speaks. Export podApi = ${POD_API} next to createPlugin.`);
    if (!(POD_API_VERSIONS as readonly unknown[]).includes(mod.podApi)) throw fail(`needs plugin API version ${String(mod.podApi)}, and this pod speaks versions ${POD_API_VERSIONS.join(' and ')}.`);
    const podApi = mod.podApi as PodApiVersion;
    if (typeof mod.name !== 'string' || !PLUGIN_NAME.test(mod.name)) {
      throw fail('does not export a usable name. Export a short name of lower case letters, digits and dashes, starting with a letter.');
    }
    const name = mod.name;
    const twin = loaded.find((p) => p.name === name);
    if (twin) throw fail(`has the same name, ${name}, as the plugin ${twin.spec}. Each plugin needs its own name.`);

    const dataDir = path.join(cfg.paths.pluginsDir, name);
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const tag = `[plugin ${spec}] `;
    const log: Logger = {
      debug: (m) => deps.write('debug', tag + m),
      info: (m) => deps.write('info', tag + m),
      warn: (m) => deps.write('warning', tag + m),
      error: (m) => deps.write('error', tag + m),
    };
    // Listeners a plugin adds are removed when it stops, so a stopped plugin hears nothing.
    const unlisten: (() => void)[] = [];
    const services: PodServices =
      podApi === 1
        ? (v1Services(deps.services) as unknown as PodServices)
        : {
            ...deps.services,
            events: {
              on(event, listener) {
                const off = deps.services.events.on(event, listener);
                unlisten.push(off);
                return off;
              },
            },
          };
    try {
      loaded.push({ spec, name, unlisten, plugin: await mod.createPlugin({ podApi, services, config: entry.config, dataDir, log, estimateTokens }) });
    } catch (error) {
      throw fail(`did not start: ${oneLine(error)}`);
    }
  }

  const started: typeof loaded = [];
  const stopOne = async ({ spec, plugin, unlisten }: (typeof loaded)[number]) => {
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        deps.write('warning', `The plugin ${spec} did not stop within ${STOP_TIMEOUT_MS / 1000} seconds. Going on without it.`);
        resolve();
      }, STOP_TIMEOUT_MS);
    });
    try {
      await Promise.race([plugin.stop(), limit]);
    } catch (error) {
      deps.write('warning', `The plugin ${spec} failed while stopping: ${oneLine(error)}`);
    } finally {
      clearTimeout(timer);
      for (const off of unlisten.splice(0)) off();
    }
  };
  const stop = async () => {
    for (const item of started.splice(0).reverse()) await stopOne(item);
  };

  return {
    async start() {
      for (const item of loaded) {
        try {
          await item.plugin.start();
          started.push(item);
        } catch (error) {
          await stopOne(item);
          await stop();
          throw new PluginError(`The plugin ${item.spec} did not start: ${oneLine(error)}`);
        }
      }
    },
    stop,
    describe: () => loaded.flatMap(({ spec, plugin }) => (plugin.describe?.() ?? []).map((line) => `${spec}: ${line}`)),
  };
}
