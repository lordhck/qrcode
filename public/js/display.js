// Recipient page: fetch ciphertext, verify it locally, display it as a
// looping sequence of QR frames for the Android receiver.

import * as api from "./api.js";
import * as crypto from "./crypto.js";
import { FrameSource, framesPerLoop } from "./protocol.js";
import { encodeBytes } from "./qr.js";
import {
  chunkSizeFor, DEFAULT_DENSITY, DEFAULT_ECC, DENSITIES, ECC_LEVELS,
} from "./transport.js";
import { $, formatBytes, formatDuration, show } from "./ui.js";

const QUIET_ZONE = 4; // modules, required by the QR standard
const POLL_MS = 30_000;
const STORAGE_PREFIX = "qrt:key:";

const els = {
  name: $("#name"), facts: $("#facts"), expiry: $("#expiry"),
  viewport: $("#viewport"), qrbox: $("#qrbox"), canvas: $("#qr"),
  overlay: $("#overlay"), overlayTitle: $("#overlayTitle"), overlayText: $("#overlayText"), overlayBar: $("#overlayBar"),
  status: $("#status"), frame: $("#frame"), pass: $("#pass"), loop: $("#loop"),
  controls: $("#controls"), fps: $("#fps"), fpsOut: $("#fpsOut"), density: $("#density"), ecc: $("#ecc"),
  pause: $("#pause"), fullscreen: $("#fullscreen"), instructions: $("#instructions"),
};

const transferId = decodeURIComponent(location.pathname.split("/").pop() || "");

// -- Key handling --------------------------------------------------------------------

/**
 * Read the key from the URL fragment, then remove it from the address bar and
 * history. It is kept in sessionStorage (this tab only) so a reload still works.
 */
