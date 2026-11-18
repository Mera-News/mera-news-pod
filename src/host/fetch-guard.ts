// The one fetch the client uses. It reaches only the origins the config names, and it never
// follows a redirect, so a server cannot send the pod somewhere it was not told to go.
export function guardedFetch(
  allowedOrigins: readonly string[],
  log: (line: string) => void = console.error,
  /** Told the status of every answer, so the pod can say when a server keeps refusing its key. */
  onStatus: (origin: string, status: number) => void = () => {},
): typeof globalThis.fetch {
  const allowed = new Set(allowedOrigins);
  const reported = new Set<string>();
  // Taken now, so installing the guard as the global fetch cannot make it call itself.
  const real = globalThis.fetch;

  return (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return Promise.reject(new TypeError(`invalid request address: ${url}`));
    }
    if (!allowed.has(origin)) {
      if (!reported.has(origin)) {
        reported.add(origin);
        log(`blocked request to ${origin}`);
      }
      return Promise.reject(Object.assign(new Error(`blocked request to ${origin}`), { name: 'BlockedRequestError' }));
    }
    // `manual` follows nothing either: the caller sees the 3xx and stops, where an error would be retried.
    return real(input, { ...init, redirect: init?.redirect === 'manual' ? 'manual' : 'error' }).then((res) => {
      onStatus(origin, res.status);
      return res;
    });
  };
}

export function installGlobalFetch(guarded: typeof globalThis.fetch): void {
  globalThis.fetch = guarded;
}
