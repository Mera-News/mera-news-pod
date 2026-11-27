// The two optional notifiers. Both are off unless pod.json turns them on, and both get only new
// picks at the top two levels. A send is at least once: the caller saves how far it got after the
// send, so a crash between the two sends the same picks again rather than losing them.
import type { LoadedConfig } from '../config';
import type { PickView } from '../plugin-api';
import { sendNtfy } from './ntfy';
import { sendWebhook } from './webhook';

export const NOTIFY_LEVELS: readonly PickView['level'][] = ['emergency', 'high'];

/** Rejected by `send` when some picks were delivered before a target failed: those are not sent again. */
export class PartialSendError extends Error {
  constructor(
    message: string,
    readonly delivered: number,
  ) {
    super(message);
  }
}

export interface Notifier {
  /**
   * Rejects when any target failed. Picks are delivered in order; a rejection with `delivered` picks
   * (a PartialSendError) means exactly the first `delivered` reached every target.
   */
  send(picks: readonly PickView[]): Promise<void>;
}

/** Undefined when no notifier is configured. */
export function createNotifier(cfg: LoadedConfig, pace?: number): Notifier | undefined {
  const { ntfy, webhook } = cfg.notify;
  if (!ntfy && !webhook) return undefined;
  return {
    // ntfy goes first, one paced message per pick, and the webhook gets the picks ntfy delivered in one request,
    // so a 429 part way leaves the rest for the retry instead of sending the whole batch again.
    async send(picks) {
      let sent = picks.length;
      let failure: unknown;
      if (ntfy) {
        sent = 0;
        try {
          await sendNtfy(ntfy.url, picks, pace, (n) => (sent = n));
        } catch (error) {
          failure = error;
        }
      }
      let delivered = sent;
      if (webhook && sent > 0) {
        try {
          await sendWebhook(webhook.url, picks.slice(0, sent));
        } catch (error) {
          delivered = 0;
          failure ??= error;
        }
      }
      // The reason names the target and the status only, never the picks or the address.
      if (failure) {
        const message = String((failure as Error)?.message ?? failure);
        if (delivered > 0) throw new PartialSendError(message, delivered);
        throw new Error(message);
      }
    },
  };
}
