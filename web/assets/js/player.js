// QR playback: renders a looping sequence of protocol frames on a canvas.

import { randomBytes } from "./crypto.js";
import { FrameSource, framesPerLoop } from "./protocol.js";
import { encodeBytes } from "./qr.js";
import { chunkSizeFor, DEFAULT_DENSITY, DEFAULT_ECC } from "./transport.js";

const QUIET_ZONE = 4; // modules, required by the QR standard

export class Renderer {
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

export class Player {
  /**
   * @param {{ciphertext: Uint8Array, ctSha256: Uint8Array, key: Uint8Array, meta: Uint8Array,
   *          renderer: Renderer, onFrame: Function, fps?: number}} options
   */
  constructor({ ciphertext, ctSha256, key, meta, renderer, onFrame, fps = 10 }) {
    this.base = { ciphertext, ctSha256, key, meta };
    this.renderer = renderer;
    this.onFrame = onFrame;
    this.fps = fps;
    this.ecc = DEFAULT_ECC;
    this.densityId = DEFAULT_DENSITY;
    this.running = false;
    this.position = 0;
    this.raf = 0;
    this.nextAt = 0;
    this.rebuild();
  }

  /** New stream: new stream id, chunking and QR version. The app resets on its own. */
  rebuild() {
    const chunkSize = chunkSizeFor(this.densityId, this.ecc, this.base.ciphertext.length);
    const streamId = new DataView(randomBytes(4).buffer).getUint32(0);
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

  setFps(fps) {
    this.fps = fps;
  }

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
