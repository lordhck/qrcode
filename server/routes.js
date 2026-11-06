// Request routing.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { MIN_CIPHERTEXT_BYTES, MIN_FPS } from "./config.js";
import {
  applySecurityHeaders, bearerToken, contentLength, enforceHttps, readJson,
  safeJoin, sendError, sendFile, sendJson,
} from "./http.js";
import { HttpError, transferInfo } from "./transfers.js";

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

const TRANSFER_RE = /^\/api\/transfers\/([^/]+)$/;
const BLOB_RE = /^\/api\/transfers\/([^/]+)\/blob$/;
const UPLOAD_RE = /^\/api\/transfers\/([^/]+)\/upload$/;
const PAGE_RE = /^\/t\/[^/]+$/;

const methodNotAllowed = () => new HttpError(405, "Method Not Allowed");
const isRead = (method) => method === "GET" || method === "HEAD";

export function createHandler({ config, service, limiter, proxyTrust }) {
  const handlers = {
    async config(req, res) {
      sendJson(res, 200, {
        max_size: config.maxSize,
        min_size: MIN_CIPHERTEXT_BYTES,
        default_ttl: config.defaultTtl,
        min_ttl: config.minTtl,
        max_ttl: config.maxTtl,
        default_fps: config.defaultFps,
        min_fps: MIN_FPS,
        max_fps: config.maxFps,
      });
    },

    async create(req, res, client) {
      if (!limiter.allow(client.ip)) {
        throw new HttpError(429, "Too many transfers created, slow down", { "Retry-After": "60" });
      }
      const { record, token } = await service.create(await readJson(req));
      sendJson(res, 201, {
        id: record.id,
        upload_token: token,
        expires_at: record.expires_at,
        max_size: config.maxSize,
      });
    },

    async info(req, res, id) {
      sendJson(res, 200, transferInfo(await service.get(id)));
    },

    async remove(req, res, id) {
      await service.delete(id, bearerToken(req));
      sendJson(res, 204, null);
    },

    async blob(req, res, id) {
      const { path: file } = await service.blob(id);
      if (!(await sendFile(res, file, { contentType: "application/octet-stream", cacheControl: "no-store" }))) {
        throw new HttpError(404, "Transfer not found or expired");
      }
    },

    async upload(req, res, id) {
      const record = await service.checkUpload(id, bearerToken(req), {
        contentLength: contentLength(req),
        contentType: req.headers["content-type"],
      });
      sendJson(res, 200, transferInfo(await service.upload(record, req)));
    },
  };

  async function route(req, res, client) {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;
    const m = req.method;
    let match;

    if (p === "/healthz") {
      if (!isRead(m)) throw methodNotAllowed();
      return sendJson(res, 200, { status: "ok" });
    }
    if (p === "/api/config") {
      if (!isRead(m)) throw methodNotAllowed();
      return handlers.config(req, res);
    }
    if (p === "/api/transfers") {
      if (m !== "POST") throw methodNotAllowed();
      return handlers.create(req, res, client);
    }
    if ((match = UPLOAD_RE.exec(p))) {
      if (m !== "POST") throw methodNotAllowed();
      return handlers.upload(req, res, match[1]);
    }
    if ((match = BLOB_RE.exec(p))) {
      if (!isRead(m)) throw methodNotAllowed();
      return handlers.blob(req, res, match[1]);
    }
    if ((match = TRANSFER_RE.exec(p))) {
      if (isRead(m)) return handlers.info(req, res, match[1]);
      if (m === "DELETE") return handlers.remove(req, res, match[1]);
      throw methodNotAllowed();
    }
    if (p.startsWith("/api/")) throw new HttpError(404, "Not Found");

    // Pages and static assets.
    if (!isRead(m)) throw methodNotAllowed();
    let file = null;
    if (p === "/") file = path.join(PUBLIC_DIR, "index.html");
    else if (PAGE_RE.test(p)) file = path.join(PUBLIC_DIR, "transfer.html"); // the page checks the transfer itself
    else if (p.startsWith("/static/")) file = safeJoin(PUBLIC_DIR, p.slice("/static".length));
    if (!file || !(await sendFile(res, file))) throw new HttpError(404, "Not Found");
  }

  return async (req, res) => {
    const client = proxyTrust(req);
    applySecurityHeaders(res, { https: client.https, isApi: req.url.startsWith("/api/") });
    try {
      if (config.enforceHttps && req.url !== "/healthz" && enforceHttps(req, res, client.https)) return;
      await route(req, res, client);
    } catch (err) {
      // Don't keep reading an unwanted request body after an early error.
      if (!req.complete) res.setHeader("Connection", "close");
      sendError(res, err);
    }
  };
}
