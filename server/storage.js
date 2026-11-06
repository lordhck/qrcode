// Temporary file-based storage for encrypted transfer blobs.
//
//   <root>/<id>/meta.json   transfer record (no secrets; upload token as SHA-256)
//   <root>/<id>/blob.part   upload in progress (exclusive-create lock)
//   <root>/<id>/blob.bin    completed ciphertext
//
// Records are written atomically (temp file + rename). Uploads are renamed
// from blob.part to blob.bin only after the full body has arrived.

import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const META_FILE = "meta.json";
const BLOB_FILE = "blob.bin";
const PART_FILE = "blob.part";
const ID_RE = /^[A-Za-z0-9_-]{22}$/; // 128-bit base64url
const STALE_PART_MS = 10 * 60 * 1000; // abandoned upload
const ORPHAN_DIR_MS = 60 * 1000; // directory without a readable record

export class StorageFullError extends Error {}
export class GoneError extends Error {}

export const newTransferId = () => randomBytes(16).toString("base64url");
export const newUploadToken = () => randomBytes(32).toString("base64url");
export const hashToken = (token) => createHash("sha256").update(token, "utf8").digest("hex");
export const isValidTransferId = (value) => typeof value === "string" && ID_RE.test(value);

const isExpired = (record, nowMs) => nowMs / 1000 >= record.expires_at;

function isValidRecord(r) {
  return (
    r && typeof r === "object" &&
    typeof r.id === "string" && typeof r.token_hash === "string" && typeof r.meta === "string" &&
    Number.isInteger(r.size) && Number.isInteger(r.fps) &&
    Number.isInteger(r.created_at) && Number.isInteger(r.expires_at) && typeof r.uploaded === "boolean"
  );
}

export class Storage {
  constructor(root, clock = Date.now) {
    this.root = path.resolve(root);
    this.clock = clock;
    this.queue = Promise.resolve(); // serialises quota check + create
  }

  async init() {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    await fs.chmod(this.root, 0o700).catch(() => {});
  }

  dir(id) {
    if (!isValidTransferId(id)) throw new Error("invalid transfer id");
    return path.join(this.root, id);
  }

  blobPath(id) {
    return path.join(this.dir(id), BLOB_FILE);
  }

  partPath(id) {
    return path.join(this.dir(id), PART_FILE);
  }

  exclusive(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  async writeRecord(record) {
    const dir = this.dir(record.id);
    const tmp = path.join(dir, `.${META_FILE}.${randomBytes(4).toString("hex")}.tmp`);
    const handle = await fs.open(tmp, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(record));
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.rename(tmp, path.join(dir, META_FILE));
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
  }

  async readRecord(dir) {
    let raw;
    try {
      raw = await fs.readFile(path.join(dir, META_FILE), "utf8");
    } catch (err) {
      if (err.code === "ENOENT" || err.code === "ENOTDIR") return null;
      throw err;
    }
    try {
      const record = JSON.parse(raw);
      // A record must describe the directory it lives in.
      return isValidRecord(record) && record.id === path.basename(dir) ? record : null;
    } catch {
      return null;
    }
  }

  async *dirs() {
    let entries;
    try {
      entries = await fs.readdir(this.root, { withFileTypes: true });
    } catch (err) {
      if (err.code === "ENOENT") return;
      throw err;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && isValidTransferId(entry.name)) yield path.join(this.root, entry.name);
    }
  }

  async reservedBytes() {
    const now = this.clock();
    let total = 0;
    for await (const dir of this.dirs()) {
      const record = await this.readRecord(dir);
      if (record && !isExpired(record, now)) total += record.size;
    }
    return total;
  }

  /** Create a transfer; returns {record, token}. The token is never stored. */
  create({ size, meta, fps, ttl, maxStorage }) {
    return this.exclusive(async () => {
      if ((await this.reservedBytes()) + size > maxStorage) throw new StorageFullError();
      let id = null;
      for (let i = 0; i < 5 && !id; i++) {
        const candidate = newTransferId();
        try {
          await fs.mkdir(this.dir(candidate), { mode: 0o700 });
          id = candidate;
        } catch (err) {
          if (err.code !== "EEXIST") throw err;
        }
      }
      if (!id) throw new Error("could not allocate a transfer id");

      const token = newUploadToken();
      const now = Math.floor(this.clock() / 1000);
      const record = {
        id,
        token_hash: hashToken(token),
        size,
        meta,
        fps,
        created_at: now,
        expires_at: now + ttl,
        uploaded: false,
      };
      try {
        await this.writeRecord(record);
      } catch (err) {
        await fs.rm(this.dir(id), { recursive: true, force: true });
        throw err;
      }
      return { record, token };
    });
  }

  /** A live record, or null if unknown, invalid or expired (expired ones are deleted). */
  async get(id) {
    if (!isValidTransferId(id)) return null;
    const record = await this.readRecord(this.dir(id));
    if (!record) return null;
    if (isExpired(record, this.clock())) {
      await this.delete(id);
      return null;
    }
    return record;
  }

  async delete(id) {
    if (!isValidTransferId(id)) return;
    await fs.rm(this.dir(id), { recursive: true, force: true });
  }

  /** Exclusively create blob.part. EEXIST means another upload is running. */
  async openPart(id) {
    try {
      return await fs.open(this.partPath(id), "wx", 0o600);
    } catch (err) {
      if (err.code === "ENOENT") throw new GoneError();
      throw err;
    }
  }

  async commitUpload(id) {
    const record = await this.get(id);
    if (!record) {
      await this.discardPart(id);
      throw new GoneError();
    }
    try {
      await fs.rename(this.partPath(id), this.blobPath(id));
    } catch (err) {
      if (err.code === "ENOENT") throw new GoneError();
      throw err;
    }
    const updated = { ...record, uploaded: true };
    await this.writeRecord(updated);
    return updated;
  }

  async discardPart(id) {
    if (isValidTransferId(id)) await fs.rm(this.partPath(id), { force: true });
  }

  /** Delete expired transfers, orphaned directories and abandoned uploads. */
  async sweep() {
    const now = this.clock();
    let removed = 0;
    for await (const dir of this.dirs()) {
      const record = await this.readRecord(dir);
      if (!record) {
        if (now - (await mtime(dir, now)) > ORPHAN_DIR_MS) {
          await fs.rm(dir, { recursive: true, force: true });
          removed++;
        }
        continue;
      }
      if (isExpired(record, now)) {
        await fs.rm(dir, { recursive: true, force: true });
        removed++;
        continue;
      }
      const part = path.join(dir, PART_FILE);
      if (now - (await mtime(part, now)) > STALE_PART_MS) await fs.rm(part, { force: true });
    }
    return removed;
  }
}

async function mtime(file, fallback) {
  try {
    return (await fs.stat(file)).mtimeMs;
  } catch {
    return fallback;
  }
}
