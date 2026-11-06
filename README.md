# QR Transfer

Send a file to your phone as **animated QR codes**. The web page encrypts the file in
the browser and plays it as a loop of QR frames. The Android app scans them,
reassembles, decrypts and verifies the file. Nothing is uploaded anywhere, and the
receiving phone needs no network connection.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the protocol and design.

## Stack

| Part | Tech | Dependencies |
|---|---|---|
| Website | Static HTML, CSS, vanilla JS (own QR encoder, WebCrypto) | none |
| Android | Kotlin, CameraX, ML Kit (bundled model) | Gradle / Google Maven |
| Hosting | GitHub Pages | — |
| Builds | GitHub Actions: `pages.yml` (website), `android.yml` (APK) | — |

## Website

Sources live in `web/`. `scripts/build-web.sh` builds the deployable site into
`public/`: it renames `assets/` to `assets-<commit>/` to bust caches, and adds
`.nojekyll` and `version.txt`.

```bash
just serve       # serve web/ on http://localhost:8000
just build-web   # build public/
```

WebCrypto only works on `https://` or `localhost`. GitHub Pages is HTTPS.

### Deploy to GitHub Pages

`.github/workflows/pages.yml` builds `public/` and deploys it on every push to
`main` that touches `web/`.

One-time setup: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
Pages on a private repository requires a paid GitHub plan; otherwise make the repo
public.

The site then lives at `https://lordhck.github.io/qrcode/`. All paths are relative, so it also
works under a custom domain.

### Using it

1. Open the site and pick a file (up to 25 MiB).
2. Press **Start transfer**. The page encrypts the file and loops the QR frames.
3. Scan with the Android app. Speed, density (bytes per frame) and error correction
   can be changed live. Changing density restarts the stream, and the app follows
   automatically.

Density presets (bytes per frame): Low 400, Standard 900, High 1400, Max 2000.
At Standard / M / 10 fps, 1 MiB takes about 2 minutes per pass.

## Android app

`android/` is a Gradle project:

- **`core`**: pure Kotlin. Protocol decoder, reassembly with a disk-backed chunk
  store, AES-GCM/SHA-256 via `javax.crypto`, file-name sanitising.
- **`app`**: one Activity with CameraX and ML Kit (bundled model, no Google Play
  Services). It has **no INTERNET permission**. Flow: scan → map of missing chunks →
  decrypt → verify SHA-256 → save to `Downloads/QR Transfer`.

### Getting the APK

The website offers the latest build at `qr-transfer.apk`, with a download button and
a QR code to scan with the phone's camera. After every successful Android build, the
Pages workflow picks up the new APK from the `apk` branch and redeploys the site.

Other ways:

`.github/workflows/android.yml` builds it on every push to `main` that touches
`android/`:

- **Phone:** download the `qr-transfer-apk` artifact from the run in the Actions tab.
- **Git:** `just fetch-apk` writes the latest build to `dist/qr-transfer-debug.apk`.
  The `apk` branch also holds `build.log` and `BUILD.txt`, including for failed builds.
- **Release:** push a `v*` tag to get the APK attached to a GitHub release.

It's a debug build: every CI run signs it with a fresh debug key. Uninstall the old
version before installing a new one.

To build locally instead: `just apk` (Linux or Termux; installs the Android SDK on
first run).

## Layout

```
web/         website sources: index.html, assets/css, assets/js
scripts/     build-web.sh
android/     Gradle project: core (Kotlin, no Android deps) + app
docs/        ARCHITECTURE.md
.github/     workflows: pages.yml, android.yml
```

## License

MIT
