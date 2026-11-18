import type { PickView } from '../plugin-api';

const SEND_TIMEOUT_MS = 10_000;

/**
 * One request with every new pick: `{ "picks": [{ title, url, level, reason }] }`. The person's own
 * endpoint gets the reason; no saved fact is ever sent.
 */
export async function sendWebhook(url: string, picks: readonly PickView[]): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ picks: picks.map(({ title, url: link, level, reason }) => ({ title, url: link, level, reason })) }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`the webhook answered ${res.status}`);
}
