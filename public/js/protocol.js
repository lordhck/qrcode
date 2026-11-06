// QR transport protocol v1, sender side.
// Mirrors app/core/protocol.py; both are tested against tests/vectors/protocol.json.

export const VERSION = 1;
export const TYPE_DATA = 0x0;
export const TYPE_MANIFEST = 0x1;
export const HEADER_SIZE = 13;
export const OVERHEAD = 17;
export const MANIFEST_INTERVAL = 10;
export const FLAG_PASSWORD = 0x01;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32/IEEE (same as zlib.crc32). */
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function checkU32(name, value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`${name} out of range`);
  }
}

export function chunkCount(ctLength, chunkSize) {
  if (ctLength <= 0 || chunkSize <= 0) throw new RangeError("lengths must be positive");
  return Math.ceil(ctLength / chunkSize);
}

export function encodeFrame(type, streamId, index, total, payload) {
  if (!Number.isInteger(type) || type < 0 || type > 0xf) throw new RangeError("frame type out of range");
  checkU32("streamId", streamId);
  checkU32("index", index);
  checkU32("total", total);
  const out = new Uint8Array(OVERHEAD + payload.length);
  const view = new DataView(out.buffer);
  view.setUint8(0, (VERSION << 4) | type);
  view.setUint32(1, streamId);
  view.setUint32(5, index);
  view.setUint32(9, total);
  out.set(payload, HEADER_SIZE);
  view.setUint32(HEADER_SIZE + payload.length, crc32(out.subarray(0, HEADER_SIZE + payload.length)));
  return out;
}

/**
 * @param {{chunkSize: number, ctLength: number, ctSha256: Uint8Array,
 *          key: Uint8Array, meta: Uint8Array, salt?: Uint8Array|null}} m
 */
export function encodeManifest({ chunkSize, ctLength, ctSha256, key, meta, salt = null }) {
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 0xffff) throw new RangeError("chunkSize out of range");
  if (!Number.isInteger(ctLength) || ctLength < 1 || ctLength > 0xffffffff) throw new RangeError("ctLength out of range");
  if (ctSha256.length !== 32 || key.length !== 32) throw new RangeError("bad digest or key length");
  if (salt !== null && salt.length !== 16) throw new RangeError("bad salt length");
  if (meta.length > 0xffff) throw new RangeError("meta too long");

  const out = new Uint8Array(7 + 32 + 32 + (salt ? 16 : 0) + 2 + meta.length);
  const view = new DataView(out.buffer);
  view.setUint8(0, salt ? FLAG_PASSWORD : 0);
  view.setUint16(1, chunkSize);
  view.setUint32(3, ctLength);
  let o = 7;
  out.set(ctSha256, o); o += 32;
  out.set(key, o); o += 32;
  if (salt) { out.set(salt, o); o += 16; }
  view.setUint16(o, meta.length); o += 2;
  out.set(meta, o);
  return out;
}

/** Fixed-size chunks of the ciphertext; the last one is zero-padded. */
export function splitChunks(ciphertext, chunkSize) {
  const count = chunkCount(ciphertext.length, chunkSize);
  const chunks = [];
  for (let i = 0; i < count; i++) {
    const chunk = new Uint8Array(chunkSize);
    chunk.set(ciphertext.subarray(i * chunkSize, (i + 1) * chunkSize));
    chunks.push(chunk);
  }
  return chunks;
}

/**
 * Looping frame schedule: position 0, 10, 20, ... is the manifest; the
 * remaining slots cycle through data chunks in order.
 * Returns {type: "manifest"} or {type: "data", index}.
 */
export function slotAt(position, total) {
  if (position % MANIFEST_INTERVAL === 0) return { type: "manifest" };
  const dataSlots = MANIFEST_INTERVAL - 1;
  const n = Math.floor(position / MANIFEST_INTERVAL) * dataSlots + (position % MANIFEST_INTERVAL) - 1;
  return { type: "data", index: n % total };
}

/** Frames (incl. manifest slots) per complete pass over all data chunks. */
export function framesPerLoop(total) {
  return Math.ceil((total * MANIFEST_INTERVAL) / (MANIFEST_INTERVAL - 1));
}

/**
 * Builds frames lazily for one display session (one stream id).
 * Data frames are encoded on demand so memory stays at the ciphertext size.
 */
export class FrameSource {
  constructor({ ciphertext, ctSha256, key, meta, chunkSize, streamId, salt = null }) {
    this.ciphertext = ciphertext;
    this.chunkSize = chunkSize;
    this.streamId = streamId;
    this.total = chunkCount(ciphertext.length, chunkSize);
    this.manifestFrame = encodeFrame(
      TYPE_MANIFEST, streamId, 0, this.total,
      encodeManifest({ chunkSize, ctLength: ciphertext.length, ctSha256, key, meta, salt }),
    );
  }

  dataFrame(index) {
    const chunk = new Uint8Array(this.chunkSize);
    chunk.set(this.ciphertext.subarray(index * this.chunkSize, (index + 1) * this.chunkSize));
    return encodeFrame(TYPE_DATA, this.streamId, index, this.total, chunk);
  }

  frameAt(position) {
    const slot = slotAt(position, this.total);
    return slot.type === "manifest"
      ? { slot, bytes: this.manifestFrame }
      : { slot, bytes: this.dataFrame(slot.index) };
  }

  /** Largest frame in this stream (decides the QR version). */
  get maxFrameLength() {
    return Math.max(this.manifestFrame.length, OVERHEAD + this.chunkSize);
  }
}
