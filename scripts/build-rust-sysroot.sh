#!/bin/bash
set -euo pipefail

# build-rust-sysroot.sh — Assemble a writable Rust sysroot whose rust-src
# carries Kandelo's forked `libc` and (when present) the `std` overlay, so
# `-Z build-std` compiles `std` for `wasm32-unknown-kandelo`.
#
# WHY this shape: the dev-shell's Rust is a bare Nix toolchain (read-only
# /nix/store, no rustup). `-Z build-std` reads rust-src from
# `<sysroot>/lib/rustlib/src/rust/library`, and the sysroot cannot be
# overridden by a user-project `[patch.crates-io]` (proven: std resolves
# its `libc` in a separate crate graph). So we build a private sysroot
# that mirrors the real one via symlinks but replaces `rust-src` with a
# writable copy we patch, and select it with a `rustc` wrapper that
# injects `--sysroot` (rustc honors `--sysroot` for `--print sysroot`,
# which is how cargo locates rust-src).
#
# Outputs (under $HOME/.kandelo/rust, outside the repo — never committed):
#   sysroot/         the assembled sysroot
#   rustc-kandelo    the wrapper to use as $RUSTC
#
# Usage (inside scripts/dev-shell.sh):
#   scripts/build-rust-sysroot.sh
#   RUSTC=$HOME/.kandelo/rust/rustc-kandelo cargo build \
#     -Z json-target-spec -Z build-std=std,panic_abort \
#     --target sdk/rust/wasm32-unknown-kandelo-std.json

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# We do not vendor the libc crate. The upstream crate is the pinned
# rust-lang/libc submodule; our kandelo delta is a single patch. The fork
# is assembled at build time (submodule + patch), mirroring how
# build-musl.sh overlays libc/musl-overlay onto the libc/musl submodule.
LIBC_UPSTREAM="$REPO_ROOT/sdk/rust/libc-upstream"      # rust-lang/libc, pinned to the version std uses
LIBC_PATCH="$REPO_ROOT/sdk/rust/libc-kandelo.patch"    # kandelo delta only
STD_OVERLAY="$REPO_ROOT/sdk/rust/std-overlay"

OUT_DIR="${KANDELO_RUST_DIR:-$HOME/.kandelo/rust}"
MYSYS="$OUT_DIR/sysroot"
WRAP="$OUT_DIR/rustc-kandelo"
FORK_LIBC="$OUT_DIR/libc-kandelo"                       # assembled = upstream + patch (not committed)

command -v rustc >/dev/null || { echo "rustc not on PATH; run inside scripts/dev-shell.sh" >&2; exit 1; }
[ -f "$LIBC_UPSTREAM/Cargo.toml" ] || {
  echo "sdk/rust/libc-upstream not initialized; run: git submodule update --init $LIBC_UPSTREAM" >&2; exit 1; }
[ -f "$LIBC_PATCH" ] || { echo "missing libc overlay patch at $LIBC_PATCH" >&2; exit 1; }

REALSYS="$(rustc --print sysroot)"
REAL_RUSTC="$REALSYS/bin/rustc"
[ -x "$REAL_RUSTC" ] || { echo "no rustc at $REAL_RUSTC" >&2; exit 1; }

echo "==> Assembling forked libc = upstream + kandelo overlay -> $FORK_LIBC"
rm -rf "$FORK_LIBC"
cp -R "$LIBC_UPSTREAM" "$FORK_LIBC"
rm -rf "$FORK_LIBC/.git"
chmod -R u+w "$FORK_LIBC"
# git apply fails loudly if the patch no longer matches the pinned upstream
# (e.g. after a libc version bump) — the truthful signal to refresh the delta.
( cd "$FORK_LIBC" && git apply "$LIBC_PATCH" ) || {
  echo "libc overlay patch did not apply cleanly against $LIBC_UPSTREAM; refresh sdk/rust/libc-kandelo.patch for the pinned libc version" >&2
  exit 1
}

echo "==> Assembling sysroot at $MYSYS (from $REALSYS)"
rm -rf "$MYSYS"
mkdir -p "$MYSYS/lib/rustlib"
# Mirror every rustlib entry by symlink except `src`, which we copy writable.
for entry in "$REALSYS"/lib/rustlib/*; do
  name="$(basename "$entry")"
  [ "$name" = "src" ] && continue
  ln -s "$entry" "$MYSYS/lib/rustlib/$name"
done
cp -RL "$REALSYS/lib/rustlib/src" "$MYSYS/lib/rustlib/src"
chmod -R u+w "$MYSYS/lib/rustlib/src"

LIB_MANIFEST="$MYSYS/lib/rustlib/src/rust/library/Cargo.toml"
[ -f "$LIB_MANIFEST" ] || { echo "no library/Cargo.toml in rust-src" >&2; exit 1; }

echo "==> Pointing std's libc at the fork ($FORK_LIBC)"
# Insert `libc = { path = ... }` into the EXISTING [patch.crates-io]
# section (adding a second section is a duplicate-key error).
python3 - "$LIB_MANIFEST" "$FORK_LIBC" <<'PY'
import sys
manifest, fork = sys.argv[1], sys.argv[2]
lines = open(manifest).read().splitlines()
out, inserted, in_patch = [], False, False
for l in lines:
    if l.strip() == "libc = { path =" or l.strip().startswith("libc = { path ="):
        continue  # drop any prior injection so this is idempotent
    out.append(l)
    if l.strip() == "[patch.crates-io]":
        in_patch = True
        continue
    if in_patch and not inserted and l.strip().startswith("rustc-std-workspace-std"):
        out.append(f'libc = {{ path = "{fork}" }}')
        inserted = True
if not inserted:
    raise SystemExit("could not find [patch.crates-io] anchor in library/Cargo.toml")
open(manifest, "w").write("\n".join(out) + "\n")
print("   libc patch inserted")
PY

if [ -d "$STD_OVERLAY" ]; then
  echo "==> Applying std overlay from $STD_OVERLAY"
  # Overlay files are laid out mirroring library/ (e.g.
  # std/src/sys/pal/unix/...). Copy them over the writable rust-src.
  cp -R "$STD_OVERLAY"/. "$MYSYS/lib/rustlib/src/rust/library/"
else
  echo "==> No std overlay yet ($STD_OVERLAY absent) — skipping"
fi

echo "==> Writing rustc wrapper $WRAP"
mkdir -p "$OUT_DIR"
cat > "$WRAP" <<EOF
#!/bin/bash
# Auto-generated by scripts/build-rust-sysroot.sh. Selects the Kandelo
# private sysroot so -Z build-std uses the forked libc/std.
exec "$REAL_RUSTC" --sysroot "$MYSYS" "\$@"
EOF
chmod +x "$WRAP"

echo "==> Done."
echo "    RUSTC=$WRAP"
echo "    sysroot=$MYSYS ($( "$WRAP" --print sysroot ))"
