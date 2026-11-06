// QR Transfer web page: pick a file, encrypt it locally and play it as
// animated QR codes. Nothing is uploaded; the page needs no server.

import * as crypto from "./crypto.js";
import { Player, Renderer } from "./player.js";
import { encodeBytes } from "./qr.js";
import {
  CIPHERTEXT_OVERHEAD, DEFAULT_DENSITY, DEFAULT_ECC, DENSITIES, ECC_LEVELS, estimate,
} from "./transport.js";
import { $, formatBytes, formatDuration, show } from "./ui.js";

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MIN_FPS = 1;
const MAX_FPS = 15;
const DEFAULT_FPS = 10;

const els = {
  pick: $("#pick"), drop: $("#drop"), file: $("#file"), limit: $("#limit"),
  dropTitle: $("#dropTitle"), dropHint: $("#dropHint"),
  summary: $("#summary"), fileName: $("#fileName"), fileSize: $("#fileSize"), estimate: $("#estimate"),
  start: $("#start"), error: $("#error"),
  stage: $("#stage"), name: $("#name"), facts: $("#facts"),
  viewport: $("#viewport"), canvas: $("#qr"), overlay: $("#overlay"), overlayTitle: $("#overlayTitle"),
  frame: $("#frame"), pass: $("#pass"), loop: $("#loop"),
  fps: $("#fps"), fpsOut: $("#fpsOut"), density: $("#density"), ecc: $("#ecc"),
  pause: $("#pause"), fullscreen: $("#fullscreen"), stop: $("#stop"),
  app: $("#app"), apk: $("#apk"), apkQr: $("#apkQr"),
};

let selected = null;
let player = null;
let wakeLock = null;

function fail(message) {
  els.error.textContent = message;
  show(els.error);
}

// -- Pick ----------------------------------------------------------------------------

function refreshEstimate() {
  els.fpsOut.textContent = `${els.fps.value} fps`;
  if (!selected) return;
  const est = estimate(selected.size + CIPHERTEXT_OVERHEAD, {
    densityId: els.density.value, ecc: els.ecc.value, fps: Number(els.fps.value),
  });
  els.estimate.textContent =
    `${est.framesPerLoop.toLocaleString()} QR frames, ≈ ${formatDuration(est.secondsPerLoop)} per pass`;
}

function selectFile(file) {
  show(els.error, false);
  selected = null;
  els.start.disabled = true;
  if (!file) return;
  if (file.size > MAX_FILE_BYTES) {
    fail(`${file.name} is ${formatBytes(file.size)}; the limit is ${formatBytes(MAX_FILE_BYTES)}.`);
    return;
  }
  selected = file;
  els.fileName.textContent = file.name;
  els.fileSize.textContent = formatBytes(file.size);
  els.dropTitle.textContent = "Choose another file";
  els.dropHint.textContent = file.name;
  show(els.summary);
  els.start.disabled = false;
  refreshEstimate();
}

// -- Play ----------------------------------------------------------------------------

async function keepAwake() {
  try {
    if ("wakeLock" in navigator && document.visibilityState === "visible" && player?.running) {
      wakeLock = await navigator.wakeLock.request("screen");
    }
  } catch {
    // Not supported or denied; playback still works.
  }
}

function onFrame({ position, slot, qr }, p) {
  const inLoop = position % p.loopLength;
  const label = slot.type === "manifest" ? "key frame" : `chunk ${slot.index + 1} / ${p.source.total}`;
  els.frame.textContent = `Frame ${inLoop + 1} / ${p.loopLength} · ${label}`;
  els.pass.textContent = `Pass ${Math.floor(position / p.loopLength) + 1} · v${qr.version} ${qr.ecc} · ${p.fps} fps`;
  els.loop.value = (inLoop + 1) / p.loopLength;
}

