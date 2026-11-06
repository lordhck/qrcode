// HTTP plumbing: security headers, HTTPS enforcement, proxy trust,
// JSON/file responses, body reading and rate limiting.

import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";

import { MAX_JSON_BODY_BYTES } from "./config.js";
import { HttpError } from "./transfers.js";

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const SECURITY_HEADERS = {
  "Content-Security-Policy": CSP,
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};
const HSTS = "max-age=63072000; includeSubDomains";
const HOST_RE = /^([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(:\d{1,5})?$/;

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// -- Client identity behind a reverse proxy -------------------------------------

const normaliseIp = (ip) => (ip || "").replace(/^::ffff:/, "");

export function makeProxyTrust(trustedProxies) {
  const list = trustedProxies.split(",").map((s) => normaliseIp(s.trim())).filter(Boolean);
  const trustsAll = list.includes("*");
  const trusted = (ip) => trustsAll || list.includes(normaliseIp(ip));

  /** Effective {ip, https} for a request, honouring X-Forwarded-* only from trusted proxies. */
  return (req) => {
    const peer = normaliseIp(req.socket.remoteAddress);
    const direct = { ip: peer, https: Boolean(req.socket.encrypted) };
    if (!trusted(peer)) return direct;
    const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
    // Walk X-Forwarded-For from the right, skipping our own proxies.
    const chain = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => normaliseIp(s.trim())).filter(Boolean);
    let ip = peer;
    while (chain.length) {
      ip = chain.pop();
      if (!trusted(ip)) break;
    }
    return { ip, https: proto ? proto === "https" : direct.https };
  };
}

// -- Responses -----------------------------------------------------------------

export function applySecurityHeaders(res, { https, isApi }) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  if (https) res.setHeader("Strict-Transport-Security", HSTS);
  if (isApi) res.setHeader("Cache-Control", "no-store");
}

export function sendJson(res, status, body, headers = {}) {
  const data = body === null ? "" : JSON.stringify(body);
  res.writeHead(status, {
    ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}),
    ...headers,
  });
  res.end(res.req.method === "HEAD" ? undefined : data);
}

export function sendError(res, err) {
  // Client went away (e.g. aborted upload): nobody is left to answer.
  if (res.req.destroyed && !(err instanceof HttpError)) {
    res.destroy();
    return;
  }
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (err instanceof HttpError) {
    sendJson(res, err.status, { detail: err.detail }, err.headers);
  } else {
    console.error("Unhandled error:", err);
    sendJson(res, 500, { detail: "Internal server error" });
  }
}

/** Stream a file. Returns false if it does not exist. */
export async function sendFile(res, file, { contentType, cacheControl = "no-cache" } = {}) {
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  res.writeHead(200, {
    "Content-Type": contentType || CONTENT_TYPES[path.extname(file)] || "application/octet-stream",
    "Content-Length": stat.size,
    "Cache-Control": cacheControl,
  });
  if (res.req.method === "HEAD") {
    res.end();
    return true;
  }
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on("error", reject);
    res.on("close", resolve);
    stream.pipe(res);
  });
  return true;
}

/** Resolve a request path under `root`, refusing anything that escapes it. */
export function safeJoin(root, requestPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const full = path.resolve(root, "." + path.posix.normalize("/" + decoded));
  return full.startsWith(root + path.sep) ? full : null;
}

// -- HTTPS enforcement ------------------------------------------------------------

/** Returns true if the request was answered (redirected or rejected). */
export function enforceHttps(req, res, https) {
  if (https) return false;
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, 403, { detail: "HTTPS required" }, { Connection: "close" });
    return true;
  }
  const host = req.headers.host || "";
  if (!HOST_RE.test(host)) {
    sendJson(res, 400, { detail: "Invalid Host header" });
    return true;
  }
  sendJson(res, 308, { detail: "HTTPS required" }, { Location: `https://${host}${req.url}` });
  return true;
}

// -- Request bodies -----------------------------------------------------------------

export function contentLength(req) {
  const raw = req.headers["content-length"];
  if (raw === undefined) return null;
  if (!/^\d+$/.test(raw)) throw new HttpError(400, "Invalid Content-Length");
  return Number(raw);
}

export async function readJson(req) {
  const mediaType = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (mediaType !== "application/json") throw new HttpError(415, "Content-Type must be application/json");
  const length = contentLength(req);
  if (length === null) throw new HttpError(411, "Content-Length is required");
  if (length > MAX_JSON_BODY_BYTES) throw new HttpError(413, "Request body too large");
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_JSON_BODY_BYTES) throw new HttpError(413, "Request body too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Malformed JSON body");
  }
}

export function bearerToken(req) {
  const header = String(req.headers.authorization || "");
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match ? match[1] : null;
}

// -- Rate limiting --------------------------------------------------------------------

/** Per-key sliding window over one minute. Per process; strict limits belong in the proxy. */
export class RateLimiter {
  constructor(limitPerMinute) {
    this.limit = limitPerMinute;
    this.hits = new Map();
  }

  allow(key) {
    if (this.limit <= 0) return true;
    const now = Date.now();
    const hits = (this.hits.get(key) || []).filter((t) => now - t < 60_000);
    if (hits.length >= this.limit) {
      this.hits.set(key, hits);
      return false;
    }
    hits.push(now);
    this.hits.set(key, hits);
    return true;
  }

  prune() {
    const now = Date.now();
    for (const [key, hits] of this.hits) {
      if (!hits.length || now - hits[hits.length - 1] >= 60_000) this.hits.delete(key);
    }
  }
}
