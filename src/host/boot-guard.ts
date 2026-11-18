// The client must not load before the host is registered, because several of its modules read the
// host as they load. This names any client module that got in early.
export function assertClientNotLoaded(clientDistDir: string, allowed: readonly string[] = []): void {
  const early = Object.keys(require.cache).filter((key) => key.startsWith(clientDistDir) && !allowed.includes(key));
  if (early.length) throw new Error(`the client was loaded before the host was registered: ${early.join(', ')}`);
}
