import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Channel, Invite, InvitePreview, JoinableWorkspace, Member, Message, MessagePage, PresenceMap, Webhook, Workspace } from "@chatter/shared";
import { invites, workspaceMembers } from "../src/db/schema";
import { expireMemberships } from "../src/workspaces";
import { connect, signIn, uniqueName, useCluster, type Client } from "./helpers";

const cluster = useCluster();
const { urls, db } = cluster;
const base = () => urls[0]!;

const ws = (id: string, rest = "") => `/api/workspaces/${id}${rest}`;

async function createWorkspace(owner: Client, name = "Team", joinDomain: string | null = null) {
  return (await owner.call<Workspace>("POST", "/api/workspaces", { name, joinDomain })).body;
}
async function invite(
  admin: Client,
  workspaceId: string,
  body: { role?: string; email?: string | null; channelId?: string; guestDays?: number } = {},
) {
  return admin.call<Invite>("POST", ws(workspaceId, "/invites"), body);
}
const tokenOf = (inv: Invite) => inv.url!.split("/invite/")[1]!;
async function join(who: Client, workspaceId: string, by: Client, role = "member") {
  const inv = (await invite(by, workspaceId, { role })).body;
  expect((await who.call("POST", `/api/invites/${tokenOf(inv)}/accept`)).status).toBe(200);
}
const channel = async (who: Client, workspaceId: string, extra: Record<string, unknown> = {}) =>
  who.call<Channel>("POST", ws(workspaceId, "/channels"), { name: uniqueName(), ...extra });
const post = async (who: Client, channelId: string, text: string) =>
  (await who.call<Message>("POST", `/api/channels/${channelId}/messages`, { text, clientMsgId: crypto.randomUUID() })).body;

