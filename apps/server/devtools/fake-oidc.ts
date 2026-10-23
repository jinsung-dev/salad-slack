import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

/**
 * A stand-in for Google's OpenID Connect provider, for tests and local
 * development without real Google credentials. It implements the parts
 * Chatter uses: discovery, an authorize page (pick any email), the code
 * exchange with PKCE, and signed ID tokens with Google's claims
 * (`email_verified`, `hd` for Workspace domains). Never run it in production.
 */

export interface FakeOidc {
  issuer: string;
  close(): Promise<void>;
}

interface PendingCode {
  redirectUri: string;
  codeChallenge: string;
  nonce: string | undefined;
  email: string;
  name: string;
  emailVerified: boolean;
}

const PERSONAL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);
const b64url = (buf: Buffer) => buf.toString("base64url");

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function authorizePage(params: URLSearchParams): string {
  const hidden = [...params]
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join("");
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>Fake Google 로그인</title>
<style>body{font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#f1f3f4}
form{background:#fff;padding:28px;border-radius:12px;display:flex;flex-direction:column;gap:10px;width:320px}
input{padding:9px;font:inherit}button{padding:9px;font:inherit}</style></head>
<body><form method="post" action="/authorize"><h1 style="margin:0;font-size:20px">Fake Google 로그인</h1>
<p style="margin:0;color:#666">개발·테스트용 가짜 로그인입니다.</p>${hidden}
<input name="login_email" type="email" placeholder="이메일" required>
<input name="login_name" placeholder="이름" required>
<label><input type="checkbox" name="login_email_verified" value="true" checked> 이메일 인증됨</label>
<button type="submit">계속</button></form></body></html>`;
}

export async function startFakeOidc({
  port = 0,
  clientId,
  clientSecret,
}: {
  port?: number;
  clientId: string;
  clientSecret: string;
}): Promise<FakeOidc> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "fake-1", alg: "RS256", use: "sig" };
  const codes = new Map<string, PendingCode>();
  let issuer = "";

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", issuer);
    try {
      if (req.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
        return json(res, 200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
          scopes_supported: ["openid", "email", "profile"],
        });
      }
      if (req.method === "GET" && url.pathname === "/jwks") return json(res, 200, { keys: [jwk] });

      if (req.method === "GET" && url.pathname === "/authorize") {
        if (url.searchParams.get("client_id") !== clientId) return json(res, 400, { error: "invalid_client" });
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(authorizePage(url.searchParams));
      }

      if (req.method === "POST" && url.pathname === "/authorize") {
        const form = await readForm(req);
        const redirectUri = form.get("redirect_uri");
        const challenge = form.get("code_challenge");
        if (form.get("client_id") !== clientId || !redirectUri || !challenge || form.get("code_challenge_method") !== "S256") {
          return json(res, 400, { error: "invalid_request" });
        }
        const code = b64url(randomBytes(24));
        codes.set(code, {
          redirectUri,
          codeChallenge: challenge,
          nonce: form.get("nonce") ?? undefined,
          email: form.get("login_email") ?? "",
          name: form.get("login_name") ?? "",
          emailVerified: form.get("login_email_verified") === "true",
        });
        const back = new URL(redirectUri);
        back.searchParams.set("code", code);
        const state = form.get("state");
        if (state) back.searchParams.set("state", state);
        res.writeHead(302, { location: back.toString() });
        return res.end();
      }

      if (req.method === "POST" && url.pathname === "/token") {
        const form = await readForm(req);
        const basic = req.headers.authorization?.startsWith("Basic ")
          ? Buffer.from(req.headers.authorization.slice(6), "base64").toString().split(":").map(decodeURIComponent)
          : null;
        const [id, secret] = basic ?? [form.get("client_id"), form.get("client_secret")];
        if (id !== clientId || secret !== clientSecret) return json(res, 401, { error: "invalid_client" });

        const pending = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        if (
          !pending ||
          form.get("redirect_uri") !== pending.redirectUri ||
          b64url(createHash("sha256").update(verifier).digest()) !== pending.codeChallenge
        ) {
          return json(res, 400, { error: "invalid_grant" });
        }
        const domain = pending.email.split("@").at(-1)!.toLowerCase();
        const idToken = await new SignJWT({
          email: pending.email,
          email_verified: pending.emailVerified,
          name: pending.name,
          ...(PERSONAL_DOMAINS.has(domain) ? {} : { hd: domain }),
          ...(pending.nonce ? { nonce: pending.nonce } : {}),
        })
          .setProtectedHeader({ alg: "RS256", kid: jwk.kid })
          .setIssuer(issuer)
          .setAudience(clientId)
          .setSubject(createHash("sha256").update(pending.email.toLowerCase()).digest("hex").slice(0, 21))
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(privateKey);
        return json(res, 200, { access_token: b64url(randomBytes(16)), token_type: "Bearer", expires_in: 3600, id_token: idToken });
      }

      json(res, 404, { error: "not_found" });
    } catch (err) {
      json(res, 500, { error: String(err) });
    }
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address();
  issuer = `http://127.0.0.1:${typeof address === "object" && address ? address.port : port}`;
  return {
    issuer,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// `tsx devtools/fake-oidc.ts` runs it standalone for local development and E2E.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const oidc = await startFakeOidc({
    port: Number(process.env.FAKE_OIDC_PORT ?? 3999),
    clientId: process.env.OIDC_CLIENT_ID ?? "chatter-dev",
    clientSecret: process.env.OIDC_CLIENT_SECRET ?? "dev-secret",
  });
  console.log(`fake OIDC provider at ${oidc.issuer} (development only)`);
}
