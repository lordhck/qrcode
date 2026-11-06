# QR Transfer task runner.

# List available recipes
default:
    @just --list

# Build the static website from web/ into public/
build-web:
    bash scripts/build-web.sh

# Serve web/ locally (localhost counts as a secure context for WebCrypto)
serve port="8000":
    @echo "http://localhost:{{port}}"
    cd web && python3 -m http.server {{port}} --bind 127.0.0.1

# Build the Android APK locally (Linux or Termux; normally GitHub Actions does this)
apk:
    bash android/build.sh debug

# Fetch the latest APK built by GitHub Actions into dist/
fetch-apk:
    mkdir -p dist
    git fetch -q origin apk
    git show origin/apk:BUILD.txt
    git show origin/apk:qr-transfer-debug.apk > dist/qr-transfer-debug.apk
    @echo "dist/qr-transfer-debug.apk"

# Remove build output
clean:
    rm -rf public dist
    bash android/build.sh clean