describe("workspace isolation", () => {
  async function twoTeams() {
    const [alice, bob, carol] = [await signIn(base(), "alice"), await signIn(base(), "bob"), await signIn(base(), "carol")];
    const a = await createWorkspace(alice, "A");
    const b = await createWorkspace(bob, "B");
    await join(carol, a.id, alice);
    await join(carol, b.id, bob);
    return { alice, bob, carol, a, b };
  }

  it("keeps channels, history, posting, search and saved messages inside their workspace", async () => {
    const { alice, bob, carol, a, b } = await twoTeams();
    const inA = (await channel(alice, a.id)).body;
    const inB = (await channel(bob, b.id)).body;
    const tag = crypto.randomUUID().slice(0, 6);
    await post(alice, inA.id, `${tag} plan A`);
    const secretB = await post(bob, inB.id, `${tag} plan B`);

    expect((await alice.call<Channel[]>("GET", ws(a.id, "/channels"))).body.map((c) => c.id)).toEqual([inA.id]);
    expect((await alice.call("GET", ws(b.id, "/channels"))).status).toBe(404);
    expect((await alice.call("GET", `/api/channels/${inB.id}/messages`)).status).toBe(404);
    expect((await alice.call("GET", `/api/channels/${inB.id}`)).status).toBe(404);
    expect((await carol.call<Channel>("GET", `/api/channels/${inB.id}`)).body).toMatchObject({ workspaceId: b.id, isMember: false });
    expect((await alice.call("POST", `/api/channels/${inB.id}/join`)).status).toBe(404);
    expect((await alice.call("POST", `/api/channels/${inB.id}/messages`, { text: "x", clientMsgId: "x" })).status).toBe(404);
    expect((await alice.call("GET", `/api/messages/${secretB.id}`)).status).toBe(404);
    expect((await alice.call("PUT", `/api/messages/${secretB.id}/save`)).status).toBe(404);

    const searchIn = async (who: Client, workspaceId: string) =>
      (await who.call<MessagePage>("GET", `/api/search?workspaceId=${workspaceId}&q=${tag}`)).body.messages.map((m) => m.text);
    expect(await searchIn(alice, a.id)).toEqual([`${tag} plan A`]);
    expect((await alice.call("GET", `/api/search?workspaceId=${b.id}&q=${tag}`)).status).toBe(404);
    // Carol is in both, and still sees each workspace's results only there.
    expect(await searchIn(carol, a.id)).toEqual([`${tag} plan A`]);
    expect(await searchIn(carol, b.id)).toEqual([`${tag} plan B`]);

    await carol.call("PUT", `/api/messages/${secretB.id}/save`);
    expect((await carol.call<MessagePage>("GET", ws(a.id, "/saved"))).body.messages).toEqual([]);
    expect((await carol.call<MessagePage>("GET", ws(b.id, "/saved"))).body.messages.map((m) => m.id)).toEqual([secretB.id]);
  });

  it("keeps files, people, presence and DMs inside their workspace", async () => {
    const { alice, bob, carol, a, b } = await twoTeams();
    const inB = (await channel(bob, b.id)).body;
    const form = new FormData();
    form.append("file", new Blob(["b-only"], { type: "text/plain" }), "b.txt");
    const file = await (await fetch(`${base()}/api/channels/${inB.id}/files`, { method: "POST", headers: { cookie: bob.cookie }, body: form })).json();
    await bob.call("POST", `/api/channels/${inB.id}/messages`, { text: "", clientMsgId: crypto.randomUUID(), fileIds: [file.id] });
    expect((await fetch(`${base()}${file.url}`, { headers: { cookie: alice.cookie } })).status).toBe(404);

    const people = (await alice.call<Member[]>("GET", ws(a.id, "/members"))).body.map((m) => m.id);
    expect(people.sort()).toEqual([alice.id, carol.id].sort());
    expect((await alice.call("GET", ws(b.id, "/members"))).status).toBe(404);

    const bobOnline = connect(base(), bob.cookie);
    await bobOnline.ready();
    expect((await alice.call<PresenceMap>("GET", ws(a.id, "/presence"))).body[bob.id]).toBeUndefined();
    expect((await carol.call<PresenceMap>("GET", ws(b.id, "/presence"))).body[bob.id]).toBe("active");
    bobOnline.ws.close();

    expect((await alice.call("POST", ws(a.id, "/dms"), { userIds: [bob.id] })).status).toBe(400);
    const inA = (await channel(alice, a.id)).body;
    expect((await alice.call("POST", `/api/channels/${inA.id}/members`, { userIds: [bob.id] })).status).toBe(400);
    // The same name can exist in each workspace.
    expect((await alice.call("POST", ws(a.id, "/channels"), { name: inB.name })).status).toBe(201);
  });

  it("sends workspace events only to that workspace's people", async () => {
    const { alice, bob, carol, a, b } = await twoTeams();
    const aliceSocket = connect(base(), alice.cookie);
    await aliceSocket.ready();
    const inB = (await channel(bob, b.id)).body;
    const dana = await signIn(base(), "dana");
    await join(dana, b.id, bob);
    const bobSocket = connect(base(), bob.cookie);
    await bobSocket.ready();

    await aliceSocket.none("channel.added", (e) => e.channel.id === inB.id);
    await aliceSocket.none("member.joined", (e) => e.workspaceId === b.id);
    await aliceSocket.none("presence.changed", (e) => e.userId === bob.id);
    // Carol shares workspace A, so Alice sees her come online.
    const carolSocket = connect(base(), carol.cookie);
    await carolSocket.ready();
    await aliceSocket.next("presence.changed", (e) => e.userId === carol.id);
    for (const s of [aliceSocket, bobSocket, carolSocket]) s.ws.close();
  });
});

