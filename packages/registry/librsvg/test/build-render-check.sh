#!/usr/bin/env bash
#
# Build render-check.wasm against the librsvg package: resolve librsvg
# (and so its dependency closure) through the package resolver, link
# render-check.c with the SDK using librsvg-2.0.pc, then fork-instrument
# (glib uses fork) and stamp it like any installed program.
#
# Run inside scripts/dev-shell.sh. Usage: build-render-check.sh <out.wasm>

set -euo pipefail

OUT="${1:?usage: build-render-check.sh <out.wasm>}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
REGISTRY="$REPO_ROOT/packages/registry"
HOST_TRIPLE="$(rustc -vV | awk '/^host/ {print $2}')"

xtask() {
    (cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- "$@")
}

# The dependency closure, from each manifest's depends_on.
closure=()
queue=(librsvg)
while [ "${#queue[@]}" -gt 0 ]; do
    pkg="${queue[0]}"
    queue=("${queue[@]:1}")
    case " ${closure[*]-} " in *" $pkg "*) continue ;; esac
    closure+=("$pkg")
    while IFS= read -r dep; do
        queue+=("$dep")
    done < <(sed -n '/^depends_on/,/^\]/p' "$REGISTRY/$pkg/package.toml" \
        | grep -o '"[a-z0-9+_-]*@' | tr -d '"@')
done

# Resolving librsvg builds anything missing from the closure.
xtask build-deps resolve librsvg >/dev/null
pc_path=""
for pkg in "${closure[@]}"; do
    dir="$(xtask build-deps path "$pkg" | tail -1)/lib/pkgconfig"
    [ -d "$dir" ] && pc_path="$pc_path${pc_path:+:}$dir"
done

RAW="${OUT%.wasm}.raw.wasm"
# shellcheck disable=SC2046 # pkg-config output is a flag list
wasm32posix-cc -O2 "$SCRIPT_DIR/render-check.c" \
    $(PKG_CONFIG_PATH="$pc_path" wasm32posix-pkg-config --static --cflags --libs librsvg-2.0) \
    -o "$RAW"
bash "$REPO_ROOT/scripts/run-wasm-fork-instrument.sh" "$RAW" -o "$OUT"
rm -f "$RAW"
xtask stamp-abi-contract "$OUT" >/dev/null
echo "RSVG_RENDER_CHECK_BUILT"
