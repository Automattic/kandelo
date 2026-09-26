#!/usr/bin/env bash
# Run FFmpeg's FATE groups with every target program executed by Kandelo
# (design §8, Tier 3). Configures and builds its own FFmpeg tree with the
# package's exact configure flags plus --target-exec, so FATE tests the
# same FFmpeg the package ships.
#
#   FATE_OUT=<dir> KANDELO_FATE_SAMPLES=<dir> run-fate.sh
#
# Writes $FATE_OUT/fate-report.json: {groups, run, failed[]}; exits non-zero
# if any test failed.
set -euo pipefail
exec < /dev/null

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../../../.." && pwd)"
PKG="$REPO_ROOT/packages/registry/ffmpeg"
SAMPLES="${KANDELO_FATE_SAMPLES:-$HOME/.cache/kandelo/fate-suite}"
FATE_OUT="${FATE_OUT:-$(mktemp -d "${TMPDIR:-/tmp}/kandelo-fate.XXXXXX")}"
WORK="$FATE_OUT/build"
mkdir -p "$WORK"

cd "$REPO_ROOT"
# shellcheck source=/dev/null
source sdk/activate.sh
export WASM_POSIX_SYSROOT="$REPO_ROOT/sysroot"
HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
xt() { cargo run -p xtask --target "$HOST_TARGET" --quiet -- "$@" 2>/dev/null | tail -1; }
ZLIB_PREFIX="$(xt build-deps resolve zlib)"
LIBICONV_PREFIX="$(xt build-deps resolve libiconv)"
LIBXML2_PREFIX="$(xt build-deps resolve libxml2)"
SDL2_PREFIX="$(xt build-deps resolve sdl2)"
export ZLIB_PREFIX LIBICONV_PREFIX LIBXML2_PREFIX SDL2_PREFIX

URL="$(awk -F'"' '/^url *=/{print $2; exit}' "$PKG/package.toml")"
SHA="$(awk -F'"' '/^sha256 *=/{print $2; exit}' "$PKG/package.toml")"
TARBALL="$HOME/.cache/kandelo/ffmpeg-src/$(basename "$URL")"
mkdir -p "$(dirname "$TARBALL")"
[ -f "$TARBALL" ] || curl -fsSL "$URL" -o "$TARBALL"
echo "$SHA  $TARBALL" | shasum -a 256 -c -
tar xJf "$TARBALL" -C "$WORK" --strip-components=1

# shellcheck source=/dev/null
source "$PKG/configure-flags.sh"
ffmpeg_configure_env
ffmpeg_configure_flags target
cd "$WORK"
./configure "${FFMPEG_CONFIGURE_FLAGS[@]}" \
    --target-exec="$HERE/kandelo-target-exec.sh" --samples="$SAMPLES"
bash "$PKG/audit-configure.sh" config "$WORK" "$WASM_POSIX_SYSROOT"
make -j"$(getconf _NPROCESSORS_ONLN)"

mapfile -t FATE_GROUPS < <(grep -v '^[[:space:]]*$' "$HERE/groups.txt")
[ -d "$SAMPLES" ] || make fate-rsync SAMPLES="$SAMPLES"
( cd "$SAMPLES" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256 ) \
    > "$FATE_OUT/fate-samples.sha256"

set +e
make -k "${FATE_GROUPS[@]}" SAMPLES="$SAMPLES" 2>&1 | tee "$FATE_OUT/fate.log"
set -e

run=$(grep -c '^TEST ' "$FATE_OUT/fate.log" || true)
node -e '
  const fs = require("fs");
  const [log, report, run, ...groups] = process.argv.slice(1);
  const text = fs.readFileSync(log, "utf8");
  const failed = [...new Set([...text.matchAll(/\[[^\]]*?(fate-[\w.-]+)\] Error/g)].map((m) => m[1]))].sort();
  fs.writeFileSync(report, JSON.stringify({ groups, run: Number(run), failed }, null, 2) + "\n");
  console.log(`FATE: ${run} run, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
' "$FATE_OUT/fate.log" "$FATE_OUT/fate-report.json" "$run" "${FATE_GROUPS[@]}"