describe("roles", () => {
  it("lets guests use only the conversations they are added to", async () => {
    const [owner, guest] = [await signIn(base(), "owner"), await signIn(base(), "guest")];
    const w = await createWorkspace(owner);
    await join(guest, w.id, owner, "guest");
    const lobby = (await channel(owner, w.id)).body;
    const project = (await channel(owner, w.id)).body;
    await owner.call("POST", `/api/channels/${project.id}/members`, { userIds: [guest.id] });

    expect((await guest.call<Channel[]>("GET", ws(w.id, "/channels"))).body.map((c) => c.id)).toEqual([project.id]);
    expect((await guest.call("GET", `/api/channels/${lobby.id}/messages`)).status).toBe(404);
    expect((await guest.call("POST", `/api/channels/${lobby.id}/join`)).status).toBe(404);
    expect((await channel(guest, w.id)).status).toBe(403);
    expect((await guest.call("POST", ws(w.id, "/dms"), { userIds: [owner.id] })).status).toBe(403);
    expect((await guest.call("POST", `/api/channels/${project.id}/members`, { userIds: [owner.id] })).status).toBe(403);
    expect((await guest.call("POST", `/api/channels/${project.id}/messages`, { text: "hi", clientMsgId: "g1" })).status).toBe(201);
    expect((await guest.call("GET", `/api/search?workspaceId=${w.id}&q=x`)).status).toBe(200);
  });

  it("limits invites, role changes and removals by role", async () => {
    const owner = await signIn(base(), "owner");
    const admin = await signIn(base(), "admin");
    const member = await signIn(base(), "member");
    const other = await signIn(base(), "other");
    const w = await createWorkspace(owner);
    await join(admin, w.id, owner, "admin");
    await join(member, w.id, owner);
    await join(other, w.id, owner);

    expect((await invite(member, w.id)).status).toBe(403);
    expect((await invite(admin, w.id, { role: "guest" })).status).toBe(201);
    expect((await invite(admin, w.id, { role: "admin" })).status).toBe(403);
    expect((await invite(owner, w.id, { role: "admin" })).status).toBe(201);

    const setRole = (by: Client, who: Client, role: string) => by.call("PUT", ws(w.id, `/members/${who.id}/role`), { role });
    expect((await setRole(member, other, "guest")).status).toBe(403);
    expect((await setRole(admin, owner, "member")).status).toBe(403);
    expect((await setRole(admin, other, "admin")).status).toBe(403);
    expect((await setRole(admin, other, "guest")).status).toBe(204);
    expect((await owner.call("PUT", ws(w.id, `/members/${owner.id}/role`), { role: "owner" })).status).toBe(400); // not grantable

    const remove = (by: Client, who: Client) => by.call("DELETE", ws(w.id, `/members/${who.id}`));
    expect((await remove(admin, owner)).status).toBe(403);
    expect((await remove(member, other)).status).toBe(403);
    expect((await remove(owner, owner)).status).toBe(403); // the owner cannot leave
    expect((await remove(member, member)).status).toBe(204); // anyone else can leave
    expect((await owner.call<Workspace[]>("GET", "/api/workspaces")).body[0]).toMatchObject({ id: w.id, role: "owner" });
  });

  it("cuts a removed person off, and drops public channels when someone becomes a guest", async () => {
    const [owner, alice, bob] = [await signIn(base(), "owner"), await signIn(base(), "alice"), await signIn(base(), "bob")];
    const w = await createWorkspace(owner);
    await join(alice, w.id, owner);
    await join(bob, w.id, owner);
    const open = (await channel(owner, w.id)).body;
    const closed = (await channel(owner, w.id, { isPrivate: true })).body;
    for (const who of [alice, bob]) await who.call("POST", `/api/channels/${open.id}/join`);
    await owner.call("POST", `/api/channels/${closed.id}/members`, { userIds: [alice.id, bob.id] });

    const aliceSocket = connect(base(), alice.cookie);
    await aliceSocket.ready();
    expect((await owner.call("DELETE", ws(w.id, `/members/${alice.id}`))).status).toBe(204);
    await aliceSocket.next("member.removed", (e) => e.workspaceId === w.id && e.userId === alice.id);
    expect((await alice.call("GET", `/api/channels/${closed.id}/messages`)).status).toBe(404);
    expect((await alice.call<Workspace[]>("GET", "/api/workspaces")).body).toEqual([]);
    const msg = await post(owner, closed.id, "after alice left");
    await aliceSocket.none("message.created", (e) => e.message.id === msg.id);
    aliceSocket.ws.close();

    await owner.call("PUT", ws(w.id, `/members/${bob.id}/role`), { role: "guest" });
    const bobs = (await bob.call<Channel[]>("GET", ws(w.id, "/channels"))).body.map((c) => c.id);
    expect(bobs).toEqual([closed.id]);
  });
});

