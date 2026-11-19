// Everything the client takes from its host, on Node: files in the pod's home, the log, and a
// fetch that reaches only the addresses the config names.
import i18next from 'i18next';
import type { LoadedConfig } from '../config';
import { createApolloClient } from './apollo';
import { guardDatabaseVersion } from './db-version';
import { guardedFetch, installGlobalFetch } from './fetch-guard';
import { createAsyncStorage } from './kv-file';
import { createLifecycle } from './lifecycle';
import { acquireLock } from './lock';
import { createSecureStore } from './secure-file';
import { consoleSink, createRedactor, createTelemetry, type Level, type Sink } from './telemetry';

export interface HostDeps {
  /** The client's OpenAI-compatible transport, built by the caller from `cfg.ai`. */
  llmTransport: unknown;
  /** Where log lines go. Default: the console. */
  sink?: Sink;
  minLevel?: Level;
}

function locales(cfg: LoadedConfig) {
  if (cfg.language) {
    return [{ languageTag: cfg.region ? `${cfg.language}-${cfg.region}` : cfg.language, languageCode: cfg.language, regionCode: cfg.region ?? null }];
  }
  const tag = Intl.DateTimeFormat().resolvedOptions().locale;
  const parsed = new Intl.Locale(tag);
  return [{ languageTag: tag, languageCode: parsed.language, regionCode: parsed.region ?? null }];
}

// Every member the client's PlatformHost has at the pinned client version. The client ships no type
// declarations, so a misspelt member would compile; this catches it when the host is built.
const REQUIRED_MEMBERS = ['env', 'appState', 'sentry', 'fetch', 'asyncStorage', 'secureStore', 'getLocales', 'auth', 'apolloClient', 'createDatabaseAdapter', 'i18n'];
const OPTIONAL_MEMBERS = [
  'isDev', 'devReload', 'keepAwake', 'updates', 'getCurrentPathname', 'captureSpot', 'submitFeatureRequest', 'devDump',
  'isRequestTimeoutError', 'netInfo', 'applyLanguage', 'canTranslateIntoLanguage', 'clearTranslationFailuresFor',
  'setLateTranslationSink', 'bumpTranslationEpoch', 'showNotifiedToast', 'showDialog', 'hapticLight', 'onDeviceModel',
  'llmTransport', 'harness', 'recordForeground', 'runKeychainAccessibilityMigration', 'hydrateHostState', 'resetHostState',
];

export function assertHostShape(host: object): void {
  const keys = Object.keys(host);
  const missing = REQUIRED_MEMBERS.filter((k) => !keys.includes(k));
  const unknown = keys.filter((k) => !REQUIRED_MEMBERS.includes(k) && !OPTIONAL_MEMBERS.includes(k));
  if (missing.length || unknown.length) {
    throw new Error(`the pod's platform host does not match the client: missing ${missing.join(', ') || 'none'}, unknown ${unknown.join(', ') || 'none'}`);
  }
}

export function createNodeHost(cfg: LoadedConfig, deps: HostDeps) {
  const redact = createRedactor(cfg.secrets);
  const sink = deps.sink ?? consoleSink;
  const sentry = createTelemetry(redact, sink, deps.minLevel);
  const appState = createLifecycle();

  const origins = allowedOrigins(cfg);
  // The last answer from each server: 401 or 403 from the AI service or the data server means the
  // key is wrong, which only the person can fix.
  const lastStatus = new Map<string, number>();
  const fetch = guardedFetch(origins, (line) => sink('warning', redact(line)), (origin, status) => lastStatus.set(origin, status));

  const auth = {
    getJwtToken: async () => 'local',
    getCookie: () => 'local',
    invalidateJwtCache() {},
    // shortcut: the pod has one reader and no sign-in, so the data server is trusted with a fixed token, upgrade when it needs per-user sessions.
    recordAuthFailure() {
      sentry.captureMessage('the data server refused the key', { level: 'warning' });
    },
  };

  const i18n = i18next.createInstance();
  void i18n.init({ lng: 'en', fallbackLng: 'en', resources: {}, initAsync: false });

  const host = {
    env: {
      EXPO_PUBLIC_GRAPHQL_SERVER_ENDPOINT: cfg.dataServer.graphqlUrl,
      EXPO_PUBLIC_INFERENCE_ENDPOINT: 'http://127.0.0.1:9',
      EXPO_PUBLIC_AUTH_ENDPOINT: 'http://127.0.0.1:9',
    },
    appState,
    sentry,
    fetch,
    netInfo: {
      fetch: async () => ({ isConnected: true, isInternetReachable: true, type: 'other' }),
      addEventListener: () => () => {},
    },
    asyncStorage: createAsyncStorage(cfg.paths.kvFile),
    secureStore: createSecureStore(cfg.paths.secureFile),
    getLocales: () => locales(cfg),
    auth,
    apolloClient: createApolloClient({ uri: cfg.dataServer.graphqlUrl, fetch, apiKey: cfg.dataServer.apiKey, telemetry: sentry, onUnauthorized: auth.recordAuthFailure }),
    createDatabaseAdapter(options: Record<string, unknown>) {
      // WatermelonDB writes migration progress to stdout, which belongs to the pod's log alone.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('@nozbe/watermelondb/utils/common/logger').default.silence();
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const SQLiteAdapter = require('@nozbe/watermelondb/adapters/sqlite').default;
      return new SQLiteAdapter({ ...options, dbName: cfg.paths.dbFile });
    },
    i18n,
    llmTransport: deps.llmTransport,
    // The row is already in the inbox. Its text can name a fact, so the log gets its type only.
    showNotifiedToast: (_row: unknown, opts: { type: string }) => sentry.captureMessage(`inbox row: ${opts.type}`, { level: 'info' }),
  };
  assertHostShape(host);

  const guards = {
    /** True while the latest answer from `origin` refused the request's credentials. */
    refusedBy: (origin: string) => [401, 403].includes(lastStatus.get(origin) ?? 0),
    appState,
    redact,
    installGlobalFetch: () => installGlobalFetch(fetch),
    acquireLock: () => acquireLock(cfg.paths.lockFile),
    guardDatabaseVersion: (codeVersion: number) => guardDatabaseVersion(cfg.paths.dbFile, codeVersion),
  };

  return { host, guards };
}

/** The origins the client's fetch may reach: what the config names, the Mera News app notifier included when on. */
export function allowedOrigins(cfg: Pick<LoadedConfig, 'dataServer' | 'ai' | 'notify'>): string[] {
  return [cfg.dataServer.origin, cfg.ai.origin, cfg.notify.ntfy?.origin, cfg.notify.webhook?.origin, cfg.notify.meraNewsApp?.origin].filter((o): o is string => !!o);
}
