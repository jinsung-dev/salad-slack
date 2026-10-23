import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import type { FileRef } from "@chatter/shared";

// Single owner of attachment bytes and of how they may be served. Bytes sit
// on local disk, which suits one server; several servers need shared object
// storage (S3) behind these same three operations.

export class FileStore {
  constructor(private readonly dir: string) {}

  /** Streams to a temp file first, so a failed or oversized upload never leaves a partial file under its key. */
  async save(stream: Readable): Promise<{ key: string; size: number }> {
    await mkdir(this.dir, { recursive: true });
    const key = randomUUID();
    const tmp = join(this.dir, `${key}.part`);
    try {
      await pipeline(stream, createWriteStream(tmp, { flags: "wx" }));
      await rename(tmp, join(this.dir, key));
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    return { key, size: (await stat(join(this.dir, key))).size };
  }

  open(key: string): Readable {
    return createReadStream(join(this.dir, key));
  }

  async remove(keys: string[]): Promise<void> {
    await Promise.all(keys.map((key) => rm(join(this.dir, key), { force: true })));
  }
}

/** Raster formats browsers render without running code; everything else downloads. */
const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export const isInline = (mimeType: string) => INLINE_TYPES.has(mimeType);

export function fileRef(row: { id: string; name: string; mimeType: string; size: number }): FileRef {
  return { id: row.id, name: row.name, mimeType: row.mimeType, size: row.size, url: `/api/files/${row.id}`, inline: isInline(row.mimeType) };
}

/** A display name safe to store and echo: no path, no control characters, bounded length. */
export function cleanFileName(name: string): string {
  const base = name.split(/[\\/]/).at(-1) ?? "";
  const cleaned = base.normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200);
  return cleaned || "file";
}

/** A MIME type as sent by the browser, or a generic one when it is missing or malformed. */
export function cleanMimeType(mimeType: string | undefined): string {
  const value = (mimeType ?? "").toLowerCase().split(";")[0]!.trim();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(value) ? value : "application/octet-stream";
}

/** RFC 6266 header carrying non-ASCII (e.g. Korean) names. */
export function contentDisposition(kind: "inline" | "attachment", name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
