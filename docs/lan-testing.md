# Office LAN testing

Run Chatter on one Mac so coworkers on the same office network can use it
before a real deployment.

Sign-in is Google only, and Google requires an HTTPS redirect on a real
domain name, so `http://192.168.0.202:3001` alone is not enough: see
[google-sign-in.md](google-sign-in.md) and pick a way to give this Mac an HTTPS
name (below). The server refuses to start with the fake development provider
while `HOST` accepts other machines.

## Start

```bash
pnpm db:up
pnpm start          # builds the web app, then serves web + API + WebSocket on :3001
caffeinate -dimsu   # in another terminal: keeps the Mac awake while it runs
```

`.env` needs:

```bash
HOST=0.0.0.0                       # accept other machines
ALLOWED_EMAIL_DOMAINS=saladlab.co  # only company Google accounts
# plus the OIDC_* and PUBLIC_URL settings from google-sign-in.md
```

Find the address to share:

```bash
ipconfig getifaddr en0   # e.g. 192.168.0.202 → http://192.168.0.202:3001
```

## Giving this Mac an HTTPS name

| Option | Who can reach it | Needs |
| --- | --- | --- |
| Company DNS name + local TLS proxy | Office network only | A DNS record such as `chatter.saladlab.co` → this Mac's address, a certificate (e.g. Caddy with a DNS challenge), IT to add the record |
| Tunnel service with a fixed HTTPS domain (Cloudflare Tunnel, ngrok) | Anyone with the URL; sign-in still requires a company Google account | An account with the tunnel service; one command on this Mac |

Register `https://<that name>/api/auth/oidc/callback` as the redirect URI and
set `PUBLIC_URL` to `https://<that name>`, `COOKIE_SECURE=true`,
`TRUST_PROXY=true`.

## What is and is not exposed

| Port | Service | Reachable from the network |
| --- | --- | --- |
| 3001 | Chatter (web, API, WebSocket) | yes |
| 54329 | Postgres | no, bound to 127.0.0.1 |
| 56379 | Redis | no, bound to 127.0.0.1 |

Sign-in is limited to 10 attempts per minute per address.

## Limits

- The service stops when the Mac sleeps, closes its lid, restarts or leaves
  the network. Use this for a few days with a few people, not for the
  two-week Phase 2 gate.
- The Wi-Fi address can change after reconnecting; re-check it with
  `ipconfig getifaddr en0` and tell testers.
- Data lives in this Mac's Docker volume. Back it up before `docker compose down -v`.

## Stop

`Ctrl+C` in the `pnpm start` terminal (or `pkill -f "src/index.ts"`), then
`pnpm db:down` if you also want the database stopped.
