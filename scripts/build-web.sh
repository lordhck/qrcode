#!/usr/bin/env bash
# Builds the static website from web/ into public/.
#
# - copies web/ to public/
# - renames assets/ to assets-<version>/ and rewrites index.html, so browsers
#   and the GitHub Pages CDN never serve stale JS/CSS after a deploy
# - adds .nojekyll (serve files as-is) and version.txt
#
# Usage: scripts/build-web.sh [version]   (default: short git commit hash)
set -euo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly SRC="$ROOT/web"
readonly OUT="$ROOT/public"

version="${1:-$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || date -u +%Y%m%d%H%M%S)}"
[[ "$version" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "error: invalid version '$version'" >&2; exit 1; }

rm -rf "$OUT"
mkdir -p "$OUT"
cp -R "$SRC/." "$OUT/"
mv "$OUT/assets" "$OUT/assets-$version"

shopt -s nullglob
for page in "$OUT"/*.html; do
    sed -i.bak "s#\"assets/#\"assets-$version/#g" "$page"
    rm -f "$page.bak"
done

touch "$OUT/.nojekyll"
printf '%s\n' "$version" >"$OUT/version.txt"

echo "Built $OUT (assets-$version, $(find "$OUT" -type f | wc -l | tr -d ' ') files)"