function takeKey() {
  const match = /(?:^#|&)k=([A-Za-z0-9_-]+)/.exec(location.hash);
  const storageKey = STORAGE_PREFIX + transferId;
  let encoded = match?.[1] ?? null;
  try {
    if (encoded) sessionStorage.setItem(storageKey, encoded);
    else encoded = sessionStorage.getItem(storageKey);
  } catch {
    // Storage may be disabled; the fragment alone still works for this load.
  }
  if (match) history.replaceState(null, "", location.pathname + location.search);
  if (!encoded) return null;
  try {
    const key = crypto.fromBase64Url(encoded);
    return key.length === crypto.KEY_BYTES ? key : null;
  } catch {
    return null;
  }
}

function forgetKey() {
  try {
    sessionStorage.removeItem(STORAGE_PREFIX + transferId);
  } catch {
    // Ignore: nothing to clean up.
  }
}

// -- Overlay states ------------------------------------------------------------------

function overlay(title, text = "", progress = null) {
  els.overlayTitle.textContent = title;
  els.overlayText.textContent = text;
  if (progress === null) {
    show(els.overlayBar, false);
  } else {
    show(els.overlayBar);
    if (progress === undefined) els.overlayBar.removeAttribute("value");
    else els.overlayBar.value = progress;
  }
  show(els.overlay);
}

function terminal(title, text) {
  player?.stop();
  show(els.qrbox, false);
  show(els.status, false);
  show(els.controls, false);
  show(els.instructions, false);
  show(els.expiry, false);
  els.viewport.classList.add("ended");
  overlay(title, text);
}

// -- Rendering -------------------------------------------------------------------------

class Renderer {
  constructor(canvas, container) {
    this.canvas = canvas;
    this.container = container;
    this.ctx = canvas.getContext("2d", { alpha: false });
    this.last = null;
  }

  draw(qr) {
    const dpr = window.devicePixelRatio || 1;
    const modulesWide = qr.size + QUIET_ZONE * 2;
    const box = this.container.getBoundingClientRect();
    const availableCss = Math.max(120, Math.min(box.width, box.height) - 16);
    // Integer device pixels per module: crisp edges, no resampling blur.
    const scale = Math.max(1, Math.floor((availableCss * dpr) / modulesWide));
    const px = scale * modulesWide;
    if (this.canvas.width !== px) {
      this.canvas.width = px;
      this.canvas.height = px;
      this.canvas.style.width = `${px / dpr}px`;
      this.canvas.style.height = `${px / dpr}px`;
    }
    const { ctx } = this;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = "#000";
    const { size, modules } = qr;
    for (let y = 0; y < size; y++) {
      // Merge horizontal runs of dark modules into single rectangles.
      let x = 0;
      while (x < size) {
        if (!modules[y * size + x]) { x++; continue; }
        const start = x;
        while (x < size && modules[y * size + x]) x++;
        ctx.fillRect((start + QUIET_ZONE) * scale, (y + QUIET_ZONE) * scale, (x - start) * scale, scale);
      }
    }
    this.last = qr;
  }

  redraw() {
    if (this.last) this.draw(this.last);
  }
}

// -- Playback --------------------------------------------------------------------------

class Player {
  constructor({ ciphertext, ctSha256, key, meta, renderer, onFrame }) {
    this.base = { ciphertext, ctSha256, key, meta };
    this.renderer = renderer;
    this.onFrame = onFrame;
    this.fps = 10;
    this.ecc = DEFAULT_ECC;
    this.densityId = DEFAULT_DENSITY;
    this.running = false;
    this.position = 0;
    this.raf = 0;
    this.nextAt = 0;
    this.rebuild();
  }

  /** New stream: new stream id, chunking and QR version. */
  rebuild() {
    const chunkSize = chunkSizeFor(this.densityId, this.ecc, this.base.ciphertext.length);
    const streamId = new DataView(crypto.randomBytes(4).buffer).getUint32(0);
    this.source = new FrameSource({ ...this.base, chunkSize, streamId });
    // Encode every frame at one version so the code does not jump in size.
    this.minVersion = encodeBytes(new Uint8Array(this.source.maxFrameLength), { ecc: this.ecc, mask: 0 }).version;
    this.loopLength = framesPerLoop(this.source.total);
    this.position = 0;
    this.pending = this.encode(0);
  }

  encode(position) {
    const { slot, bytes } = this.source.frameAt(position);
    return { position, slot, qr: encodeBytes(bytes, { ecc: this.ecc, minVersion: this.minVersion }) };
  }

  setFps(fps) { this.fps = fps; }

  setStream({ densityId = this.densityId, ecc = this.ecc }) {
    this.densityId = densityId;
    this.ecc = ecc;
    this.rebuild();
    this.nextAt = 0;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.nextAt = 0;
    const tick = (now) => {
      if (!this.running) return;
      if (now >= this.nextAt) {
        const interval = 1000 / this.fps;
        // Stay on schedule, but never try to catch up a backlog of frames.
        this.nextAt = now - this.nextAt > interval ? now + interval : this.nextAt + interval;
        const frame = this.pending;
        this.renderer.draw(frame.qr);
        this.onFrame(frame, this);
        this.position = frame.position + 1;
        // Encode the next frame right away so it is ready at the next swap.
        this.pending = this.encode(this.position);
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }
}

let player = null;

// -- Screen wake lock ----------------------------------------------------------------

let wakeLock = null;

async function keepAwake() {
  try {
    if ("wakeLock" in navigator && document.visibilityState === "visible" && player?.running) {
      wakeLock = await navigator.wakeLock.request("screen");
    }
  } catch {
    // Not supported or denied; the transfer still works.
  }
}

// -- Main flow -------------------------------------------------------------------------

function startCountdown(expiresAtMs, clockOffset) {
  show(els.expiry);
  const update = () => {
    const remaining = (expiresAtMs - (Date.now() + clockOffset)) / 1000;
    if (remaining <= 0) {
      clearInterval(timer);
      forgetKey();
      terminal("Transfer expired", "This transfer is no longer available.");
      return;
    }
    els.expiry.textContent = `Expires in ${formatDuration(remaining)}`;
    els.expiry.classList.toggle("warn", remaining < 120);
  };
  const timer = setInterval(update, 1000);
  update();
}

function startPolling() {
  const timer = setInterval(async () => {
    try {
      await api.getTransfer(transferId);
    } catch (err) {
      if (err.status === 404) {
        clearInterval(timer);
        forgetKey();
        terminal("Transfer no longer available", "It expired or was deleted by the sender.");
      }
      // Network hiccups are ignored: the data is already local.
    }
  }, POLL_MS);
}

async function waitUntilReady() {
  for (;;) {
    const result = await api.getTransfer(transferId);
    if (result.info.ready) return result;
    overlay("Waiting for upload…", "The sender is still uploading. This page continues automatically.", undefined);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

function setupControls(defaultFps, maxFps, minFps) {
  Object.assign(els.fps, { min: minFps, max: maxFps, value: defaultFps });
  els.fpsOut.textContent = `${defaultFps} fps`;
  for (const d of DENSITIES) els.density.add(new Option(d.label, d.id, false, d.id === DEFAULT_DENSITY));
  for (const e of ECC_LEVELS) els.ecc.add(new Option(e, e, false, e === DEFAULT_ECC));

  els.fps.addEventListener("input", () => {
    els.fpsOut.textContent = `${els.fps.value} fps`;
    player.setFps(Number(els.fps.value));
  });
  const restream = () => player.setStream({ densityId: els.density.value, ecc: els.ecc.value });
  els.density.addEventListener("change", restream);
  els.ecc.addEventListener("change", restream);
  els.pause.addEventListener("click", () => {
    if (player.running) {
      player.stop();
      els.pause.textContent = "Resume";
    } else {
      player.start();
      els.pause.textContent = "Pause";
      keepAwake();
    }
  });
  els.fullscreen.addEventListener("click", () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else els.viewport.requestFullscreen?.().catch(() => {});
  });
  document.addEventListener("fullscreenchange", () => requestAnimationFrame(() => player.renderer.redraw()));
  window.addEventListener("resize", () => player.renderer.redraw());
  document.addEventListener("visibilitychange", keepAwake);
}

function onFrame({ position, slot, qr }, p) {
  const inLoop = position % p.loopLength;
  const label = slot.type === "manifest" ? "manifest" : `chunk ${slot.index + 1} / ${p.source.total}`;
  els.frame.textContent = `Frame ${inLoop + 1} / ${p.loopLength} · ${label}`;
  els.pass.textContent = `Pass ${Math.floor(position / p.loopLength) + 1} · v${qr.version} ${qr.ecc} · ${p.fps} fps`;
  els.loop.value = (inLoop + 1) / p.loopLength;
}

async function main() {
  try {
    crypto.assertSupported();
  } catch (err) {
    terminal("Secure connection required", err.message);
    return;
  }
  const key = takeKey();
  if (!key) {
    terminal("Missing key", "This link is incomplete. Ask the sender for the full link, including the part after #.");
    return;
  }

  let result;
  try {
    result = await api.getTransfer(transferId);
    if (!result.info.ready) result = await waitUntilReady();
  } catch (err) {
    if (err.status === 404) {
      forgetKey();
      terminal("Transfer not available", "It expired, was deleted, or the link is wrong.");
    } else {
      terminal("Could not load transfer", err.message);
    }
    return;
  }
  const { info, serverNow } = result;
  const clockOffset = serverNow - Date.now();

  let meta;
  try {
    meta = await crypto.openMeta(key, crypto.fromBase64(info.meta));
  } catch {
    terminal("Wrong key", "The key in this link does not match the transfer.");
    return;
  }
  document.title = `${meta.name} · QR Transfer`;
  els.name.textContent = meta.name;
  els.facts.textContent = `${formatBytes(meta.size)} · end-to-end encrypted`;
  startCountdown(info.expires_at * 1000, clockOffset);

  let ciphertext;
  try {
    overlay("Downloading encrypted data…", formatBytes(info.size), 0);
    ciphertext = await api.downloadBlob(transferId, info.size, (f) => { els.overlayBar.value = f; });
    overlay("Verifying…", "Checking that the data decrypts correctly.", undefined);
    // Decrypt once locally to catch corruption before streaming it.
    const plaintext = await crypto.open(key, ciphertext, crypto.FILE_AAD);
    if (crypto.toHex(await crypto.sha256(plaintext)) !== meta.sha256) throw new Error("checksum mismatch");
  } catch (err) {
    terminal("Transfer is damaged", `The data could not be verified (${err.message}).`);
    return;
  }

  const renderer = new Renderer(els.canvas, els.viewport);
  player = new Player({
    ciphertext,
    ctSha256: await crypto.sha256(ciphertext),
    key,
    meta: crypto.fromBase64(info.meta),
    renderer,
    onFrame,
  });
  player.setFps(info.fps);
  const config = await api.getConfig().catch(() => ({ min_fps: 1, max_fps: Math.max(15, info.fps) }));
  setupControls(info.fps, config.max_fps, config.min_fps);

  show(els.overlay, false);
  show(els.qrbox);
  show(els.status);
  show(els.controls);
  show(els.instructions);
  els.facts.textContent += ` · ${player.source.total.toLocaleString()} chunks`;
  player.start();
  keepAwake();
  startPolling();
}

main();
