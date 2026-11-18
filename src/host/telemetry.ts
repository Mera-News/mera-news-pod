// The client's error reporting, as lines on the pod's log. Nothing leaves the machine, and every
// configured secret is blanked out of each line before it is written.
export type Level = 'fatal' | 'error' | 'warning' | 'log' | 'info' | 'debug';

const RANK: Record<Level, number> = { debug: 0, log: 1, info: 1, warning: 2, error: 3, fatal: 4 };

export type Sink = (level: Level, line: string) => void;

export const consoleSink: Sink = (level, line) => (RANK[level] >= RANK.warning ? console.error(line) : console.log(line));

/** A literal replace of each secret value, so a key never reaches a log in any form it was given. */
export function createRedactor(secrets: readonly string[]): (text: string) => string {
  const values = secrets.filter((s) => s.length > 0);
  return (text) => values.reduce((out, secret) => out.split(secret).join('[redacted]'), text);
}

function describe(value: unknown): string {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function createTelemetry(redact: (text: string) => string, sink: Sink = consoleSink, minLevel: Level = 'info') {
  let count = 0;
  const write = (level: Level, text: string) => {
    if (RANK[level] >= RANK[minLevel]) sink(level, redact(`[${level}] ${text}`));
  };
  const withContext = (text: string, extra?: Record<string, unknown>) => (extra && Object.keys(extra).length ? `${text} ${describe(extra)}` : text);

  return {
    captureException(exception: unknown, context?: { level?: Level; extra?: Record<string, unknown> }) {
      write(context?.level ?? 'error', withContext(describe(exception), context?.extra));
      return `event-${++count}`;
    },
    captureMessage(message: string, context?: { level?: Level; extra?: Record<string, unknown> }) {
      write(context?.level ?? 'info', withContext(message, context?.extra));
      return `message-${++count}`;
    },
    addBreadcrumb(crumb: { message?: string; category?: string; data?: Record<string, unknown>; level?: Level }) {
      write(crumb.level ?? 'debug', withContext([crumb.category, crumb.message].filter(Boolean).join(': '), crumb.data));
    },
    setUser() {},
    setTag() {},
    setExtra() {},
    startInactiveSpan: () => ({ end() {} }),
    withScope(callback: (scope: { setTag(): void; setLevel(): void }) => void) {
      callback({ setTag() {}, setLevel() {} });
    },
  };
}

export type Telemetry = ReturnType<typeof createTelemetry>;