describe("invites", () => {
  it("previews and accepts a reusable link, refusing it once revoked or expired", async () => {
    const [owner, kim, lee] = [await signIn(base(), "owner"), await signIn(base(), "kim"), await signIn(base(), "lee")];
    const w = await createWorkspace(owner, "Acme");
    const link = (await invite(owner, w.id, { role: "guest" })).body;
    const preview = (await kim.call<InvitePreview>("GET", `/api/invites/${tokenOf(link)}`)).body;
    expect(preview).toMatchObject({ workspace: { id: w.id, name: "Acme" }, inviter: "owner", role: "guest", alreadyMember: false });
    expect((await kim.call("POST", `/api/invites/${tokenOf(link)}/accept`)).body).toEqual({ workspaceId: w.id, channelId: null });
    expect((await kim.call<Workspace[]>("GET", "/api/workspaces")).body[0]).toMatchObject({ id: w.id, role: "guest" });
    expect((await kim.call<InvitePreview>("GET", `/api/invites/${tokenOf(link)}`)).body.alreadyMember).toBe(true);

    await db.update(invites).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invites.id, link.id));
    expect((await lee.call("POST", `/api/invites/${tokenOf(link)}/accept`)).status).toBe(404);
    const second = (await invite(owner, w.id)).body;
    await owner.call("DELETE", ws(w.id, `/invites/${second.id}`));
    expect((await lee.call("GET", `/api/invites/${tokenOf(second)}`)).status).toBe(404);
    expect((await lee.call("GET", "/api/invites/not-a-real-token-123456")).status).toBe(404);
    const listed = (await owner.call<Invite[]>("GET", ws(w.id, "/invites"))).body;
    expect(listed.find((i) => i.id === second.id)?.revokedAt).not.toBeNull();
    expect(listed.every((i) => i.url === undefined)).toBe(true);
  });

  it("binds an email invite to that address, once", async () => {
    const owner = await signIn(base(), "owner");
    const w = await createWorkspace(owner);
    const kim = await signIn(base(), "kim", `kim-${crypto.randomUUID()}@example.test`);
    const eve = await signIn(base(), "eve");
    const inv = (await invite(owner, w.id, { email: kim.email.toUpperCase() })).body;
    expect(inv.email).toBe(kim.email);
    expect((await eve.call("POST", `/api/invites/${tokenOf(inv)}/accept`)).body).toEqual({ error: "invite_for_other_email" });
    expect((await kim.call("POST", `/api/invites/${tokenOf(inv)}/accept`)).status).toBe(200);
    expect((await kim.call("POST", `/api/invites/${tokenOf(inv)}/accept`)).status).toBe(404);
  });

  it("lets people with the workspace's email domain join without an invite", async () => {
    const owner = await signIn(base(), "owner");
    const w = await createWorkspace(owner, "Example", "example.test");
    const colleague = await signIn(base(), "colleague");
    const outsider = await signIn(base(), "outsider", `outsider-${crypto.randomUUID()}@elsewhere.test`);

    expect((await colleague.call<JoinableWorkspace[]>("GET", "/api/workspaces/joinable")).body.map((j) => j.id)).toContain(w.id);
    expect((await outsider.call<JoinableWorkspace[]>("GET", "/api/workspaces/joinable")).body.map((j) => j.id)).not.toContain(w.id);
    expect((await outsider.call("POST", ws(w.id, "/join"))).status).toBe(404);
    expect((await colleague.call("POST", ws(w.id, "/join"))).status).toBe(204);
    expect((await colleague.call<Workspace[]>("GET", "/api/workspaces")).body.map((x) => x.id)).toContain(w.id);
    expect((await owner.call("PUT", ws(w.id), { name: "Example", joinDomain: "not a domain" })).status).toBe(400);
  });
});