async function start() {
  if (!selected) return;
  show(els.error, false);
  els.start.disabled = true;
  els.start.textContent = "Encrypting…";
  try {
    const plaintext = new Uint8Array(await selected.arrayBuffer());
    // The key travels in the key frame; encryption keeps the stream format
    // identical to the password-protected mode planned for later.
    const key = crypto.generateKey();
    const meta = await crypto.buildMeta(selected, plaintext);
    const [ciphertext, metaBlob] = await Promise.all([
      crypto.seal(key, plaintext, crypto.FILE_AAD),
      crypto.sealMeta(key, meta),
    ]);

    player = new Player({
      ciphertext,
      ctSha256: await crypto.sha256(ciphertext),
      key,
      meta: metaBlob,
      renderer: new Renderer(els.canvas, els.viewport),
      onFrame,
      fps: Number(els.fps.value),
    });
    player.setStream({ densityId: els.density.value, ecc: els.ecc.value });

    document.title = `${meta.name} · QR Transfer`;
    els.name.textContent = meta.name;
    els.facts.textContent = `${formatBytes(meta.size)} · ${player.source.total.toLocaleString()} chunks`;
    show(els.pick, false);
    show(els.stage);
    document.body.classList.add("playing");
    els.pause.textContent = "Pause";
    // Let layout settle so the first frame is sized to the viewport.
    requestAnimationFrame(() => {
      player.start();
      keepAwake();
    });
  } catch (err) {
    fail(`Could not prepare the file: ${err.message}`);
  } finally {
    els.start.disabled = !selected;
    els.start.textContent = "Start transfer";
  }
}

function stop() {
  player?.stop();
  player = null;
  wakeLock?.release().catch(() => {});
  wakeLock = null;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  document.title = "QR Transfer";
  document.body.classList.remove("playing");
  show(els.stage, false);
  show(els.pick);
}

// -- App download --------------------------------------------------------------------

/** Static QR code of a URL, crisp at the canvas' CSS size. */
function drawStaticQr(canvas, text) {
  const qr = encodeBytes(new TextEncoder().encode(text), { ecc: "M" });
  const dpr = window.devicePixelRatio || 1;
  const modules = qr.size + 8; // 4-module quiet zone on each side
  const cssSize = canvas.getBoundingClientRect().width || 132;
  const scale = Math.max(1, Math.floor((cssSize * dpr) / modules));
  const px = scale * modules;
  canvas.width = px;
  canvas.height = px;
  canvas.style.width = `${px / dpr}px`;
  canvas.style.height = `${px / dpr}px`;
  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = "#000";
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.modules[y * qr.size + x]) ctx.fillRect((x + 4) * scale, (y + 4) * scale, scale, scale);
    }
  }
}

function setupAppDownload() {
  // The download card only exists in builds that bundle an APK.
  if (els.app.hidden) return;
  drawStaticQr(els.apkQr, els.apk.href);
}

// -- Setup ---------------------------------------------------------------------------

function init() {
  setupAppDownload();
  try {
    crypto.assertSupported();
  } catch (err) {
    fail(err.message);
    els.start.disabled = true;
    return;
  }

  els.limit.textContent = `Up to ${formatBytes(MAX_FILE_BYTES)} · stays on this device`;
  Object.assign(els.fps, { min: MIN_FPS, max: MAX_FPS, value: DEFAULT_FPS });
  for (const d of DENSITIES) els.density.add(new Option(d.label, d.id, false, d.id === DEFAULT_DENSITY));
  for (const e of ECC_LEVELS) els.ecc.add(new Option(e, e, false, e === DEFAULT_ECC));
  refreshEstimate();

  els.file.addEventListener("change", () => selectFile(els.file.files[0]));
  els.start.addEventListener("click", start);
  els.stop.addEventListener("click", stop);

  els.fps.addEventListener("input", () => {
    refreshEstimate();
    player?.setFps(Number(els.fps.value));
  });
  const restream = () => {
    refreshEstimate();
    if (!player) return;
    player.setStream({ densityId: els.density.value, ecc: els.ecc.value });
    els.facts.textContent = `${formatBytes(selected.size)} · ${player.source.total.toLocaleString()} chunks`;
  };
  els.density.addEventListener("change", restream);
  els.ecc.addEventListener("change", restream);

  els.pause.addEventListener("click", () => {
    if (!player) return;
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
  document.addEventListener("fullscreenchange", () => requestAnimationFrame(() => player?.renderer.redraw()));
  window.addEventListener("resize", () => player?.renderer.redraw());
  document.addEventListener("visibilitychange", keepAwake);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && player && !document.fullscreenElement) stop();
  });

  for (const type of ["dragenter", "dragover"]) {
    els.drop.addEventListener(type, (e) => { e.preventDefault(); els.drop.classList.add("over"); });
  }
  for (const type of ["dragleave", "drop"]) {
    els.drop.addEventListener(type, () => els.drop.classList.remove("over"));
  }
  els.drop.addEventListener("drop", (e) => {
    e.preventDefault();
    selectFile(e.dataTransfer.files[0]);
  });
}

init();
