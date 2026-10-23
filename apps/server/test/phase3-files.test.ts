import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Channel, FileRef, Message, MessagePage } from "@chatter/shared";
import { signIn, uniqueName, useCluster, type Client } from "./helpers";

// Small limit so the oversize case needs no large payload.
const MAX = 64 * 1024;
const { urls, fileStorageDir } = useCluster(1, { maxFileBytes: MAX });
const base = () => urls[0]!;

// A 1×1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function upload(who: Client, channelId: string, name: string, type: string, body: Buffer | string) {
  const form = new FormData();
  form.append("file", new Blob([typeof body === "string" ? body : new Uint8Array(body)], { type }), name);
  const res = await fetch(`${base()}/api/channels/${channelId}/files`, { method: "POST", headers: { cookie: who.cookie }, body: form });
  return { status: res.status, body: (await res.json()) as FileRef & { error?: string } };
}
const download = (who: Client, url: string) => fetch(`${base()}${url}`, { headers: { cookie: who.cookie } });
const send = (who: Client, channelId: string, body: Record<string, unknown>) =>
  who.call<Message>("POST", `/api/channels/${channelId}/messages`, { clientMsgId: crypto.randomUUID(), ...body });

describe("file attachments", () => {
  it("keeps an upload private until attached, then serves it to readers of the conversation only", async () => {
    const [alice, bob, carol] = [await signIn(base(), "alice"), await signIn(base(), "bob"), await signIn(base(), "carol")];
    const room = (await alice.call<Channel>("POST", "/api/channels", { name: uniqueName(), isPrivate: true })).body;
    await alice.call("POST", `/api/channels/${room.id}/members`, { userIds: [bob.id] });

    const up = await upload(alice, room.id, "스크린샷.png", "image/png", PNG);
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ name: "스크린샷.png", mimeType: "image/png", size: PNG.length, inline: true });
    expect((await download(bob, up.body.url)).status).toBe(404);
    expect((await download(alice, up.body.url)).status).toBe(200);

    const sent = await send(alice, room.id, { text: "", fileIds: [up.body.id] });
    expect(sent.status).toBe(201);
    expect(sent.body.files).toEqual([up.body]);

    const res = await download(bob, up.body.url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toContain(`filename*=UTF-8''${encodeURIComponent("스크린샷.png")}`);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG);
    expect((await download(carol, up.body.url)).status).toBe(404);

    const page = (await bob.call<MessagePage>("GET", `/api/channels/${room.id}/messages`)).body;
    expect(page.messages[0]!.files.map((f) => f.id)).toEqual([up.body.id]);
  });

  it("serves anything but raster images as a sandboxed download", async () => {
    const alice = await signIn(base(), "alice");
    const room = (await alice.call<Channel>("POST", "/api/channels", { name: uniqueName() })).body;
    for (const [name, type] of [
      ["evil.html", "text/html"],
      ["logo.svg", "image/svg+xml"],
    ] as const) {
      const up = await upload(alice, room.id, name, type, "<script>alert(1)</script>");
      expect(up.body.inline).toBe(false);
      const res = await download(alice, up.body.url);
      expect(res.headers.get("content-type")).toBe("application/octet-stream");
      expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("content-security-policy")).toContain("sandbox");
    }
  });

  it("attaches only the sender's own unattached uploads to that conversation, all or nothing", async () => {
    const [alice, bob] = [await signIn(base(), "alice"), await signIn(base(), "bob")];
    const room = (await alice.call<Channel>("POST", "/api/channels", { name: uniqueName() })).body;
    const other = (await alice.call<Channel>("POST", "/api/channels", { name: uniqueName() })).body;
    await bob.call("POST", `/api/channels/${room.id}/join`);

    const mine = (await upload(alice, room.id, "a.txt", "text/plain", "a")).body;
    const bobs = (await upload(bob, room.id, "b.txt", "text/plain", "b")).body;
    const elsewhere = (await upload(alice, other.id, "c.txt", "text/plain", "c")).body;

    expect((await send(alice, room.id, { text: "x", fileIds: [mine.id, bobs.id] })).body).toMatchObject({ error: "invalid_files" });
    expect((await send(alice, room.id, { text: "x", fileIds: [elsewhere.id] })).status).toBe(400);
    expect((await alice.call<MessagePage>("GET", `/api/channels/${room.id}/messages`)).body.messages).toEqual([]);

    expect((await send(alice, room.id, { text: "ok", fileIds: [mine.id] })).status).toBe(201);
    expect((await send(alice, room.id, { text: "again", fileIds: [mine.id] })).status).toBe(400);
    expect((await send(alice, room.id, { text: "" })).status).toBe(400);
  });

  it("deletes attachments with their message and refuses oversized uploads without leaving partial files", async () => {
    const alice = await signIn(base(), "alice");
    const room = (await alice.call<Channel>("POST", "/api/channels", { name: uniqueName() })).body;
    const up = (await upload(alice, room.id, "doc.txt", "text/plain", "hello")).body;
    const msg = (await send(alice, room.id, { text: "doc", fileIds: [up.id] })).body;
    const before = readdirSync(fileStorageDir).length;

    await alice.call("DELETE", `/api/messages/${msg.id}`);
    expect((await download(alice, up.url)).status).toBe(404);
    expect(readdirSync(fileStorageDir).length).toBe(before - 1);

    const big = await upload(alice, room.id, "big.bin", "application/octet-stream", Buffer.alloc(MAX + 1));
    expect(big).toMatchObject({ status: 413, body: { error: "file_too_large", maxBytes: MAX } });
    expect(readdirSync(fileStorageDir).filter((f) => f.endsWith(".part"))).toEqual([]);
  });
});
