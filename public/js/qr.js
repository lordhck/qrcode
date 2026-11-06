// QR Code encoder (ISO/IEC 18004), byte mode only, versions 1-40.
//
// Written for this project so the frontend has no third-party dependencies.
// The algorithm follows the standard: data bits -> Reed-Solomon ECC blocks ->
// interleaving -> zigzag placement -> best of 8 masks by penalty score.
// Function patterns are cached per (version, ECC level) because a transfer
// encodes thousands of same-sized frames.

const ECC = {
  L: { ordinal: 0, formatBits: 1 },
  M: { ordinal: 1, formatBits: 0 },
  Q: { ordinal: 2, formatBits: 3 },
  H: { ordinal: 3, formatBits: 2 },
};

// Indexed [ecc ordinal][version]; index 0 is unused.
const ECC_CODEWORDS_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const NUM_ERROR_CORRECTION_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

export const MIN_VERSION = 1;
export const MAX_VERSION = 40;

function eccOf(level) {
  const ecc = ECC[level];
  if (!ecc) throw new RangeError(`unknown ECC level ${level}`);
  return ecc;
}

function numRawDataModules(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function numDataCodewords(version, ecc) {
  return (
    Math.floor(numRawDataModules(version) / 8) -
    ECC_CODEWORDS_PER_BLOCK[ecc.ordinal][version] * NUM_ERROR_CORRECTION_BLOCKS[ecc.ordinal][version]
  );
}

function byteModeCountBits(version) {
  return version <= 9 ? 8 : 16;
}

/** Maximum payload bytes for a version and ECC level in byte mode. */
export function byteCapacity(version, level) {
  const bits = numDataCodewords(version, eccOf(level)) * 8 - 4 - byteModeCountBits(version);
  return Math.floor(bits / 8);
}

/** Smallest version that holds `length` bytes, or -1 if none does. */
export function versionFor(length, level, minVersion = MIN_VERSION) {
  for (let v = Math.max(minVersion, MIN_VERSION); v <= MAX_VERSION; v++) {
    if (byteCapacity(v, level) >= length) return v;
  }
  return -1;
}

// -- Reed-Solomon over GF(2^8), polynomial 0x11D -----------------------------------

function gfMultiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

const divisorCache = new Map();

function rsDivisor(degree) {
  let cached = divisorCache.get(degree);
  if (cached) return cached;
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  divisorCache.set(degree, result);
  return result;
}

function rsRemainder(data, divisor) {
  const degree = divisor.length;
  const result = new Uint8Array(degree);
  for (const b of data) {
    const factor = b ^ result[0];
    result.copyWithin(0, 1);
    result[degree - 1] = 0;
    for (let i = 0; i < degree; i++) result[i] ^= gfMultiply(divisor[i], factor);
  }
  return result;
}

// -- Codeword construction ------------------------------------------------------------

function dataCodewords(bytes, version, ecc) {
  const capacityBits = numDataCodewords(version, ecc) * 8;
  const out = new Uint8Array(capacityBits / 8);
  let bitLen = 0;
  const append = (value, len) => {
    for (let i = len - 1; i >= 0; i--, bitLen++) {
      if ((value >>> i) & 1) out[bitLen >>> 3] |= 0x80 >>> (bitLen & 7);
    }
  };
  append(0b0100, 4);
  append(bytes.length, byteModeCountBits(version));
  for (const b of bytes) append(b, 8);
  if (bitLen > capacityBits) throw new RangeError("data too long for version");
  // Terminator (up to 4 zero bits), then pad to a byte boundary. The buffer
  // is zero-initialised, so advancing the bit length is enough.
  bitLen = Math.min(bitLen + 4, capacityBits);
  bitLen = Math.ceil(bitLen / 8) * 8;
  for (let pad = 0xec; bitLen < capacityBits; pad ^= 0xec ^ 0x11) {
    append(pad, 8);
  }
  return out;
}

function addEccAndInterleave(data, version, ecc) {
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ecc.ordinal][version];
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecc.ordinal][version];
  const rawCodewords = Math.floor(numRawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const divisor = rsDivisor(blockEccLen);

  const blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const datLen = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
    const dat = data.subarray(k, k + datLen);
    k += datLen;
    const block = new Uint8Array(shortBlockLen + 1);
    // Short blocks get a placeholder byte so all blocks share one layout.
    const offset = i < numShortBlocks ? 1 : 0;
    block.set(dat, 0);
    block.set(rsRemainder(dat, divisor), datLen + offset);
    blocks.push(block);
  }

  const result = new Uint8Array(rawCodewords);
  let n = 0;
  for (let i = 0; i < shortBlockLen + 1; i++) {
    for (let j = 0; j < numBlocks; j++) {
      // Skip the placeholder byte of short blocks.
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result[n++] = blocks[j][i];
    }
  }
  return result;
}

// -- Function patterns -----------------------------------------------------------------

