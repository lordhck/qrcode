// Client-side encryption (WebCrypto, AES-256-GCM).
//
// blob = nonce(12) || ciphertext || tag(16)
// The file and the metadata are encrypted under the same random key with
// independent random nonces and distinct additional data labels.

export const KEY_BYTES = 32;
export const NONCE_BYTES = 12;
export const FILE_AAD = new TextEncoder().encode("qrt1-file");
export const META_AAD = new TextEncoder().encode("qrt1-meta");

const subtle = globalThis.crypto?.subtle;

export function assertSupported() {
  if (!subtle) {
    throw new Error("WebCrypto is unavailable. Open this page over HTTPS (or on localhost).");
  }
}

export function randomBytes(length) {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

export function generateKey() {
  return randomBytes(KEY_BYTES);
}

async function importKey(raw, usage) {
  if (raw.length !== KEY_BYTES) throw new Error("invalid key length");
  return subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [usage]);
}

/** Encrypt `plaintext`; `nonce` is only passed by tests. */
export async function seal(rawKey, plaintext, aad, nonce = randomBytes(NONCE_BYTES)) {
  const key = await importKey(rawKey, "encrypt");
  const ct = new Uint8Array(
    await subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 }, key, plaintext),
  );
  const out = new Uint8Array(NONCE_BYTES + ct.length);
  out.set(nonce);
  out.set(ct, NONCE_BYTES);
  return out;
}

/** Decrypt a blob produced by `seal`. Throws on wrong key or tampering. */
export async function open(rawKey, blob, aad) {
  if (blob.length < NONCE_BYTES + 16) throw new Error("ciphertext too short");
  const key = await importKey(rawKey, "decrypt");
  const pt = await subtle.decrypt(
    { name: "AES-GCM", iv: blob.subarray(0, NONCE_BYTES), additionalData: aad, tagLength: 128 },
    key,
    blob.subarray(NONCE_BYTES),
  );
  return new Uint8Array(pt);
}

export async function sha256(bytes) {
  return new Uint8Array(await subtle.digest("SHA-256", bytes));
}

export function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// -- Base64 ------------------------------------------------------------------------

export function toBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(text) {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function toBase64Url(bytes) {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text) {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("invalid base64url");
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  return fromBase64(padded);
}

// -- Metadata --------------------------------------------------------------------------

const MAX_NAME_BYTES = 255;

function truncateUtf8(text, maxBytes) {
  const enc = new TextEncoder();
  if (enc.encode(text).length <= maxBytes) return text;
  let out = "";
  for (const ch of text) {
    if (enc.encode(out + ch).length > maxBytes) break;
    out += ch;
  }
  return out;
}

/** Build the plaintext metadata record for a file. */
export async function buildMeta(file, plaintext) {
  return {
    v: 1,
    name: truncateUtf8(file.name || "file", MAX_NAME_BYTES),
    type: (file.type || "application/octet-stream").slice(0, 100),
    size: plaintext.length,
    sha256: toHex(await sha256(plaintext)),
  };
}

export async function sealMeta(rawKey, meta) {
  return seal(rawKey, new TextEncoder().encode(JSON.stringify(meta)), META_AAD);
}

export async function openMeta(rawKey, blob) {
  const meta = JSON.parse(new TextDecoder().decode(await open(rawKey, blob, META_AAD)));
  if (meta?.v !== 1 || typeof meta.name !== "string" || !Number.isInteger(meta.size)) {
    throw new Error("unsupported metadata");
  }
  return meta;
}
