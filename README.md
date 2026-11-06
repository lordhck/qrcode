# QR Transfer

End-to-end encrypted file transfer where **animated QR codes are the transport**.

The sender encrypts a file in the browser and uploads only ciphertext. The
recipient opens the share link, and the page loops the encrypted data as QR
codes. The Android app scans them, reassembles, decrypts and verifies the file
locally. The receiving phone needs no network connection.

The server never sees the key: it lives in the URL fragment (`#k=...`), which
browsers never send to the server.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the protocol and threat model.

## Stack

| Part | Tech | Dependencies |
|---|---|---|
| Server | Node.js ≥ 20, built-in modules only | none |
| Web pages | HTML, CSS, vanilla JS (own QR encoder, WebCrypto) | none |
| Android | Kotlin, CameraX, ML Kit (bundled model) | built by GitHub Actions |

## Run the server

```bash
pkg install nodejs        # Termux; any Node ≥ 20 elsewhere
just dev                  # http://127.0.0.1:8000, HTTPS enforcement off
```

Without `just`:

```bash
QRT_ENFORCE_HTTPS=false QRT_HOST=127.0.0.1 node server/main.js
```

Production-style:

```bash
cp .env.example .env      # adjust
just run                  # = node server/main.js
```

### HTTPS

The browser's WebCrypto API only works over `https://` or on `localhost`.

- **Reverse proxy** (Caddy, nginx): set `QRT_HOST=127.0.0.1`, and set `QRT_TRUSTED_PROXIES` to the
  proxy's address so `X-Forwarded-Proto`/`-For` are honoured.
- **Built-in TLS**, e.g. on Termux over the LAN:
  ```bash
  just cert 192.168.1.20
  QRT_SSL_CERTFILE=cert.pem QRT_SSL_KEYFILE=key.pem just run
  ```

With `QRT_ENFORCE_HTTPS=true` (the default), plain-HTTP `GET`s are redirected to HTTPS
and everything else is rejected. `/healthz` is exempt.

## Configuration

Environment variables, see [`.env.example`](.env.example). Invalid values abort startup.

| Variable | Default | Meaning |
|---|---|---|
| `QRT_STORAGE_DIR` | `storage` | Blob and record directory |
| `QRT_MAX_SIZE` | `10485760` | Max ciphertext bytes per transfer |
| `QRT_MAX_STORAGE` | `1073741824` | Max bytes reserved by all live transfers |
| `QRT_DEFAULT_TTL` / `MIN_TTL` / `MAX_TTL` | `3600` / `60` / `86400` | Transfer lifetime (s) |
| `QRT_DEFAULT_FPS` / `MAX_FPS` | `10` / `15` | QR display speed |
| `QRT_CLEANUP_INTERVAL` | `60` | Seconds between expiry sweeps |
| `QRT_CREATE_RATE_LIMIT` | `20` | Creations per IP per minute (0 = off) |
| `QRT_ENFORCE_HTTPS` | `true` | Redirect/reject plain HTTP |
| `QRT_HOST` / `QRT_PORT` | `0.0.0.0` / `8000` | Bind address |
| `QRT_TRUSTED_PROXIES` | `127.0.0.1` | Comma-separated proxy IPs, or `*` |
| `QRT_SSL_CERTFILE` / `QRT_SSL_KEYFILE` | empty | Built-in TLS |

There is no access log. Transfer IDs in URL paths are capabilities and must not end
up in logs.

## API

All errors return `{"detail": "..."}`. Unknown, malformed and expired IDs all return
the same `404`.

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/transfers` | — | Create a session: `{size, meta, ttl_seconds?, fps?}` |
| `POST` | `/api/transfers/{id}/upload` | `Bearer <upload_token>` | Raw ciphertext body (`application/octet-stream`) |
| `GET` | `/api/transfers/{id}` | — | Session info |
| `GET` | `/api/transfers/{id}/blob` | — | Download the ciphertext |
| `DELETE` | `/api/transfers/{id}` | `Bearer <upload_token>` | Delete the transfer |
| `GET` | `/api/config` | — | Public limits and defaults |
| `GET` | `/healthz` | — | Liveness check |

- **Create:** `size` is the exact ciphertext length; `meta` is base64 of the encrypted
  metadata (28–1024 bytes). Returns `{id, upload_token, expires_at, max_size}`. The
  token is returned only once; the server stores only its SHA-256.
- **Upload:** `Content-Length` must equal `size`. The body is streamed to disk and the
  upload is aborted if it overflows. Uploads are one-shot; a failed upload can be retried.
- **Storage:** `storage/<id>/{meta.json,blob.bin}`. Files are written atomically and are
  private (`0600`/`0700`). A sweep at startup and every minute removes expired
  transfers and abandoned uploads.

## Using it

1. Open `/`, pick a file, choose the expiry and QR speed, then **Encrypt & upload**.
2. Share the link.
3. The recipient opens it. The page downloads the ciphertext, checks that it
   decrypts, and loops the QR frames. Speed, density and error correction can be
   changed live.

The transfer page removes the key from the address bar and history, and keeps it
in `sessionStorage` (that tab only) so a reload still works.

## Android app

`android/` is a Gradle project:

- **`core`**: pure Kotlin. Protocol decoder, reassembly with a disk-backed chunk
  store, AES-GCM/SHA-256 via `javax.crypto`, file-name sanitising.
- **`app`**: one Activity with CameraX and ML Kit (bundled model, no Google Play
  Services). It has **no INTERNET permission**. Flow: scan → map of missing
  chunks → decrypt → verify SHA-256 → save to `Downloads/QR Transfer`.

### Getting the APK

GitHub Actions (`.github/workflows/android.yml`) builds it on every push to `main`
that touches `android/`:

- **Phone:** download the `qr-transfer-apk` artifact from the run in the Actions tab.
- **Git:** `just fetch-apk` writes the latest build to `dist/qr-transfer-debug.apk`.
  The `apk` branch also holds `build.log` and `BUILD.txt`, including for failed builds.
- **Release:** push a `v*` tag to get the APK attached to a GitHub release.

It's a debug build: every CI run signs it with a fresh debug key. Uninstall the
old version before installing a new one.

To build locally instead: `just apk` (Linux or Termux; installs the Android SDK on
first run).

## Layout

```
server/      Node server: main.js, routes.js, http.js, transfers.js, storage.js, config.js
public/      pages, CSS, JS (qr.js encoder, crypto.js, protocol.js, display.js, upload.js)
android/     Gradle project: core (Kotlin, no Android deps) + app
docs/        ARCHITECTURE.md
```

## License

MIT