function alignmentPositions(version) {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const step = Math.floor((version * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
  const result = [6];
  for (let pos = version * 4 + 17 - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

function formatBits(ecc, mask) {
  const data = (ecc.formatBits << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function drawFormatBits(modules, size, bits) {
  const get = (i) => (bits >>> i) & 1;
  const set = (x, y, v) => { modules[y * size + x] = v; };
  for (let i = 0; i <= 5; i++) set(8, i, get(i));
  set(8, 7, get(6));
  set(8, 8, get(7));
  set(7, 8, get(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, get(i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, get(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, get(i));
  set(8, size - 8, 1); // Always-dark module.
}

const templateCache = new Map();

/** Build (and cache) function patterns: base module values + reserved mask. */
function template(version, ecc) {
  const key = version * 4 + ecc.ordinal;
  const cached = templateCache.get(key);
  if (cached) return cached;

  const size = version * 4 + 17;
  const modules = new Uint8Array(size * size);
  const isFunction = new Uint8Array(size * size);
  const set = (x, y, dark) => {
    modules[y * size + x] = dark ? 1 : 0;
    isFunction[y * size + x] = 1;
  };

  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || x >= size || y < 0 || y >= size) continue;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, dist !== 2 && dist !== 4);
      }
    }
  }
  const align = alignmentPositions(version);
  const last = align.length - 1;
  for (let i = 0; i < align.length; i++) {
    for (let j = 0; j < align.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          set(align[i] + dx, align[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }
  // Reserve format areas (real bits are drawn per mask later).
  drawFormatBits(modules, size, 0);
  for (let i = 0; i <= 8; i++) {
    isFunction[8 * size + i] = 1;
    isFunction[i * size + 8] = 1;
  }
  for (let i = 0; i < 8; i++) {
    isFunction[8 * size + (size - 1 - i)] = 1;
    isFunction[(size - 1 - i) * size + 8] = 1;
  }
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = (bits >>> i) & 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, bit);
      set(b, a, bit);
    }
  }

  // Precompute the zigzag order of data module positions.
  const order = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y * size + x]) order.push(y * size + x);
      }
    }
  }

  const result = { size, modules, isFunction, order: Uint32Array.from(order) };
  templateCache.set(key, result);
  return result;
}

// -- Masks and penalty -------------------------------------------------------------------

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(modules, isFunction, size, mask) {
  const fn = MASKS[mask];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (!isFunction[i] && fn(x, y)) modules[i] ^= 1;
    }
  }
}

function penaltyScore(modules, size) {
  let result = 0;
  const history = new Int32Array(7);

  const addHistory = (runLength) => {
    if (history[0] === 0) runLength += size; // Light border before the first run.
    history.copyWithin(1, 0, 6);
    history[0] = runLength;
  };
  const countPatterns = () => {
    const n = history[1];
    const core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
    return (core && history[0] >= n * 4 && history[6] >= n ? 1 : 0) +
      (core && history[6] >= n * 4 && history[0] >= n ? 1 : 0);
  };
  const terminate = (runColor, runLength) => {
    if (runColor) {
      addHistory(runLength);
      runLength = 0;
    }
    addHistory(runLength + size);
    return countPatterns();
  };

  for (let pass = 0; pass < 2; pass++) {
    for (let a = 0; a < size; a++) {
      let runColor = 0;
      let run = 0;
      history.fill(0);
      for (let b = 0; b < size; b++) {
        const color = pass === 0 ? modules[a * size + b] : modules[b * size + a];
        if (color === runColor) {
          run++;
          if (run === 5) result += PENALTY_N1;
          else if (run > 5) result++;
        } else {
          addHistory(run);
          if (!runColor) result += countPatterns() * PENALTY_N3;
          runColor = color;
          run = 1;
        }
      }
      result += terminate(runColor, run) * PENALTY_N3;
    }
  }

  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = modules[y * size + x];
      if (c === modules[y * size + x + 1] && c === modules[(y + 1) * size + x] && c === modules[(y + 1) * size + x + 1]) {
        result += PENALTY_N2;
      }
    }
  }

  let dark = 0;
  for (const m of modules) dark += m;
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  result += k * PENALTY_N4;
  return result;
}

// -- Public API --------------------------------------------------------------------------

/**
 * Encode bytes as a QR code.
 * @param {Uint8Array} bytes
 * @param {{ecc?: "L"|"M"|"Q"|"H", minVersion?: number, mask?: number}} [options]
 *   mask: 0-7 to force a mask, -1 (default) to pick the lowest penalty.
 * @returns {{version: number, size: number, ecc: string, mask: number, modules: Uint8Array}}
 *   modules is row-major, 1 = dark.
 */
export function encodeBytes(bytes, { ecc: level = "M", minVersion = MIN_VERSION, mask = -1 } = {}) {
  const ecc = eccOf(level);
  const version = versionFor(bytes.length, level, minVersion);
  if (version < 0) throw new RangeError(`${bytes.length} bytes do not fit in a QR code at ECC ${level}`);
  if (mask < -1 || mask > 7) throw new RangeError("mask must be -1..7");

  const codewords = addEccAndInterleave(dataCodewords(bytes, version, ecc), version, ecc);
  const tpl = template(version, ecc);
  const { size, order } = tpl;

  const base = tpl.modules.slice();
  const totalBits = codewords.length * 8;
  for (let i = 0; i < order.length && i < totalBits; i++) {
    base[order[i]] = (codewords[i >>> 3] >>> (7 - (i & 7))) & 1;
  }

  const finish = (m) => {
    const modules = base.slice();
    applyMask(modules, tpl.isFunction, size, m);
    drawFormatBits(modules, size, formatBits(ecc, m));
    return modules;
  };

  if (mask >= 0) return { version, size, ecc: level, mask, modules: finish(mask) };

  let best = null;
  let bestMask = 0;
  let bestPenalty = Infinity;
  for (let m = 0; m < 8; m++) {
    const modules = finish(m);
    const penalty = penaltyScore(modules, size);
    if (penalty < bestPenalty) {
      best = modules;
      bestMask = m;
      bestPenalty = penalty;
    }
  }
  return { version, size, ecc: level, mask: bestMask, modules: best };
}
