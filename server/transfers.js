// Transfer rules, independent of HTTP routing.

import { timingSafeEqual } from "node:crypto";

import { MAX_META_BYTES, MIN_CIPHERTEXT_BYTES, MIN_FPS } from "./config.js";
import { GoneError, hashToken, StorageFullError } from "./storage.js";

export class HttpError extends Error {
  constructor(status, detail, headers = {}) {
    super(detail);
    this.status = status;
    this.detail = detail;
    this.headers = headers;
  }
}

const notFound = () => new HttpError(404, "Transfer not found or expired");
const isInt = (v) => Number.isInteger(v);
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function validateMeta(meta) {
  if (typeof meta !== "string" || meta.length > 2048 || meta.length % 4 !== 0 || !BASE64_RE.test(meta)) {
    throw new HttpError(400, "meta must be standard base64");
  }
  const length = Buffer.from(meta, "base64").length;
  if (length < MIN_CIPHERTEXT_BYTES || length > MAX_META_BYTES) {
    throw new HttpError(400, `meta must decode to ${MIN_CIPHERTEXT_BYTES}..${MAX_META_BYTES} bytes`);
  }
}

function tokenMatches(record, token) {
  if (!token) return false;
  const a = Buffer.from(hashToken(token), "hex");
  const b = Buffer.from(record.token_hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export class TransferService {
  constructor(config, storage) {
    this.config = config;
    this.storage = storage;
  }

  /** Parse and validate the JSON body of POST /api/transfers. */
  parseCreate(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new HttpError(422, "Request body must be a JSON object");
    }
    const unknown = Object.keys(body).filter((k) => !["size", "meta", "ttl_seconds", "fps"].includes(k));
    if (unknown.length) throw new HttpError(422, `Unknown field(s): ${unknown.sort().join(", ")}`);
    if (!isInt(body.size)) throw new HttpError(422, "size must be an integer");
    if (typeof body.meta !== "string") throw new HttpError(422, "meta must be a string");
    for (const key of ["ttl_seconds", "fps"]) {
      if (body[key] !== undefined && body[key] !== null && !isInt(body[key])) {
        throw new HttpError(422, `${key} must be an integer or null`);
      }
    }
    return body;
  }

  async create(body) {
    const c = this.config;
    const { size, meta } = this.parseCreate(body);
    if (size > c.maxSize) throw new HttpError(413, `size exceeds the limit of ${c.maxSize} bytes`);
    if (size < MIN_CIPHERTEXT_BYTES) throw new HttpError(400, `size must be at least ${MIN_CIPHERTEXT_BYTES} bytes`);
    validateMeta(meta);
    const ttl = body.ttl_seconds ?? c.defaultTtl;
    if (ttl < c.minTtl || ttl > c.maxTtl) throw new HttpError(400, `ttl_seconds must be between ${c.minTtl} and ${c.maxTtl}`);
    const fps = body.fps ?? c.defaultFps;
    if (fps < MIN_FPS || fps > c.maxFps) throw new HttpError(400, `fps must be between ${MIN_FPS} and ${c.maxFps}`);

    try {
      return await this.storage.create({ size, meta, fps, ttl, maxStorage: c.maxStorage });
    } catch (err) {
      if (err instanceof StorageFullError) throw new HttpError(507, "Server storage is full, try again later");
      throw err;
    }
  }

  async get(id) {
    const record = await this.storage.get(id);
    if (!record) throw notFound();
    return record;
  }

  async blob(id) {
    const record = await this.get(id);
    if (!record.uploaded) throw new HttpError(409, "Upload not complete");
    return { record, path: this.storage.blobPath(id) };
  }

  authorize(record, token) {
    if (!tokenMatches(record, token)) {
      throw new HttpError(401, "Invalid or missing upload token", { "WWW-Authenticate": "Bearer" });
    }
  }

  async delete(id, token) {
    const record = await this.get(id);
    this.authorize(record, token);
    await this.storage.delete(id);
  }

  /** Validate an upload before any body bytes are read. */
  async checkUpload(id, token, { contentLength, contentType }) {
    const record = await this.get(id);
    this.authorize(record, token);
    if (record.uploaded) throw new HttpError(409, "Transfer already uploaded");
    const mediaType = (contentType || "").split(";")[0].trim().toLowerCase();
    if (mediaType !== "application/octet-stream") throw new HttpError(415, "Content-Type must be application/octet-stream");
    if (contentLength === null) throw new HttpError(411, "Content-Length is required");
    if (contentLength !== record.size) throw new HttpError(400, "Content-Length must equal the declared size");
    return record;
  }

  /** Stream `body` (async iterable of Buffers) to disk, enforcing the declared size. */
  async upload(record, body) {
    const { id, size } = record;
    let handle;
    try {
      handle = await this.storage.openPart(id);
    } catch (err) {
      if (err.code === "EEXIST") throw new HttpError(409, "An upload is already in progress");
      if (err instanceof GoneError) throw notFound();
      throw err;
    }

    let committed = false;
    try {
      let received = 0;
      try {
        for await (const chunk of body) {
          received += chunk.length;
          if (received > size) throw new HttpError(413, "Body exceeds the declared size");
          await handle.write(chunk);
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (received !== size) throw new HttpError(400, "Body is shorter than the declared size");
      try {
        const updated = await this.storage.commitUpload(id);
        committed = true;
        return updated;
      } catch (err) {
        if (err instanceof GoneError) throw notFound();
        throw err;
      }
    } finally {
      if (!committed) await this.storage.discardPart(id);
    }
  }
}

/** Public view of a transfer. Never includes the token hash. */
export function transferInfo(record) {
  return {
    id: record.id,
    size: record.size,
    meta: record.meta,
    fps: record.fps,
    created_at: record.created_at,
    expires_at: record.expires_at,
    ready: record.uploaded,
  };
}
