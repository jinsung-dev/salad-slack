import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { Channel, Invite, Member, User, Workspace } from "@chatter/shared";
import { emailCodes } from "../src/db/schema";
import type { MailMessage } from "../src/mail";
import { sessionClient, signIn, uniqueName, useCluster, type Client } from "./helpers";

// Company people (example.test) sign in with the provider; outside guests get codes by mail.
const sent: MailMessage[] = [];
let mailDown = false;
const { urls, db } = useCluster(1, {
  allowedEmailDomains: ["example.test"],
  mailer: async (message) => {
    if (mailDown) throw new Error("smtp unavailable");
    sent.push(message);
  },
});
const base = () => urls[0]!;
const ws = (id: string, rest = "") => `/api/workspaces/${id}${rest}`;
let n = 0;
const outsider = () => `guest-${Date.now()}-${n++}@partner.test`;

async function post(path: string, body: unknown) {
  const res = await fetch(`${base()}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const session = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .find((c) => c.startsWith("sid=") && c.length > 4);
  return { status: res.status, body: res.status === 204 ? null : ((await res.json()) as { error?: string }), session };
}
const lastCodeFor = (email: string) => {
  const mail = sent.findLast((m) => m.to === email);
  return mail?.text.match(/\b(\d{6})\b/)?.[1];
};
/** Lets the next code for `email` be requested without waiting out the resend delay. */
const backdateCodes = (email: string) =>
  db.update(emailCodes).set({ createdAt: sql`now() - interval '2 minutes'` }).where(eq(emailCodes.email, email));

async function guestInvite(owner: Client, email: string | null, role = "guest") {
  const w = (await owner.call<Workspace>("POST", "/api/workspaces", { name: "Acme" })).body;
  const project = (await owner.call<Channel>("POST", ws(w.id, "/channels"), { name: uniqueName(), isPrivate: true })).body;
  const lobby = (await owner.call<Channel>("POST", ws(w.id, "/channels"), { name: uniqueName() })).body;
  const inv = (await owner.call<Invite>("POST", ws(w.id, "/invites"), { role, email, ...(role === "guest" ? { channelId: project.id } : {}) })).body;
  return { w, project, lobby, token: inv.url!.split("/invite/")[1]! };
}

/** Runs the whole flow for a new guest and returns their signed-in client. */
async function signInGuest(email: string, token: string, displayName = "Partner") {
  expect((await post("/api/auth/email/start", { email, inviteToken: token })).status).toBe(204);
  const verified = await post("/api/auth/email/verify", { email, code: lastCodeFor(email), displayName });
  expect(verified.status).toBe(204);
  return sessionClient(base(), verified.session!, email);
}

describe("email sign-in for outside guests", () => {
  it("signs a guest in with the mailed code and keeps them to the invited channel", async () => {
    const owner = await signIn(base(), "owner");
    const email = outsider();
    const { w, project, lobby, token } = await guestInvite(owner, email);

    const guest = await signInGuest(email, token, "Kim Partner");
    const mail = sent.at(-1)!;
    expect(mail.to).toBe(email);
    expect(mail.subject).toContain(lastCodeFor(email));
    expect((await guest.call<User>("GET", "/api/auth/me")).body).toMatchObject({ email, displayName: "Kim Partner", guestOnly: true });

    expect((await guest.call("POST", `/api/invites/${token}/accept`)).body).toEqual({ workspaceId: w.id, channelId: project.id });
    expect((await guest.call<Channel[]>("GET", ws(w.id, "/channels"))).body.map((c) => c.id)).toEqual([project.id]);
    expect((await guest.call("GET", `/api/channels/${lobby.id}/messages`)).status).toBe(404);
    const member = (await owner.call<Member[]>("GET", ws(w.id, "/members"))).body.find((m) => m.id === guest.id)!;
    expect(member).toMatchObject({ role: "guest", guestOnly: true });
  });

  it("sends codes only to the invited address of a guest invite, never to company or provider accounts", async () => {
    const owner = await signIn(base(), "owner");
    const email = outsider();
    const { token } = await guestInvite(owner, email);
    const before = sent.length;

    expect((await post("/api/auth/email/start", { email: outsider(), inviteToken: token })).body).toEqual({ error: "invite_for_other_email" });
    expect((await post("/api/auth/email/start", { email: owner.email, inviteToken: token })).body).toEqual({ error: "use_provider" });
    expect((await post("/api/auth/email/start", { email, inviteToken: "not-a-real-token-123456" })).status).toBe(404);
    const memberInvite = await guestInvite(owner, email, "member");
    expect((await post("/api/auth/email/start", { email, inviteToken: memberInvite.token })).body).toEqual({ error: "invite_for_other_email" });
    // An invite without an address names nobody to mail.
    const open = await guestInvite(owner, null);
    expect((await post("/api/auth/email/start", { email, inviteToken: open.token })).body).toEqual({ error: "invite_for_other_email" });
    expect(sent.length).toBe(before);
  });

  it("accepts only the newest unexpired code, once, and gives up after five wrong tries", async () => {
    const owner = await signIn(base(), "owner");
    const email = outsider();
    const { token } = await guestInvite(owner, email);

    await post("/api/auth/email/start", { email, inviteToken: token });
    const first = lastCodeFor(email)!;
    expect((await post("/api/auth/email/start", { email, inviteToken: token })).status).toBe(429);
    await backdateCodes(email);
    await post("/api/auth/email/start", { email, inviteToken: token });
    const second = lastCodeFor(email)!;
    // A superseded code is just a wrong guess against the newest one.
    const wrong = [first, "000000", "111111"].find((c) => c !== second)!;
    for (let i = 0; i < 4; i++) expect((await post("/api/auth/email/verify", { email, code: wrong })).body).toEqual({ error: "invalid_code" });
    expect((await post("/api/auth/email/verify", { email, code: wrong })).body).toEqual({ error: "code_expired" });
    expect((await post("/api/auth/email/verify", { email, code: second })).body).toEqual({ error: "code_expired" });

    await backdateCodes(email);
    await post("/api/auth/email/start", { email, inviteToken: token });
    const third = lastCodeFor(email)!;
    await db.update(emailCodes).set({ expiresAt: sql`now() - interval '1 second'` }).where(eq(emailCodes.email, email));
    expect((await post("/api/auth/email/verify", { email, code: third })).body).toEqual({ error: "code_expired" });

    await backdateCodes(email);
    await post("/api/auth/email/start", { email, inviteToken: token });
    const fourth = lastCodeFor(email)!;
    expect((await post("/api/auth/email/verify", { email, code: fourth })).status).toBe(204);
    expect((await post("/api/auth/email/verify", { email, code: fourth })).body).toEqual({ error: "code_expired" });
  });

  it("lets a returning guest sign in with the address alone, and answers unknown addresses the same way without mail", async () => {
    const owner = await signIn(base(), "owner");
    const email = outsider();
    const { token } = await guestInvite(owner, email);
    const first = await signInGuest(email, token);
    await backdateCodes(email);

    const before = sent.length;
    expect((await post("/api/auth/email/start", { email: outsider() })).status).toBe(204);
    expect((await post("/api/auth/email/start", { email: owner.email })).body).toEqual({ error: "use_provider" });
    expect(sent.length).toBe(before);

    expect((await post("/api/auth/email/start", { email })).status).toBe(204);
    expect(sent.length).toBe(before + 1);
    const again = await post("/api/auth/email/verify", { email, code: lastCodeFor(email) });
    expect(again.status).toBe(204);
    expect((await (await sessionClient(base(), again.session!, email)).call<User>("GET", "/api/auth/me")).body.id).toBe(first.id);
  });

  it("keeps guest accounts guests", async () => {
    const owner = await signIn(base(), "owner");
    const email = outsider();
    const { w, token } = await guestInvite(owner, email);
    const guest = await signInGuest(email, token);
    await guest.call("POST", `/api/invites/${token}/accept`);

    expect((await guest.call("POST", "/api/workspaces", { name: "Mine" })).body).toEqual({ error: "guest_account_only" });
    expect((await guest.call("GET", "/api/workspaces/joinable")).body).toEqual([]);
    const promoted = await owner.call("PUT", ws(w.id, `/members/${guest.id}/role`), { role: "member" });
    expect(promoted.body).toEqual({ error: "guest_account_only" });
    const memberLink = (await owner.call<Invite>("POST", ws(w.id, "/invites"), { role: "member" })).body;
    expect((await guest.call("POST", `/api/invites/${memberLink.url!.split("/invite/")[1]}/accept`)).body).toEqual({ error: "guest_account_only" });
    expect((await guest.call<Workspace[]>("GET", "/api/workspaces")).body.map((x) => x.role)).toEqual(["guest"]);
  });

  it("reports a mail failure and leaves no usable code behind", async () => {
    const owner = await signIn(base(), "owner");
    const email = outsider();
    const { token } = await guestInvite(owner, email);
    mailDown = true;
    try {
      expect((await post("/api/auth/email/start", { email, inviteToken: token })).body).toEqual({ error: "email_send_failed" });
    } finally {
      mailDown = false;
    }
    expect(await db.select().from(emailCodes).where(eq(emailCodes.email, email))).toEqual([]);
    // Nothing waits a minute after a failed send.
    expect((await post("/api/auth/email/start", { email, inviteToken: token })).status).toBe(204);
  });
});
