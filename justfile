# QR Transfer task runner. Settings are read from .env if present.
set dotenv-load := true

# List available recipes
default:
    @just --list

# Run locally over plain HTTP on 127.0.0.1 (browsers treat localhost as secure)
dev:
    QRT_ENFORCE_HTTPS=false QRT_HOST=127.0.0.1 node server/main.js

# Run with the configuration from the environment / .env
run:
    node server/main.js

# Create a self-signed TLS certificate for LAN use (cert.pem, key.pem)
cert host="localhost":
    openssl req -x509 -newkey rsa:2048 -nodes -days 30 \
        -keyout key.pem -out cert.pem -subj "/CN={{host}}" \
        -addext "subjectAltName=DNS:{{host}},DNS:localhost,IP:127.0.0.1"

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

# Remove local storage and build output
clean:
    rm -rf storage dist
    bash android/build.sh clean
