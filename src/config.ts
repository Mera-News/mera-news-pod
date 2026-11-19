// The pod's home directory, its config file and its secrets, read once at boot. Every error is one
// plain sentence a person can act on, because `start` and `check` print it as it is.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class ConfigError extends Error {}

export interface PluginEntry {
  /** A package name, or a path to a plugin package. */
  package: string;
  /** The plugin's own settings, passed to it as written. */
  config?: unknown;
}

/** pod.json as a person writes it. */
export interface PodConfigFile {
  dataServer: { url: string };
  ai: { baseUrl: string; model: string; concurrency?: number; callTimeoutSeconds?: number };
  reading?: { everyMinutes?: number; runTimeoutMinutes?: number };
  language?: string;
  region?: string;
  notify?: { ntfy?: { enabled?: boolean; url?: string }; webhook?: { enabled?: boolean; url?: string } };
  plugins?: PluginEntry[];
  /** The one https origin a plugin may ask to wake a paired phone through, or false. Absent means off. */
  wakeRelay?: string | false;
}

/** secrets.json, mode 0600. */
export interface PodSecretsFile {
  aiApiKey?: string;
  dataApiKey?: string;
}

export interface PodPaths {
  home: string;
  configFile: string;
  secretsFile: string;
  harnessDir: string;
  dataDir: string;
  /** Absolute and ending in .db: WatermelonDB's Node driver rewrites any other name. */
  dbFile: string;
  kvFile: string;
  secureFile: string;
  controlFile: string;
  picksFile: string;
  lockFile: string;
  pluginsDir: string;
}

export interface LoadedConfig {
  paths: PodPaths;
  dataServer: { graphqlUrl: string; origin: string; apiKey?: string };
  ai: { baseUrl: string; origin: string; model: string; apiKey?: string; concurrency: number; callTimeoutMs: number };
  reading: { everyMinutes: number; runTimeoutMs: number };
  language?: string;
  region?: string;
  notify: { ntfy?: { url: string; origin: string }; webhook?: { url: string; origin: string } };
  plugins: PluginEntry[];
  wakeRelay: { origin: string } | null;
  /** Every secret value in use, so the logger can blank it out of anything it writes. */
  secrets: string[];
}

export const MIN_EVERY_MINUTES = 5;
export const MAX_EVERY_MINUTES = 1440;

/** MERA_POD_HOME, else ~/.mera-news-pod. */
export function podHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.MERA_POD_HOME || path.join(os.homedir(), '.mera-news-pod');
}

export function podPaths(home: string): PodPaths {
  const abs = path.resolve(home);
  const data = path.join(abs, 'data');
  return {
    home: abs,
    configFile: path.join(abs, 'pod.json'),
    secretsFile: path.join(abs, 'secrets.json'),
    harnessDir: path.join(abs, 'harness'),
    dataDir: data,
    dbFile: path.join(data, 'mera.db'),
    kvFile: path.join(data, 'kv.json'),
    secureFile: path.join(data, 'secure.json'),
    controlFile: path.join(data, 'control.json'),
    picksFile: path.join(data, 'picks.json'),
    lockFile: path.join(data, 'pod.lock.db'),
    pluginsDir: path.join(data, 'plugins'),
  };
}

function readJson<T>(file: string, what: string): T {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new ConfigError(`${what} not found at ${file}. Run mera-news-pod init first.`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ConfigError(`${file} is not valid JSON.`);
  }
}

function httpUrl(value: unknown, field: string): URL {
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    throw new ConfigError(`${field} must be an http or https address.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ConfigError(`${field} must be an http or https address.`);
  return url;
}

/** An https origin and nothing more: no path, query, fragment or credentials. */
function httpsOrigin(value: unknown, field: string): string {
  const fail = () => new ConfigError(`${field} must be an https origin, such as https://relay.example.org.`);
  if (typeof value !== 'string') throw fail();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw fail();
  }
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw fail();
  return url.origin;
}

function whole(value: number | undefined, fallback: number, min: number, max: number, field: string): number {
  const n = value ?? fallback;
  if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`${field} must be a whole number between ${min} and ${max}.`);
  return n;
}

function readSecrets(file: string): PodSecretsFile {
  if (!fs.existsSync(file)) return {};
  // Group or others able to read it means the keys are already exposed on this machine.
  if ((fs.statSync(file).mode & 0o077) !== 0) {
    throw new ConfigError(`${file} can be read by other users. Run: chmod 600 ${file}`);
  }
  return readJson<PodSecretsFile>(file, 'secrets.json');
}

export function loadConfig(home: string, env: NodeJS.ProcessEnv = process.env): LoadedConfig {
  const paths = podPaths(home);
  const file = readJson<PodConfigFile>(paths.configFile, 'pod.json');
  const secrets = readSecrets(paths.secretsFile);

  if (!file.dataServer?.url) throw new ConfigError('dataServer.url is missing from pod.json.');
  const data = httpUrl(file.dataServer.url, 'dataServer.url');
  const dataPath = data.pathname.replace(/\/+$/, '');
  const graphqlUrl = `${data.origin}${dataPath.endsWith('/graphql') ? dataPath : `${dataPath}/graphql`}`;

  if (!file.ai?.baseUrl || !file.ai?.model) throw new ConfigError('ai.baseUrl and ai.model are required in pod.json.');
  const ai = httpUrl(file.ai.baseUrl, 'ai.baseUrl');

  const notifyTarget = (entry: { enabled?: boolean; url?: string } | undefined, field: string) => {
    if (!entry?.enabled) return undefined;
    const url = httpUrl(entry.url, `${field}.url`);
    return { url: url.href, origin: url.origin };
  };

  const plugins = file.plugins ?? [];
  if (!Array.isArray(plugins) || plugins.some((p) => typeof p?.package !== 'string' || p.package.trim() === '')) {
    throw new ConfigError('plugins must be a list of { "package": "<name or path>" } entries.');
  }

  const aiApiKey = env.MERA_POD_AI_API_KEY || secrets.aiApiKey || undefined;
  const dataApiKey = env.MERA_POD_DATA_API_KEY || secrets.dataApiKey || undefined;

  return {
    paths,
    dataServer: { graphqlUrl, origin: data.origin, apiKey: dataApiKey },
    ai: {
      baseUrl: ai.href.replace(/\/+$/, ''),
      origin: ai.origin,
      model: file.ai.model,
      apiKey: aiApiKey,
      concurrency: whole(file.ai.concurrency, 2, 1, 16, 'ai.concurrency'),
      callTimeoutMs: whole(file.ai.callTimeoutSeconds, 300, 10, 3600, 'ai.callTimeoutSeconds') * 1000,
    },
    reading: {
      everyMinutes: whole(file.reading?.everyMinutes, 15, MIN_EVERY_MINUTES, MAX_EVERY_MINUTES, 'reading.everyMinutes'),
      runTimeoutMs: whole(file.reading?.runTimeoutMinutes, 30, 1, 240, 'reading.runTimeoutMinutes') * 60_000,
    },
    language: file.language,
    region: file.region,
    notify: { ntfy: notifyTarget(file.notify?.ntfy, 'notify.ntfy'), webhook: notifyTarget(file.notify?.webhook, 'notify.webhook') },
    plugins,
    wakeRelay: file.wakeRelay === undefined || file.wakeRelay === false ? null : { origin: httpsOrigin(file.wakeRelay, 'wakeRelay') },
    secrets: [aiApiKey, dataApiKey].filter((s): s is string => typeof s === 'string' && s.length > 0),
  };
}