describe("incoming webhooks", () => {
  it("posts into its channel as its own bot until revoked", async () => {
    const [owner, member] = [await signIn(base(), "owner"), await signIn(base(), "member")];
    const w = await createWorkspace(owner);
    const other = await createWorkspace(member);
    await join(member, w.id, owner);
    const alerts = (await channel(owner, w.id)).body;
    await member.call("POST", `/api/channels/${alerts.id}/join`);

    expect((await member.call("POST", ws(w.id, "/webhooks"), { channelId: alerts.id, name: "Deploy bot" })).status).toBe(403);
    const otherChannel = (await channel(member, other.id)).body;
    expect((await owner.call("POST", ws(w.id, "/webhooks"), { channelId: otherChannel.id, name: "x" })).status).toBe(400);
    const hook = (await owner.call<Webhook>("POST", ws(w.id, "/webhooks"), { channelId: alerts.id, name: "Deploy bot" })).body;
    expect(hook.url).toMatch(/\/api\/hooks\//);

    const listener = connect(base(), member.cookie);
    await listener.ready();
    const send = (text: string) => fetch(`${base()}${new URL(hook.url!).pathname}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    expect((await send("배포 완료 :rocket:")).status).toBe(201);
    const event = await listener.next("message.created", (e) => e.message.channelId === alerts.id);
    expect(event.message).toMatchObject({ text: "배포 완료 :rocket:", author: { displayName: "Deploy bot" } });
    expect((await send("")).status).toBe(400);
    // Bots are not people in the directory.
    expect((await owner.call<Member[]>("GET", ws(w.id, "/members"))).body.map((m) => m.displayName)).not.toContain("Deploy bot");

    expect((await owner.call<Webhook[]>("GET", ws(w.id, "/webhooks"))).body.map((h) => h.id)).toEqual([hook.id]);
    await owner.call("DELETE", ws(w.id, `/webhooks/${hook.id}`));
    expect((await send("still there?")).status).toBe(404);
    // Its past messages keep their author.
    const history = (await owner.call<MessagePage>("GET", `/api/channels/${alerts.id}/messages`)).body;
    expect(history.messages.map((m) => m.author.displayName)).toEqual(["Deploy bot"]);
    listener.ws.close();
  });
});

describe("channel invites for outside guests", () => {
  it("brings a guest straight into one channel and nowhere else", async () => {
    const [owner, guest] = [await signIn(base(), "owner"), await signIn(base(), "partner")];
    const w = await createWorkspace(owner, "Acme");
    const lobby = (await channel(owner, w.id)).body;
    const project = (await channel(owner, w.id, { isPrivate: true })).body;
    await post(owner, lobby.id, "internal only");

    const inv = (await invite(owner, w.id, { role: "guest", channelId: project.id, guestDays: 30 })).body;
    expect(inv).toMatchObject({ channelId: project.id, guestDays: 30, role: "guest" });
    const preview = (await guest.call<InvitePreview>("GET", `/api/invites/${tokenOf(inv)}`)).body;
    expect(preview).toMatchObject({ channel: { id: project.id, name: project.name }, guestDays: 30 });

    const guestSocket = connect(base(), guest.cookie);
    await guestSocket.ready();
    expect((await guest.call("POST", `/api/invites/${tokenOf(inv)}/accept`)).body).toEqual({ workspaceId: w.id, channelId: project.id });
    expect((await guestSocket.next("channel.added", (e) => e.channel.id === project.id)).isMember).toBe(true);
    expect((await guest.call<Channel[]>("GET", ws(w.id, "/channels"))).body.map((c) => c.id)).toEqual([project.id]);
    expect((await guest.call("GET", `/api/channels/${lobby.id}/messages`)).status).toBe(404);
    expect((await guest.call<MessagePage>("GET", `/api/search?workspaceId=${w.id}&q=internal`)).body.messages).toEqual([]);

    const me = (await owner.call<Member[]>("GET", ws(w.id, "/members"))).body.find((m) => m.id === guest.id)!;
    expect(me.role).toBe("guest");
    const days = (new Date(me.expiresAt!).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);
    guestSocket.ws.close();
  });

  it("adds an existing member to the channel without changing their role", async () => {
    const [owner, member] = [await signIn(base(), "owner"), await signIn(base(), "member")];
    const w = await createWorkspace(owner);
    await join(member, w.id, owner);
    const project = (await channel(owner, w.id, { isPrivate: true })).body;
    const inv = (await invite(owner, w.id, { role: "guest", channelId: project.id })).body;
    await member.call("POST", `/api/invites/${tokenOf(inv)}/accept`);
    expect((await member.call<Channel[]>("GET", ws(w.id, "/channels"))).body.find((c) => c.id === project.id)?.isMember).toBe(true);
    expect((await member.call<Workspace[]>("GET", "/api/workspaces")).body.find((x) => x.id === w.id)?.role).toBe("member");
  });

  it("only lets admins in the channel create one, for channels not DMs, with durations for guests only", async () => {
    const [owner, admin, member] = [await signIn(base(), "owner"), await signIn(base(), "admin"), await signIn(base(), "member")];
    const w = await createWorkspace(owner);
    await join(admin, w.id, owner, "admin");
    await join(member, w.id, owner);
    const secret = (await channel(owner, w.id, { isPrivate: true })).body;
    const open = (await channel(member, w.id)).body;
    const dm = (await owner.call<Channel>("POST", ws(w.id, "/dms"), { userIds: [admin.id] })).body;

    expect((await invite(member, w.id, { role: "guest", channelId: open.id })).status).toBe(403);
    expect((await invite(admin, w.id, { role: "guest", channelId: secret.id })).status).toBe(400); // not in it
    expect((await invite(owner, w.id, { role: "guest", channelId: dm.id })).status).toBe(400);
    expect((await invite(owner, w.id, { role: "member", guestDays: 7 })).status).toBe(400);
  });

  it("removes guests whose time is up, with everything they could see", async () => {
    const [owner, guest] = [await signIn(base(), "owner"), await signIn(base(), "guest")];
    const w = await createWorkspace(owner);
    const project = (await channel(owner, w.id)).body;
    const inv = (await invite(owner, w.id, { role: "guest", channelId: project.id, guestDays: 7 })).body;
    await guest.call("POST", `/api/invites/${tokenOf(inv)}/accept`);

    const ownerSocket = connect(base(), owner.cookie);
    await ownerSocket.ready();
    expect(await expireMemberships(db, cluster.hub)).toBe(0);
    await db.update(workspaceMembers).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(workspaceMembers.userId, guest.id));
    expect(await expireMemberships(db, cluster.hub)).toBe(1);
    expect(await expireMemberships(db, cluster.hub)).toBe(0); // idempotent across nodes

    await ownerSocket.next("member.removed", (e) => e.userId === guest.id);
    expect((await guest.call("GET", `/api/channels/${project.id}/messages`)).status).toBe(404);
    expect((await guest.call<Workspace[]>("GET", "/api/workspaces")).body).toEqual([]);
    ownerSocket.ws.close();
  });
});
