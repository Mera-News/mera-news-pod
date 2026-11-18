import type { PickView } from '../plugin-api';

const SEND_TIMEOUT_MS = 10_000;

// A header carries one line of Latin-1 text, so a title in another script is sent as an encoded word
// (RFC 2047), which ntfy decodes.
const header = (text: string) => {
  const line = text.replace(/[\r\n]+/g, ' ').trim();
  return /^[\x20-\x7e]*$/.test(line) ? line : `=?UTF-8?B?${Buffer.from(line, 'utf8').toString('base64')}?=`;
};

/**
 * One message per pick: the headline, its level and the link, nothing else. An ntfy topic can be
 * read by anyone who knows its name, and a reason is written from the person's profile.
 */
export async function sendNtfy(url: string, picks: readonly PickView[]): Promise<void> {
  for (const pick of picks) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Title: header(pick.title), Tags: pick.level, Click: pick.url, 'Content-Type': 'text/plain; charset=utf-8' },
      body: pick.url,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`ntfy answered ${res.status}`);
  }
}
