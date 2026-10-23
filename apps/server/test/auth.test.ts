import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { users } from "../src/db/schema";
import { oidcSignIn, signIn, useCluster } from "./helpers";

const { urls, db } = useCluster();
const base = () => urls[0]!;
const email = () => `kim-${randomUUID()}@example.test`;

describe("sign-in with the identity provider", () => {
  it("creates the account on first sign-in and returns to it afterwards", async () => {
    const address = email();
    const first = await signIn(base(), "Kim", address);
    expect((await first.call("GET", "/api/auth/me")).body).toMatchObject({ id: first.id, email: address, displayName: "Kim" });
    const again = await signIn(base(), "Kim renamed", address);
    expect(again.id).toBe(first.id);

    expect((await first.call("POST", "/api/auth/logout")).status).toBe(204);
    expect((await first.call("GET", "/api/auth/me")).status).toBe(401);
    expect((await again.call("GET", "/api/auth/me")).status).toBe(200); // other sessions survive
  });

  it("refuses unverified emails", async () => {
    const result = await oidcSignIn(base(), { email: email(), name: "x", emailVerified: false });
    expect(result).toMatchObject({ status: 302, location: "/login?error=email_not_verified", session: undefined });
  });

  it("refuses a callback without the browser's pending login", async () => {
    const start = await fetch(`${base()}/api/auth/oidc/start`, { redirect: "manual" });
    const authorize = new URL(start.headers.get("location")!);
    const form = new URLSearchParams(authorize.searchParams);
    form.set("login_email", email());
    form.set("login_name", "x");
    form.set("login_email_verified", "true");
    const consent = await fetch(`${authorize.origin}/authorize`, { method: "POST", body: form, redirect: "manual" });
    // An attacker's callback URL opened without the login cookie.
    const done = await fetch(consent.headers.get("location")!, { redirect: "manual" });
    expect(done.headers.get("location")).toBe("/login?error=login_expired");
  });

  it("refuses a callback whose state does not match the browser's login", async () => {
    const victimStart = await fetch(`${base()}/api/auth/oidc/start`, { redirect: "manual" });
    const victimCookie = victimStart.headers.getSetCookie()[0]!.split(";")[0]!;
    const authorize = new URL(victimStart.headers.get("location")!);
    const form = new URLSearchParams(authorize.searchParams);
    form.set("state", "forged");
    form.set("login_email", email());
    form.set("login_name", "x");
    form.set("login_email_verified", "true");
    const consent = await fetch(`${authorize.origin}/authorize`, { method: "POST", body: form, redirect: "manual" });
    const done = await fetch(consent.headers.get("location")!, { headers: { cookie: victimCookie }, redirect: "manual" });
    expect(done.headers.get("location")).toBe("/login?error=oidc_failed");
  });

  it("links an existing account with the same email once, and refuses a different provider account later", async () => {
    const address = email();
    const [legacy] = await db.insert(users).values({ email: address, displayName: "Legacy" }).returning({ id: users.id });
    const linked = await signIn(base(), "Kim", address);
    expect(linked.id).toBe(legacy!.id);

    // The same email arriving with a new provider subject (e.g. a recreated account).
    await db.update(users).set({ oidcSubject: "someone-else" }).where(eq(users.id, legacy!.id));
    const result = await oidcSignIn(base(), { email: address, name: "Kim" });
    expect(result.location).toBe("/login?error=account_conflict");
  });
});
