#!/usr/bin/env node
// QR Transfer server. Plain Node.js, no npm dependencies.

import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";

import { ConfigError, loadConfig } from "./config.js";
import { makeProxyTrust, RateLimiter } from "./http.js";
import { createHandler } from "./routes.js";
import { Storage } from "./storage.js";
import { TransferService } from "./transfers.js";

let config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`configuration error: ${err.message}`);
    process.exit(2);
  }
  throw err;
}

const storage = new Storage(config.storageDir);
await storage.init();
const service = new TransferService(config, storage);
const limiter = new RateLimiter(config.createRateLimit);
// Access logging is intentionally absent: transfer IDs in paths are capabilities.
const handler = createHandler({ config, service, limiter, proxyTrust: makeProxyTrust(config.trustedProxies) });

let server;
if (config.sslCertfile) {
  let cert, key;
  try {
    cert = readFileSync(config.sslCertfile);
    key = readFileSync(config.sslKeyfile);
  } catch (err) {
    console.error(`configuration error: cannot read TLS files (${err.message})`);
    process.exit(2);
  }
  server = https.createServer({ cert, key }, handler);
} else {
  server = http.createServer(handler);
}
server.requestTimeout = 0; // uploads over slow links may take a while
server.headersTimeout = 30_000;

async function sweep() {
  try {
    const removed = await storage.sweep();
    if (removed) console.log(`Removed ${removed} expired transfer(s)`);
  } catch (err) {
    console.error("Storage sweep failed:", err);
  }
  limiter.prune();
}
await sweep(); // startup cleanup
const timer = setInterval(sweep, config.cleanupInterval * 1000);

server.listen(config.port, config.host, () => {
  const scheme = config.sslCertfile ? "https" : "http";
  console.log(`QR Transfer listening on ${scheme}://${config.host}:${config.port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    clearInterval(timer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
