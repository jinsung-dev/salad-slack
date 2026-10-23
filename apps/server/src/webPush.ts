import webpush, { WebPushError } from "web-push";
import type { PushSender } from "./notify";

export interface VapidConfig {
  /** `mailto:` or `https:` contact for push services. */
  subject: string;
  publicKey: string;
  privateKey: string;
}

/** Delivers through the browser vendors' push services (RFC 8030/8291 with VAPID). */
export function webPushSender(vapid: VapidConfig): PushSender {
  return async (target, payload) => {
    try {
      await webpush.sendNotification({ endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } }, payload, {
        vapidDetails: vapid,
        TTL: 60 * 60,
      });
      return { gone: false };
    } catch (err) {
      // The browser unsubscribed or the subscription expired.
      if (err instanceof WebPushError && (err.statusCode === 404 || err.statusCode === 410)) return { gone: true };
      throw err;
    }
  };
}
