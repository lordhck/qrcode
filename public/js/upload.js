// Sender page: pick a file, encrypt it locally, upload ciphertext, share link.

import * as api from "./api.js";
import * as crypto from "./crypto.js";
import { CIPHERTEXT_OVERHEAD, estimate } from "./transport.js";
import { $, errorMessage, formatBytes, formatDuration, formatTtl, show } from "./ui.js";

const TTL_CHOICES = [600, 3600, 6 * 3600, 86400];

const els = {
  pick: $("#pick"), drop: $("#drop"), file: $("#file"), limit: $("#limit"),
  dropTitle: $("#dropTitle"), dropHint: $("#dropHint"),
  summary: $("#summary"), fileName: $("#fileName"), fileSize: $("#fileSize"), estimate: $("#estimate"),
  ttl: $("#ttl"), fps: $("#fps"), fpsOut: $("#fpsOut"), send: $("#send"),
  progress: $("#progress"), stage: $("#stage"), bar: $("#bar"),
  done: $("#done"), link: $("#link"), copy: $("#copy"), expires: $("#expires"),
  open: $("#open"), del: $("#delete"), again: $("#again"), error: $("#error"),
};

let config = null;
let selected = null;
let current = null; // {id, token}

function fail(err) {
  els.error.textContent = errorMessage(err);
  show(els.error);
}

function clearError() {
  show(els.error, false);
}

function refreshEstimate() {
  els.fpsOut.textContent = `${els.fps.value} fps`;
  if (!selected) return;
  const ctLength = selected.size + CIPHERTEXT_OVERHEAD;
  const est = estimate(ctLength, { fps: Number(els.fps.value) });
  els.estimate.textContent =
    `${est.framesPerLoop.toLocaleString()} QR frames, ≈ ${formatDuration(est.secondsPerLoop)} per pass`;
}

function selectFile(file) {
  clearError();
  selected = null;
  els.send.disabled = true;
  if (!file) return;
  if (file.size + CIPHERTEXT_OVERHEAD > config.max_size) {
    fail(new Error(`${file.name} is ${formatBytes(file.size)}; the limit is ${formatBytes(config.max_size - CIPHERTEXT_OVERHEAD)}.`));
    return;
  }
  selected = file;
  els.fileName.textContent = file.name;
  els.fileSize.textContent = formatBytes(file.size);
  els.dropTitle.textContent = "Choose another file";
  els.dropHint.textContent = file.name;
  show(els.summary);
  els.send.disabled = false;
  refreshEstimate();
}

async function send() {
  if (!selected) return;
  clearError();
  els.send.disabled = true;
  show(els.pick, false);
  show(els.progress);
  try {
    els.stage.textContent = "Reading file…";
    els.bar.removeAttribute("value");
    const plaintext = new Uint8Array(await selected.arrayBuffer());

    els.stage.textContent = "Encrypting…";
    const key = crypto.generateKey();
    const meta = await crypto.buildMeta(selected, plaintext);
    const [blob, metaBlob] = await Promise.all([
      crypto.seal(key, plaintext, crypto.FILE_AAD),
      crypto.sealMeta(key, meta),
    ]);

    els.stage.textContent = "Creating transfer…";
    const created = await api.createTransfer({
      size: blob.length,
      meta: crypto.toBase64(metaBlob),
      ttlSeconds: Number(els.ttl.value),
      fps: Number(els.fps.value),
    });
    current = { id: created.id, token: created.upload_token };

    els.stage.textContent = "Uploading encrypted data…";
    els.bar.value = 0;
    await api.uploadBlob(created.id, created.upload_token, blob, (f) => {
      els.bar.value = f;
      els.stage.textContent = `Uploading encrypted data… ${Math.round(f * 100)} %`;
    });

    const url = `${location.origin}/t/${created.id}#k=${crypto.toBase64Url(key)}`;
    els.link.value = url;
    els.open.href = url;
    els.expires.textContent = `Expires ${new Date(created.expires_at * 1000).toLocaleString()}.`;
    show(els.progress, false);
    show(els.done);
  } catch (err) {
    show(els.progress, false);
    show(els.pick);
    els.send.disabled = !selected;
    if (current) {
      // Do not leave an empty session behind after a failed upload.
      api.deleteTransfer(current.id, current.token).catch(() => {});
      current = null;
    }
    fail(err);
  }
}

async function copyLink() {
  try {
    await navigator.clipboard.writeText(els.link.value);
    els.copy.textContent = "Copied";
  } catch {
    els.link.select();
    els.copy.textContent = "Press Ctrl+C";
  }
  setTimeout(() => { els.copy.textContent = "Copy"; }, 2000);
}

async function deleteNow() {
  if (!current) return;
  clearError();
  try {
    await api.deleteTransfer(current.id, current.token);
    current = null;
    els.link.value = "";
    els.expires.textContent = "Deleted. The link no longer works.";
    els.open.removeAttribute("href");
    els.del.disabled = true;
  } catch (err) {
    fail(err);
  }
}

function reset() {
  current = null;
  selected = null;
  els.file.value = "";
  els.del.disabled = false;
  els.dropTitle.textContent = "Choose a file";
  els.dropHint.textContent = "or drop it here";
  show(els.summary, false);
  show(els.done, false);
  show(els.pick);
  els.send.disabled = true;
}

async function init() {
  try {
    crypto.assertSupported();
    config = await api.getConfig();
  } catch (err) {
    els.send.disabled = true;
    fail(err);
    return;
  }

  els.limit.textContent = `Up to ${formatBytes(config.max_size - CIPHERTEXT_OVERHEAD)}`;
  const choices = [...new Set([...TTL_CHOICES, config.default_ttl])]
    .filter((t) => t >= config.min_ttl && t <= config.max_ttl)
    .sort((a, b) => a - b);
  for (const ttl of choices) {
    const option = new Option(formatTtl(ttl), String(ttl), false, ttl === config.default_ttl);
    els.ttl.add(option);
  }
  Object.assign(els.fps, { min: config.min_fps, max: config.max_fps, value: config.default_fps });
  refreshEstimate();

  els.file.addEventListener("change", () => selectFile(els.file.files[0]));
  els.fps.addEventListener("input", refreshEstimate);
  els.send.addEventListener("click", send);
  els.copy.addEventListener("click", copyLink);
  els.del.addEventListener("click", deleteNow);
  els.again.addEventListener("click", reset);

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
