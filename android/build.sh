#!/usr/bin/env bash
# Builds the QR Transfer Android app.
#
# Works on Linux x86_64 and in Termux on Android (aarch64). Installs the
# Android SDK command-line tools on first run (into $ANDROID_HOME, default
# ~/android-sdk), then builds the debug APK into ../dist/.
#
# Usage: ./build.sh [debug|clean]
set -euo pipefail

readonly HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly DIST="$HERE/../dist"
readonly CMDLINE_TOOLS_ZIP="commandlinetools-linux-11076708_latest.zip"
readonly CMDLINE_TOOLS_URL="https://dl.google.com/android/repository/$CMDLINE_TOOLS_ZIP"
readonly SDK_PACKAGES=("platforms;android-35" "build-tools;35.0.0")
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/android-sdk}}"

log() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
is_termux() { [[ -n "${TERMUX_VERSION:-}" || "${PREFIX:-}" == *com.termux* ]]; }

ensure_tools() {
    if is_termux; then
        local missing=()
        command -v java >/dev/null || missing+=(openjdk-17)
        command -v unzip >/dev/null || missing+=(unzip)
        command -v curl >/dev/null || missing+=(curl)
        if ((${#missing[@]})); then
            log "Installing Termux packages: ${missing[*]}"
            pkg install -y "${missing[@]}"
        fi
        if ! command -v aapt2 >/dev/null; then
            # Package naming has varied across Termux releases.
            log "Installing aapt2"
            pkg install -y aapt2 || pkg install -y aapt
            command -v aapt2 >/dev/null || die "aapt2 not found after install"
        fi
    else
        command -v java >/dev/null || die "java (JDK 17+) is required"
        command -v unzip >/dev/null || die "unzip is required"
        command -v curl >/dev/null || die "curl is required"
    fi
    local version
    version="$(java -version 2>&1 | sed -n 's/.*version "\([0-9]*\).*/\1/p' | head -1)"
    [[ -n "$version" && "$version" -ge 17 ]] || die "JDK 17 or newer required (found: ${version:-none})"
}

ensure_sdk() {
    local sdkmanager="$SDK/cmdline-tools/latest/bin/sdkmanager"
    if [[ ! -x "$sdkmanager" ]]; then
        log "Installing Android command-line tools into $SDK"
        local tmp
        tmp="$(mktemp -d)"
        trap 'rm -rf "$tmp"' RETURN
        curl -fL --retry 3 -o "$tmp/tools.zip" "$CMDLINE_TOOLS_URL"
        unzip -q "$tmp/tools.zip" -d "$tmp"
        mkdir -p "$SDK/cmdline-tools"
        rm -rf "$SDK/cmdline-tools/latest"
        mv "$tmp/cmdline-tools" "$SDK/cmdline-tools/latest"
    fi
    local missing=()
    for package in "${SDK_PACKAGES[@]}"; do
        [[ -d "$SDK/${package//;//}" ]] || missing+=("$package")
    done
    if ((${#missing[@]})); then
        log "Installing SDK packages: ${missing[*]}"
        yes | "$sdkmanager" --sdk_root="$SDK" --licenses >/dev/null || true
        "$sdkmanager" --sdk_root="$SDK" "${missing[@]}"
    fi
}

gradle() {
    export ANDROID_HOME="$SDK"
    printf 'sdk.dir=%s\n' "$SDK" >"$HERE/local.properties"
    local args=()
    # Google's aapt2 binary is x86_64-only; Termux ships a native build.
    if is_termux; then
        args+=("-Pandroid.aapt2FromMavenOverride=$(command -v aapt2)")
    fi
    (cd "$HERE" && ./gradlew "${args[@]}" "$@")
}

cmd_debug() {
    ensure_tools
    ensure_sdk
    log "Building the debug APK"
    gradle :app:assembleDebug
    local version
    version="$(sed -n 's/.*versionName = "\(.*\)".*/\1/p' "$HERE/app/build.gradle.kts")"
    mkdir -p "$DIST"
    local out="$DIST/qr-transfer-$version-debug.apk"
    cp "$HERE/app/build/outputs/apk/debug/app-debug.apk" "$out"
    log "APK: $out"
}

cmd_clean() {
    rm -rf "$HERE/build" "$HERE/app/build" "$HERE/core/build" "$HERE/.gradle" "$HERE/local.properties"
    log "Cleaned"
}

case "${1:-debug}" in
    debug) cmd_debug ;;
    clean) cmd_clean ;;
    *) die "usage: $0 [debug|clean]" ;;
esac
