import type { PickView } from '../plugin-api';

const SEND_TIMEOUT_MS = 10_000;
export const NTFY_PACE_MS = 500;

// A header carries one line of Latin-1 text, so a title in another script is sent as an encoded word
// (RFC 2047), which ntfy decodes.
const header = (text: string) => {
  const line = text.replace(/[\r\n]+/g, ' ').trim();
  return /^[\x20-\x7e]*$/.test(line) ? line : `=?UTF-8?B?${Buffer.from(line, 'utf8').toString('base64')}?=`;
};

/** A pause the signal ends at once: the timer is cleared, never left to fire after its owner stopped. */
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('stopped'));
    const timer = setTimeout(() => (signal?.removeEventListener('abort', stop), resolve()), ms);
    const stop = () => (clearTimeout(timer), reject(new Error('stopped')));
    signal?.addEventListener('abort', stop, { once: true });
  });

/**
 * One message per pick: the headline, its level and the link, nothing else. An ntfy topic can be
 * read by anyone who knows its name, and a reason is written from the person's profile.
 */
export async function sendNtfy(url: string, picks: readonly PickView[], paceMs = NTFY_PACE_MS, onSent?: (count: number) => void, signal?: AbortSignal): Promise<void> {
  for (const [i, pick] of picks.entries()) {
    // A burst of hundreds of picks would hit ntfy's rate limit: one message at a time, spaced.
    if (i > 0 && paceMs > 0) await sleep(paceMs, signal);
    const res = await fetch(url, {
      method: 'POST',
      headers: { Title: header(pick.title), Tags: pick.level, Click: pick.url, 'Content-Type': 'text/plain; charset=utf-8' },
      body: pick.url,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(SEND_TIMEOUT_MS)]) : AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`ntfy answered ${res.status}`);
    onSent?.(i + 1);
  }
}
