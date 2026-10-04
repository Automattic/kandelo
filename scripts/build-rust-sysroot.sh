#!/bin/bash
set -euo pipefail

# build-rust-sysroot.sh — Assemble a writable Rust sysroot whose rust-src
# carries Kandelo's forked `libc` and (when present) the `std` overlay, then
# compile `std` for `wasm32-unknown-kandelo-std` into it once. With the
# prebuilt `std` installed under lib/rustlib/<target>/, the target behaves
# like any installed Rust target: `cargo build --target
# wasm32-unknown-kandelo-std` (or a build system that drives cargo/rustc,
# e.g. meson + cargo-c) needs no per-build `-Z build-std`.
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
#   sysroot/         the assembled sysroot, including
#                    lib/rustlib/wasm32-unknown-kandelo-std/{target.json,lib/}
#   rustc-kandelo    the wrapper to use as $RUSTC
#
# Usage (inside scripts/dev-shell.sh):
#   scripts/build-rust-sysroot.sh
#   RUSTC=$HOME/.kandelo/rust/rustc-kandelo RUST_LIBC_UNSTABLE_MUSL_V1_2_3=1 \
#     cargo build --target wasm32-unknown-kandelo-std

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

# One build per output directory at a time. WHY: callers run this
# concurrently (rust-std and rust-c-interop are separate Vitest files, and
# every checkout shares the default $HOME/.kandelo/rust), and a rebuild
# deletes and recreates the directories a peer is writing. A waiter re-reads
# the stamp after the lock and skips the build its peer just finished. An
# flock dies with its holder, so a killed build cannot wedge the next one.
if [ "${KANDELO_RUST_SYSROOT_LOCK:-}" != "$OUT_DIR" ]; then
  mkdir -p "$OUT_DIR"
  KANDELO_RUST_SYSROOT_LOCK="$OUT_DIR" exec python3 -c '
import fcntl, os, sys
lock = open(sys.argv[1], "w")
fcntl.flock(lock, fcntl.LOCK_EX)
os.set_inheritable(lock.fileno(), True)
os.execvp(sys.argv[2], sys.argv[2:])
' "$OUT_DIR/.lock" bash "$0" "$@"
fi

command -v rustc >/dev/null || { echo "rustc not on PATH; run inside scripts/dev-shell.sh" >&2; exit 1; }
[ -f "$LIBC_UPSTREAM/Cargo.toml" ] || {
  echo "sdk/rust/libc-upstream not initialized; run: git submodule update --init $LIBC_UPSTREAM" >&2; exit 1; }
[ -f "$LIBC_PATCH" ] || { echo "missing libc overlay patch at $LIBC_PATCH" >&2; exit 1; }

REALSYS="$(rustc --print sysroot)"
REAL_RUSTC="$REALSYS/bin/rustc"
[ -x "$REAL_RUSTC" ] || { echo "no rustc at $REAL_RUSTC" >&2; exit 1; }

# Skip the rebuild when nothing that shapes the output changed: this
# script, the target spec, the libc submodule commit and patch, the std
# overlay, and the toolchain. Callers can then run this before every
# build and never use a stale sysroot.
STAMP="$OUT_DIR/.inputs-sha256"
input_digest() {
  {
    cat "$0" "$LIBC_PATCH" "$REPO_ROOT/sdk/rust/wasm32-unknown-kandelo-std.json"
    git -C "$LIBC_UPSTREAM" rev-parse HEAD
    git -C "$LIBC_UPSTREAM" diff HEAD
    if [ -d "$STD_OVERLAY" ]; then
      (cd "$STD_OVERLAY" && find . -type f | LC_ALL=C sort | while read -r f; do
        echo "$f"; cat "$f"; done)
    fi
    "$REAL_RUSTC" -vV
    echo "$REALSYS"
  } | shasum -a 256 | cut -d' ' -f1
}
DIGEST="$(input_digest)"
if [ -x "$WRAP" ] && [ -d "$MYSYS/lib/rustlib/wasm32-unknown-kandelo-std/lib" ] \
    && [ "$(cat "$STAMP" 2>/dev/null)" = "$DIGEST" ]; then
  echo "==> Rust sysroot at $OUT_DIR is up to date"
  exit 0
fi
rm -f "$STAMP"

echo "==> Assembling forked libc = upstream + kandelo overlay -> $FORK_LIBC"
mkdir -p "$OUT_DIR"
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
# private sysroot (forked libc/std, prebuilt std for the Kandelo target).
# -Zunstable-options: rustc only resolves a custom target by name from
# <sysroot>/lib/rustlib/<target>/target.json with it.
exec "$REAL_RUSTC" --sysroot "$MYSYS" -Zunstable-options "\$@"
EOF
chmod +x "$WRAP"

# Install the target spec where rustc finds it by name, then build std for
# it once. std is compiled with the target selected BY NAME: rlibs record
# their target identity, and an rlib built against the JSON path does not
# load into a by-name build (E0461).
TARGET="wasm32-unknown-kandelo-std"
TARGET_DIR="$MYSYS/lib/rustlib/$TARGET"
mkdir -p "$TARGET_DIR/lib"
cp "$REPO_ROOT/sdk/rust/$TARGET.json" "$TARGET_DIR/target.json"

echo "==> Building std for $TARGET into the sysroot"
STD_BUILD="$OUT_DIR/std-build"
rm -rf "$STD_BUILD"
mkdir -p "$STD_BUILD/src"
cat > "$STD_BUILD/Cargo.toml" <<'TOML'
[package]
name = "kandelo-std-build"
version = "0.0.0"
edition = "2021"
publish = false

[profile.release]
panic = "abort"

[workspace]
TOML
: > "$STD_BUILD/src/lib.rs"
(
  cd "$STD_BUILD"
  # WHY CARGO_TARGET_DIR: the package resolver exports its own
  # CARGO_TARGET_DIR to every recipe, and cargo would then write std there
  # instead of under $STD_BUILD, where the copy below reads it.
  CARGO_TARGET_DIR="$STD_BUILD/target" \
  RUSTC="$WRAP" RUST_LIBC_UNSTABLE_MUSL_V1_2_3=1 \
    cargo build --release --quiet \
      -Z build-std=std,panic_abort \
      --target "$TARGET"
)
cp "$STD_BUILD/target/$TARGET/release/deps/"*.rlib "$TARGET_DIR/lib/"
rm -f "$TARGET_DIR/lib/"libkandelo_std_build-*.rlib
rm -rf "$STD_BUILD"

echo "$DIGEST" > "$STAMP"
echo "==> Done."
echo "    RUSTC=$WRAP"
echo "    sysroot=$MYSYS ($( "$WRAP" --print sysroot ))"
echo "    target=$TARGET (prebuilt std: $(ls "$TARGET_DIR/lib" | wc -l | tr -d ' ') rlibs)"
