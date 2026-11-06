// QR density presets and transfer time estimates, shared by both pages.

import { chunkCount, framesPerLoop, OVERHEAD } from "./protocol.js";
import { versionFor } from "./qr.js";

// Payload bytes per frame. Larger is faster but needs a sharper camera image.
export const DENSITIES = [
  { id: "low", label: "Low", chunkSize: 400 },
  { id: "standard", label: "Standard", chunkSize: 900 },
  { id: "high", label: "High", chunkSize: 1400 },
  { id: "max", label: "Max", chunkSize: 2000 },
];
export const DEFAULT_DENSITY = "standard";
export const ECC_LEVELS = ["L", "M", "Q"];
export const DEFAULT_ECC = "M";

// AES-GCM nonce + tag added to every plaintext.
export const CIPHERTEXT_OVERHEAD = 28;

export function density(id) {
  return DENSITIES.find((d) => d.id === id) ?? DENSITIES.find((d) => d.id === DEFAULT_DENSITY);
}

/**
 * Pick a chunk size that fits the requested density at this ECC level and
 * never exceeds the ciphertext (no point padding a tiny file to 2 KB).
 */
export function chunkSizeFor(densityId, ecc, ctLength) {
  let size = Math.min(density(densityId).chunkSize, ctLength);
  while (size > 16 && versionFor(size + OVERHEAD, ecc) < 0) size -= 16;
  return size;
}

export function estimate(ctLength, { densityId = DEFAULT_DENSITY, ecc = DEFAULT_ECC, fps }) {
  const chunkSize = chunkSizeFor(densityId, ecc, ctLength);
  const chunks = chunkCount(ctLength, chunkSize);
  const frames = framesPerLoop(chunks);
  return {
    chunkSize,
    chunks,
    framesPerLoop: frames,
    secondsPerLoop: frames / fps,
    version: versionFor(chunkSize + OVERHEAD, ecc),
  };
}
