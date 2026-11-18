// The two optional notifiers. Both are off unless pod.json turns them on, and both get only new
// picks at the top two levels. A send is at least once: the caller saves how far it got after the
// send, so a crash between the two sends the same picks again rather than losing them.
import type { LoadedConfig } from '../config';
import type { PickView } from '../plugin-api';
import { sendNtfy } from './ntfy';
import { sendWebhook } from './webhook';

export const NOTIFY_LEVELS: readonly PickView['level'][] = ['emergency', 'high'];

export interface Notifier {
  /** Rejects when any target failed. A target that worked may be sent the same picks again on the retry. */
  send(picks: readonly PickView[]): Promise<void>;
}

/** Undefined when no notifier is configured. */
export function createNotifier(cfg: LoadedConfig): Notifier | undefined {
  const { ntfy, webhook } = cfg.notify;
  if (!ntfy && !webhook) return undefined;
  return {
    async send(picks) {
      const results = await Promise.allSettled([ntfy ? sendNtfy(ntfy.url, picks) : undefined, webhook ? sendWebhook(webhook.url, picks) : undefined]);
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      // The reason names the target and the status only, never the picks or the address.
      if (failed.length) throw new Error(failed.map((f) => String(f.reason?.message ?? f.reason)).join('; '));
    },
  };
}
