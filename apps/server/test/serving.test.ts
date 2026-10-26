import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { oidcSignIn, useCluster } from "./helpers";

const webDist = mkdtempSync(join(tmpdir(), "chatter-web-"));
writeFileSync(join(webDist, "index.html"), "<!doctype html><title>Chatter</title>");
writeFileSync(join(webDist, "app.js"), "console.log('app')");

const { urls } = useCluster(1, { allowedEmailDomains: ["saladlab.co"], authRateLimit: 3, webDist });
const base = () => urls[0]!;

describe("serving the app for others to use", () => {
  it("serves the web app, its client routes, and JSON 404s for unknown API paths", async () => {
    for (const path of ["/", "/login", "/c/some-channel/t/12"]) {
      const res = await fetch(`${base()}${path}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("<title>Chatter</title>");
    }
    expect(await (await fetch(`${base()}/app.js`)).text()).toContain("console.log");
    const missing = await fetch(`${base()}/api/nope`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not_found" });
    expect(await (await fetch(`${base()}/api/health`)).json()).toEqual({ ok: true });
  });

  it("answers malformed JSON with 400, not a server error", async () => {
    const res = await fetch(`${base()}/api/workspaces`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request" });
  });

  it("admits only the allowed Workspace domain, then rate-limits sign-in attempts", async () => {
    const allowed = await oidcSignIn(base(), { email: `kim-${crypto.randomUUID()}@SaladLab.co`, name: "Kim" });
    expect(allowed.location).toBe("/");
    expect(allowed.session).toBeDefined();

    for (const outsider of ["eve@gmail.com", "eve@saladlab.co.evil.com"]) {
      const refused = await oidcSignIn(base(), { email: outsider, name: "Eve" });
      expect(refused).toMatchObject({ location: "/login?error=email_domain_not_allowed", session: undefined });
    }

    // Three starts used above; the fourth in the same minute is refused.
    const limited = await fetch(`${base()}/api/auth/oidc/start`, { redirect: "manual" });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited" });
  });
});
