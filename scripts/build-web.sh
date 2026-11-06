#!/usr/bin/env bash
# Builds the static website from web/ into public/.
#
# - copies web/ to public/
# - renames assets/ to assets-<version>/ and rewrites index.html, so browsers
#   and the GitHub Pages CDN never serve stale JS/CSS after a deploy
# - optionally bundles the Android APK as public/qr-transfer.apk and shows the
#   download card (set QRT_APK=path, optionally QRT_APK_VERSION=x.y.z)
# - adds .nojekyll (serve files as-is) and version.txt
#
# Usage: [QRT_APK=app.apk QRT_APK_VERSION=0.2.0] scripts/build-web.sh [version]
#        (version defaults to the short git commit hash)
set -euo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly SRC="$ROOT/web"
readonly OUT="$ROOT/public"
readonly SAFE_RE='^[A-Za-z0-9._-]+$'

version="${1:-$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || date -u +%Y%m%d%H%M%S)}"
[[ "$version" =~ $SAFE_RE ]] || { echo "error: invalid version '$version'" >&2; exit 1; }

rm -rf "$OUT"
mkdir -p "$OUT"
cp -R "$SRC/." "$OUT/"
mv "$OUT/assets" "$OUT/assets-$version"

shopt -s nullglob
for page in "$OUT"/*.html; do
    sed -i.bak "s#\"assets/#\"assets-$version/#g" "$page"
    rm -f "$page.bak"
done

if [[ -n "${QRT_APK:-}" ]]; then
    [[ -f "$QRT_APK" ]] || { echo "error: QRT_APK not found: $QRT_APK" >&2; exit 1; }
    cp "$QRT_APK" "$OUT/qr-transfer.apk"
    bytes="$(wc -c <"$QRT_APK" | tr -d ' ')"
    label="$(awk -v b="$bytes" 'BEGIN { printf "%.0f MB", b / 1048576 }')"
    apk_version="${QRT_APK_VERSION:-}"
    if [[ -n "$apk_version" ]]; then
        [[ "$apk_version" =~ $SAFE_RE ]] || { echo "error: invalid APK version '$apk_version'" >&2; exit 1; }
        label="v$apk_version · $label"
    fi
    sed -i.bak \
        -e 's#<section id="app" class="card app" hidden>#<section id="app" class="card app">#' \
        -e "s#<span id=\"apkInfo\"></span>#<span id=\"apkInfo\">$label</span>#" \
        "$OUT/index.html"
    rm -f "$OUT/index.html.bak"
    echo "Bundled APK ($label)"
fi

touch "$OUT/.nojekyll"
printf '%s\n' "$version" >"$OUT/version.txt"

echo "Built $OUT (assets-$version, $(find "$OUT" -type f | wc -l | tr -d ' ') files)"
