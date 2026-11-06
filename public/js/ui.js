// Small DOM and formatting helpers.

export const $ = (selector) => document.querySelector(selector);

export function show(el, visible = true) {
  el.hidden = !visible;
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export function formatDuration(seconds) {
  seconds = Math.max(0, Math.round(seconds));
  if (seconds < 60) return `${seconds} s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h} h ${String(m).padStart(2, "0")} min`;
  return s ? `${m} min ${String(s).padStart(2, "0")} s` : `${m} min`;
}

export function formatTtl(seconds) {
  if (seconds % 86400 === 0) return `${seconds / 86400} day${seconds === 86400 ? "" : "s"}`;
  if (seconds % 3600 === 0) return `${seconds / 3600} hour${seconds === 3600 ? "" : "s"}`;
  return `${Math.round(seconds / 60)} minutes`;
}

export function errorMessage(err) {
  if (err?.status === 413) return "The file is too large for this server.";
  if (err?.status === 429) return "Too many transfers, wait a minute and try again.";
  if (err?.status === 507) return "The server is out of space, try again later.";
  return err?.message || String(err);
}
