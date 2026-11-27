// The two optional notifiers. Both are off unless pod.json turns them on, and both get only new
// picks at the top two levels. A send is at least once: the caller saves how far it got after the
// send, so a crash between the two sends the same picks again rather than losing them.
import type { LoadedConfig } from '../config';
import type { PickView } from '../plugin-api';
import { sendNtfy } from './ntfy';
import { sendWebhook } from './webhook';

export const NOTIFY_LEVELS: readonly PickView['level'][] = ['emergency', 'high'];

/** Rejected by a target when some picks were delivered before it failed: those are not sent again. */
export class PartialSendError extends Error {
  constructor(
    message: string,
    readonly delivered: number,
  ) {
    super(message);
  }
}

/** One delivery target. Targets never wait on each other: the caller keeps a position for each. */
export interface NotifyTarget {
  name: 'ntfy' | 'webhook';
  /** Rejects when it failed; a PartialSendError says how many of the first picks got through. `signal` ends a paced burst. */
  send(picks: readonly PickView[]): Promise<void>;
}

/** Empty when no notifier is configured. The reason of a failure names the target and the status only, never the picks or the address. */
export function createNotifier(cfg: LoadedConfig, pace?: number, signal?: AbortSignal): NotifyTarget[] {
  const { ntfy, webhook } = cfg.notify;
  const targets: NotifyTarget[] = [];
  if (ntfy) {
    targets.push({
      name: 'ntfy',
      async send(picks) {
        let sent = 0;
        try {
          await sendNtfy(ntfy.url, picks, pace, (n) => (sent = n), signal);
        } catch (error) {
          const message = String((error as Error)?.message ?? error);
          throw sent > 0 ? new PartialSendError(message, sent) : new Error(message);
        }
      },
    });
  }
  if (webhook) targets.push({ name: 'webhook', send: (picks) => sendWebhook(webhook.url, picks, signal) });
  return targets;
}
