# QR Transfer — Architecture Review & MVP Plan

Status: **approved and implemented (PoC).** This is the original design review. Where the
implementation changed course, the change is noted in place.

| Area | As built |
|---|---|
| Server | Node.js, built-in modules only (no npm packages). It was Python/Starlette first; FastAPI was dropped because `pydantic-core` won't build in Termux. |
| Web | Vanilla JS, own QR encoder, WebCrypto |
| Android | Kotlin, CameraX, ML Kit. The APK is built by GitHub Actions. |
| Deployment | Plain `node server/main.js`; no Docker (it can't run in Termux) |
| Tests | Dropped for the PoC, by decision |

---

## 1. Analysis of the proposed architecture

The overall shape is sound, but a few parts of the spec should change before any code exists.

### 1.1 What the system really is

The data path is:

```
Sender browser ──(ciphertext, HTTPS)──▶ Server ──(ciphertext, HTTPS)──▶ Recipient browser ──(QR, optical)──▶ Android app
```

The recipient's browser has already downloaded the ciphertext over the network. The QR hop only carries it the last metre, from that screen to the phone. That is a real, useful property: **the phone needs no network at all** (air-gapped, offline, or untrusted-network phones). The README should state this as the value proposition, so nobody expects AirDrop-level speed.

A side benefit of this design: a **local mode** (the sender's own browser encodes a local file straight to QR, with no upload) needs no extra protocol work. It is out of scope for the MVP but nearly free to add later.

### 1.2 Server responsibilities should shrink

The server **cannot** encrypt or decrypt (it has no key), and it gains nothing from building packets. So:

| Spec item | Proposal | Reason |
|---|---|---|
| `core/encryption.py` (server) | **Removed** | The server must never handle keys or plaintext. All crypto lives in JS and Kotlin. |
| `core/encoder.py`, `core/decoder.py` | **Removed** | Encoding lives in `public/js/protocol.js` (sender) and `android/core` (receiver). |
| `GET /api/transfers/{id}/packets` | **Replace with `GET /api/transfers/{id}/blob`** | The browser downloads the ciphertext once (≤ size limit) and builds the frames itself. Then the recipient can change QR density and speed live, and fountain encoding (V2) also runs in the browser. |
| `templates/` (Jinja) | **`static/` plain HTML** | Pages are static. Data comes from the JSON API. That drops Jinja2 as a dependency. |

The server becomes a **dumb, time-limited, encrypted blob store**. That is the smallest attack surface and the simplest code.

### 1.3 Runtime dependencies

- **Backend:** Node.js built-ins only (`http`, `https`, `fs`, `crypto`). No npm packages. Uploads arrive as a raw `application/octet-stream` body, not multipart.
- **Frontend:** zero npm packages. QR generation uses a project-owned encoder (`qr.js`, byte mode, versions 1–40). During development it was verified by scanning its output with OpenCV: byte-exact at full capacity for every ECC level across versions 1–40. Crypto uses WebCrypto (native).
- **Android:** CameraX and ML Kit barcode scanning (**bundled** model, so it works without Google Play Services). Crypto uses `javax.crypto` (native).

---

## 2. Technical limitations and bottlenecks

Ranked by impact.

### 2.1 Throughput is the hard ceiling (critical)

An optical channel is slow. Even with perfect scanning, realistic rates are **5–30 KB/s** (see §3). A 10 MB file takes roughly 6–30 minutes. **Size limits must reflect this:** proposed default **10 MiB**, configurable. The UI shows an estimated transfer time before the upload starts.

### 2.2 Missed frames with plain chunking (high)

There is no back channel from the phone to the screen, so the receiver can't ask for missing chunks. In a looping carousel, a missed chunk only comes back on the next loop. This is the coupon-collector problem:

- Passes needed ≈ `ln(N) / ln(1/p)`, where N = number of chunks and p = per-frame miss rate.
- N = 1000, p = 10 % → **~3 loops**. At p = 20 % → **~4.3 loops**.
- With fountain codes: ≈ `N·(1+ε)/(1−p)` frames → **~1.1–1.3 loops**.

**Conclusion:** chunking is fine for the MVP, but fountain codes are a 2–3× real-world speedup, not a nice-to-have. The MVP is designed so this upgrade needs no protocol break (§4.4).

### 2.3 Binary data through ML Kit (high, must be verified first)

QR byte mode can carry arbitrary bytes. But scanner APIs often run the payload through charset detection (`rawValue` is a String, which loses data). ML Kit's `Barcode.rawBytes` should return the exact payload bytes, but this **must be confirmed on real devices on day 1 of Phase 3**.

Fallback if it fails: **Base45 text in QR alphanumeric mode**. It is immune to charset issues and costs only ~3 % capacity (alphanumeric mode packs 5.5 bits per character, and Base45 maps 2 bytes to 3 characters). The receiver can detect which encoding a frame uses, so supporting both costs little.

### 2.4 Display/camera timing (medium)

- Camera preview runs at about 30 fps with rolling shutter. A frame swap during exposure produces a torn, undecodable image. **Each QR frame must stay on screen for at least 2 camera frames**, which caps the display at about 15 fps.
- The canvas must render at an **integer pixel-per-module** scale, with image smoothing off, a ≥ 4-module white quiet zone and no CSS scaling. Blurry module edges kill decoding of dense codes.
- Moiré and screen glare get worse with dense codes. That is why the error correction level and density are tunable (§3).

### 2.5 ML Kit on dense codes (medium)

ML Kit is reliable up to roughly QR version 25–30. Beyond that, decode rate falls on mid-range phones. The scanner is isolated in `FrameAnalyzer`, so `zxing-cpp` can be benchmarked against it in Phase 5 without touching the rest of the app.

### 2.6 Memory (low, given the size limit)

WebCrypto AES-GCM is one-shot only (no streaming), and Android's GCM also buffers the whole message. At ≤ 10–25 MiB this is fine. If much larger files are ever needed, switch to chunked AEAD (STREAM construction). That is out of scope now.

---

## 3. QR capacity and realistic scanning speed

### 3.1 Capacity per QR version (byte mode, bytes)

| Version | Modules | L | M | Q | H |
|---|---|---|---|---|---|
| 10 | 57×57 | 271 | 213 | 151 | 119 |
| 15 | 77×77 | 520 | 412 | 292 | 220 |
| 20 | 97×97 | 858 | 666 | 482 | 382 |
| 25 | 117×117 | 1273 | 997 | 715 | 535 |
| 30 | 137×137 | 1732 | 1370 | 982 | 742 |
| 40 | 177×177 | 2953 | 2331 | 1663 | 1273 |

Version 40 is theoretical for screen-to-camera use. The practical sweet spot is **version 20–28**.

On error correction: a screen is a clean, undamaged source, so **L or M** is right. Q and H spend capacity guarding against physical damage that doesn't happen here. Phase 5 benchmarks L vs M.

### 3.2 Throughput estimates (no frame loss)

| Payload/frame | fps | Rate | 1 MiB | 10 MiB |
|---|---|---|---|---|
| 800 B | 8 | 6.4 KB/s | 2.7 min | 27 min |
| 1000 B | 10 | 10 KB/s | 1.7 min | 17 min |
| 1500 B | 12 | 18 KB/s | 58 s | 9.7 min |
| 2000 B | 15 | 30 KB/s | 35 s | 5.8 min (optimistic) |

Multiply by the loop factor from §2.2 for the MVP carousel.

**MVP defaults:** about **1000 B payload, ECC M, 10 fps**. Both the sender's defaults and the recipient's page can adjust these.

---

## 4. Binary packet format (protocol v1)

All integers are **big-endian**. Every frame is self-contained: the receiver can start scanning at any point in the stream.

### 4.1 Frame layout

```
offset size  field
0      1     ver_type   high nibble = version (1), low nibble = frame type
1      4     stream_id  random u32, fresh per display session
5      4     index      DATA: chunk index | MANIFEST: 0 | REPAIR: encoding symbol id (≥ K)
9      4     total      K = number of source chunks
13     n     payload
13+n   4     crc32      CRC-32 (IEEE) over bytes [0, 13+n)
```

Overhead is **17 bytes per frame** (~1.7 % at 1000 B), compared with roughly 40 % for JSON + Base64.

Field notes:
- `stream_id` is random per display session and is **not** the server transfer ID, so the capability token never appears in the QR stream. If the recipient changes chunk size mid-way, a new `stream_id` starts, and the app resets cleanly instead of mixing incompatible chunks.
- `crc32` catches misdecodes and charset mangling, and makes foreign QR codes get rejected (2⁻³² false-accept rate). It is **not** a security control; GCM and SHA-256 cover integrity.
- The payload length is implied by the QR content length, so no length field is needed.

### 4.2 Frame types

| Type | Name | Purpose |
|---|---|---|
| 0x0 | DATA | Source chunk `index` of the ciphertext |
| 0x1 | MANIFEST | Everything the receiver needs to allocate, verify and decrypt |
| 0x2 | REPAIR | **Reserved for V2** fountain repair symbols |
| 0x3–0xF | — | Reserved |

The receiver ignores unknown versions and types, which keeps the protocol forward-compatible.

### 4.3 MANIFEST payload

```
1   flags          bit0 = password-protected (Phase 4), others reserved
2   chunk_size     u16, bytes per source chunk
4   ct_length      u32, total ciphertext length
32  ct_sha256      SHA-256 of the full ciphertext (transport check before decrypt)
32  key_material   file key (or K_frag when the password flag is set)
16  kdf_salt       present only if bit0
2   meta_len       u16
n   meta_blob      encrypted metadata (see §5.3)
```

This totals about 100–400 bytes, so it fits one frame. The manifest is **interleaved every 10th frame**, so a late-starting receiver gets it within a second.

### 4.4 Built-in V2 compatibility

- **The last chunk is zero-padded to `chunk_size`.** The true length comes from `ct_length`. This makes MVP DATA frames exactly the *source symbols* of a systematic fountain code.
- **V2 plan:** keep sending DATA frames 0…K−1 as today, then send an endless stream of REPAIR frames (ESI ≥ K). An MVP receiver still works, just less efficiently. A V2 receiver decodes from any ~K(1+ε) frames.
- **Candidates:**
  - **RaptorQ (RFC 6330):** ~0.2 % overhead, systematic, but needs WASM in the browser (`cberner/raptorq`) and a Java implementation on Android (OpenRQ, unmaintained).
  - **LT codes:** about 200 lines per side with no dependencies, but 5–15 % overhead at K ≈ 1000, and they need a bit-exact shared PRNG spec.
  - Phase 5 picks one based on measurements.

### 4.5 Receiver state

- A preallocated file of K × `chunk_size` bytes in app cache, plus a bitset.
- **Duplicates:** bit already set → drop (O(1)).
- **Missing chunks:** cleared bits. The UI shows `received/K`, the missing count and a mini map.
- **Recovery:** CRC failure → drop the frame and wait for the next loop. In V2, fountain codes take over.
- **Completion:** all bits set → truncate to `ct_length` → verify `ct_sha256` → decrypt → verify plaintext SHA-256 → save.

---

## 5. Encryption and key exchange

### 5.1 Threat model

| Adversary | Protected? |
|---|---|
| Server operator / compromised server / storage leak | **Yes.** It holds only ciphertext, never a key. |
| Network observer | **Yes.** HTTPS, plus the key only travels in the URL fragment. |
| Someone who learns the share URL | **No, by design.** The URL is the capability, same as any E2E share link. |
| Someone filming the recipient's screen | **MVP: no.** **Phase 4 with password: yes.** |

The last row needs an explicit decision. The phone has no channel except the camera, so the key must reach it either through the QR stream or through something the user types.

### 5.2 Key flow

**MVP (proposed):**
1. The sender's browser generates a 256-bit random `FK` (WebCrypto CSPRNG).
2. It encrypts the file and metadata with AES-256-GCM.
3. It uploads the ciphertext. The share URL is `https://host/t/{id}#k={base64url(FK)}`.
4. The fragment **is never sent to the server** by browsers.
5. The recipient's browser reads `FK` and decrypts the metadata to show the filename.
6. `FK` travels to the phone **inside the MANIFEST frame**.

**Phase 4, optional transfer password:**
- The URL fragment carries `K_frag` instead of `FK`.
- `FK = HMAC-SHA256(K_frag, PBKDF2-HMAC-SHA256(password, salt, 600 000 iterations))`.
- The phone prompts for the password. A screen observer now lacks the password, and the server lacks both secrets.
- PBKDF2 and HMAC are native in both WebCrypto and the JCE, so this adds no dependency.
- Known limitation: anyone holding `K_frag` + ciphertext can attack a weak password offline. The UI enforces a minimum length.

### 5.3 Cipher details

- **File:** `blob = nonce(12) ‖ AES-256-GCM(FK, nonce, plaintext, aad="qrt1-file") ‖ tag(16)`
- **Metadata:** `meta = nonce(12) ‖ AES-256-GCM(FK, nonce, json, aad="qrt1-meta") ‖ tag(16)`
  - The JSON contains: `{name, mime, size, sha256}`. `sha256` is the SHA-256 of the **plaintext**.
  - Filename and MIME type are encrypted, so the server knows only the ciphertext size and timestamps.
- One key encrypts two messages with independent random nonces and distinct AAD labels. That is safe, and it avoids implementing HKDF on Android.
- **Integrity has three layers**, each with its own failure message:
  - CRC32 per frame: transport.
  - `ct_sha256` after reassembly: "transfer corrupted".
  - GCM tag plus plaintext SHA-256 after decrypt: "wrong key or tampered". The SHA-256 check is spec-required and also covers the sender's original file.

### 5.4 Key hygiene

- **Strict CSP:** `default-src 'self'`, no inline scripts, no third-party origins, `Referrer-Policy: no-referrer`. No analytics.
- **Logs:** the key never reaches the server, so it can't be logged. Transfer IDs are capabilities too, so the server keeps no access log or paths are redacted.
- **Browser history:** the fragment can be stripped from the address bar with `history.replaceState` after reading. Trade-off: a page reload then loses the key. Proposed: strip it, and show a "keep this tab open" hint.
- **WebCrypto** only works in a secure context, which is a natural enforcement of HTTPS.

---

## 6. MVP architecture

### 6.1 API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/transfers` | — (rate-limited) | Create a session. Body: `{size, meta (b64, ≤ 1 KiB), ttl_seconds, fps}`. Response: `{id, upload_token, expires_at, max_size}` |
| POST | `/api/transfers/{id}/upload` | `Bearer upload_token` | Raw ciphertext body. Streamed to disk with a byte counter; the length must equal the declared `size`. One-shot (a second upload → 409). |
| GET | `/api/transfers/{id}` | capability ID | `{size, meta, fps, expires_at, ready}` |
| GET | `/api/transfers/{id}/blob` | capability ID | `application/octet-stream` ciphertext |
| DELETE | `/api/transfers/{id}` | `Bearer upload_token` | 204 |
| GET | `/`, `/t/{id}` | — | Static pages |

Rules:
- **IDs** are `secrets.token_urlsafe(16)` (128-bit). The upload token is a separate 256-bit secret; only its SHA-256 is stored, and it is compared in constant time.
- **Unknown, expired and deleted IDs** all return the same `404`, so callers can't probe which IDs once existed.
- **Size** is enforced three times: in the create body, at `Content-Length`, and with a streaming byte counter that aborts on overflow.
- **Expiry:** default TTL 1 h, maximum 24 h, configurable.

### 6.2 Storage and cleanup

- Layout: `storage/{id}/meta.json` and `storage/{id}/blob.bin`. No database.
- Writes go to a temp file and are atomically renamed on success.
- A cleanup task runs in the app lifespan every 60 s and also sweeps on startup. Deletes are idempotent, so this works even with multiple workers.
- Expiry is also checked on every read, so expired data is never served between sweeps.

### 6.3 Frontend (vanilla)

```
static/
├── index.html        upload page: file picker, TTL, speed, estimated time
├── transfer.html     QR display page
├── css/app.css
└── js/
    ├── api.js        REST client (XHR upload for progress)
    ├── crypto.js     WebCrypto AES-GCM, metadata, base64/base64url
    ├── protocol.js   frame/manifest builder, CRC32, frame schedule (mirrored by android/core Protocol.kt)
    ├── qr.js         QR encoder, cached function patterns per version
    ├── transport.js  density presets (chunk size) and time estimates
    ├── ui.js         DOM/format helpers
    ├── upload.js     sender page
    └── display.js    recipient page: rAF scheduler, next frame pre-encoded, integer-scaled canvas
```

The display page shows:
- a large centred QR,
- filename (decrypted locally) and size,
- the current frame as `i / K` plus loop count,
- live speed and density controls,
- expiry countdown and scanning instructions,
- a clear "expired / not available" state.

### 6.4 Android

```
android/core/   pure Kotlin: Protocol, QrPayload, Receiver, ChunkStore, Crypto, MiniJson, Finisher
android/app/    MainActivity
├── scan/       CameraX ImageAnalysis (KEEP_ONLY_LATEST, 1080p) → ML Kit (QR only) → QrPayload
├── receive/    ReceiveSession (single worker thread), Saver (MediaStore)
└── ui/         ChunkMapView (received/missing chunk map)
```

- **minSdk 29**, so the finished file goes straight into Downloads via MediaStore without storage permissions.
- Frame processing runs on a single worker thread, off the main and camera threads.

### 6.5 Deployment

Docker was dropped: the target host includes Termux on Android, where Docker cannot run.

- **Runtime:** `node server/main.js`. It needs no packages, so it runs the same on a Linux server and in Termux (`pkg install nodejs`).
- **Config:** environment variables with a `QRT_` prefix, optionally loaded from `.env` by the justfile. Invalid values abort startup.
- **HTTPS, two options:**
  - **Reverse proxy:** the proxy terminates TLS, and `X-Forwarded-Proto` is trusted only from `QRT_TRUSTED_PROXIES`.
  - **Built-in TLS:** set `QRT_SSL_CERTFILE` and `QRT_SSL_KEYFILE`. This suits Termux over the LAN; `just cert` makes a self-signed pair.
  - Either way, the app sends HSTS over HTTPS, redirects plain-HTTP `GET`s and rejects other plain-HTTP requests.
- **Process supervision:** systemd on servers, or `termux-services` on Android. Not part of the repo.
- **Task runner:** a `justfile` (`dev`, `run`, `cert`, `apk`, `fetch-apk`, `clean`).
- **Android build:** GitHub Actions (`.github/workflows/android.yml`) builds the APK, uploads it as an artifact and force-pushes it with the build log to the `apk` branch.

### 6.6 Project structure (as built)

```
qr-transfer/
├── server/
│   ├── main.js        bootstrap, HTTP/HTTPS server, cleanup timer
│   ├── routes.js      routing, pages, static files
│   ├── http.js        security headers, HTTPS enforcement, proxy trust, body reading, rate limiter
│   ├── transfers.js   transfer rules, validation, streaming upload
│   ├── storage.js     blob store, atomic writes, expiry sweep
│   └── config.js      QRT_* settings
├── public/            see §6.3
├── android/           core (Kotlin) + app (Android), build.sh for local builds
├── .github/workflows/android.yml
├── docs/ARCHITECTURE.md
├── .env.example
├── justfile
├── package.json       no dependencies
└── README.md
```

---

## 7. Development plan

The spec's encryption phase moves earlier. Building the display around plaintext and then retrofitting crypto is wasted work, and WebCrypto is only about 40 lines.

| Phase | Deliverable | Done when |
|---|---|---|
| **1. Backend** | Config, storage, create/upload/get/blob/delete, expiry + sweeper, size limits, security headers, justfile, optional built-in TLS | Done: `node server/main.js` runs on Linux and Termux |
| **2. Sender + display** | Client-side encryption (moved up from Phase 4), upload page, frame builder, animated QR page, speed/density controls | Done: verified in headless Chrome (encrypt → upload → QR display → scan → decrypt, byte-identical) |
| **3. Android** | **Day 1: ML Kit `rawBytes` spike on 2+ devices.** Then scanner, parser, receive session, decrypt, SHA-256, save | End-to-end transfer of a 1 MiB file on a real device, byte-identical |
| **4. Hardening** | Optional transfer password, fragment stripping, rate limiting, authorization/expiry test pass, threat-model review | Security tests green; a screen recording without the password cannot decrypt |
| **5. Optimisation** | Benchmark matrix (version × ECC × fps × device), optional `deflate-raw` compression before encryption, `zxing-cpp` comparison, fountain-code choice and V2 prototype | Documented benchmark table; chosen defaults; V2 decision recorded |

---

## 8. Decisions needing approval

1. **Key in the MANIFEST frame for the MVP.** The optical hop is trusted by physical proximity; an optional password comes in Phase 4.
2. **The server is a dumb blob store.** `/packets` becomes `/blob`, and the browser builds the frames.
3. **Server-side `encryption.py`, `encoder.py` and `decoder.py` are dropped.**
4. **Static HTML instead of Jinja templates.** Server dependencies: none (Node built-ins).
5. **Defaults:** 10 MiB max size, 1 h TTL (24 h max), ~1000 B payload, ECC M, 10 fps.
6. **Android:** minSdk 29, bundled ML Kit, MediaStore Downloads.
7. **Client-side encryption moves to Phase 2.**

### 6.7 Android implementation notes (Phase 3)

- **Two Gradle modules.** `core` is pure Kotlin: protocol, `Receiver`, `FileChunkStore`, `Crypto`, `MiniJson` and `Finisher`. It runs on any JVM. During development it decoded and decrypted real frames captured from the browser page, byte-identical. `app` holds the Android parts: camera, ML Kit, UI and MediaStore.
- **Binary-safe scanning without a spike.** §2.3's ML Kit risk is handled in code rather than by an up-front device test. `QrPayload` tries each reading of the scanner output, and the frame CRC-32 picks the correct one. A wrong reading can never produce an accepted frame.
- **Threading.** ML Kit result callbacks and the `Receiver` share one worker thread, so the receiver needs no locking. The UI gets throttled snapshots (≤ 10/s) with a received-chunk bitmap.
- **Privacy.** The Android manifest declares no `INTERNET` permission, and `allowBackup=false`. The chunk file in the app cache is deleted after completion or reset. Saving uses MediaStore and needs no storage permission.
- **Not yet verified on hardware:** camera scanning speed and ML Kit behaviour with dense codes.
