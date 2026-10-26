import { createHmac } from "node:crypto";
import dns, { type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

// Single owner of requests Chatter sends to apps (events, commands, clicks).
// App URLs are chosen by workspace admins, so a request must never reach this
// server's own network: addresses are checked when the connection is made,
// which also covers DNS answers that change between check and use.

export interface OutboundPolicy {
  /** Tests and local development only: allow plain HTTP and private addresses. */
  allowPrivate: boolean;
}

export type OutboundFailure = "invalid_url" | "blocked_address" | "timeout" | "network" | "too_large";

export class OutboundError extends Error {
  constructor(readonly reason: OutboundFailure, message: string) {
    super(message);
  }
}

export interface OutboundResponse {
  status: number;
  /** Parsed JSON body, or null when the body is empty or not JSON. */
  json: unknown;
}

const MAX_RESPONSE_BYTES = 256 * 1024;

/** Loopback, private, link-local, carrier-grade NAT, multicast and unspecified ranges. */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
    );
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return isPrivateAddress(v.slice(7));
  return v === "::" || v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb") || v.startsWith("ff");
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

function guardedLookup(allowPrivate: boolean) {
  return (hostname: string, options: dns.LookupOptions, callback: LookupCallback) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, "");
      const blocked = !allowPrivate && addresses.find((a) => isPrivateAddress(a.address));
      if (blocked) return callback(new OutboundError("blocked_address", `${hostname} resolves to ${blocked.address}`), "");
      if (options.all) return callback(null, addresses);
      const first = addresses[0]!;
      return callback(null, first.address, first.family);
    });
  };
}

/** `v1=<hex HMAC-SHA256 of "v1:<timestamp>:<body>">`, the signature apps verify. */
export function signature(secret: string, timestamp: number, body: string): string {
  return `v1=${createHmac("sha256", secret).update(`v1:${timestamp}:${body}`).digest("hex")}`;
}

/** POSTs JSON signed with the app's secret. Never follows redirects. */
export function postSigned(
  url: string,
  payload: unknown,
  secret: string,
  { allowPrivate }: OutboundPolicy,
  { timeoutMs = 3000, headers = {} }: { timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<OutboundResponse> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return Promise.reject(new OutboundError("invalid_url", url));
  }
  const httpsOnly = !allowPrivate;
  if (target.protocol !== "https:" && !(target.protocol === "http:" && !httpsOnly)) {
    return Promise.reject(new OutboundError("invalid_url", "app URLs must use HTTPS"));
  }
  // An IP literal skips DNS, so it is checked here.
  const host = target.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && !allowPrivate && isPrivateAddress(host)) {
    return Promise.reject(new OutboundError("blocked_address", host));
  }

  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const transport = target.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(
      target,
      {
        method: "POST",
        lookup: guardedLookup(allowPrivate) as never,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "user-agent": "Chatter-Apps/1",
          "x-chatter-request-timestamp": String(timestamp),
          "x-chatter-signature": signature(secret, timestamp, body),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            req.destroy(new OutboundError("too_large", "response too large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: unknown = null;
          if (text && /json/i.test(res.headers["content-type"] ?? "")) {
            try {
              json = JSON.parse(text);
            } catch {
              json = null;
            }
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new OutboundError("timeout", `no response in ${timeoutMs} ms`)));
    req.on("error", (err) => reject(err instanceof OutboundError ? err : new OutboundError("network", err.message)));
    req.end(body);
  });
}
