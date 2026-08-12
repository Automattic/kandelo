#!/usr/bin/env bash
# Focused contract tests for isolated exact-source staging toolchains.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
HELPER="$REPO_ROOT/scripts/abi-staging-build-toolchain.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() {
  echo "test-abi-staging-build-toolchain.sh: $*" >&2
  exit 1
}

[ -x "$HELPER" ] || fail "exact toolchain builder is absent"

MUSL_ORIGIN="$TMP_ROOT/musl-origin"
mkdir -p "$MUSL_ORIGIN"
git -C "$MUSL_ORIGIN" init -q
printf 'exact musl source\n' >"$MUSL_ORIGIN/EXACT-MUSL"
git -C "$MUSL_ORIGIN" add .
git -C "$MUSL_ORIGIN" -c user.name=Fixture -c user.email=fixture.invalid \
  commit -qm 'musl fixture'

SOURCE="$TMP_ROOT/source"
mkdir -p \
  "$SOURCE/libc/musl-overlay" \
  "$SOURCE/libc/glue" \
  "$SOURCE/scripts"
git -C "$SOURCE" init -q
git -C "$SOURCE" -c protocol.file.allow=always submodule add -q \
  "$MUSL_ORIGIN" libc/musl
printf 'exact overlay\n' >"$SOURCE/libc/musl-overlay/EXACT-OVERLAY"
printf 'exact glue\n' >"$SOURCE/libc/glue/EXACT-GLUE"
for script in \
  build-musl.sh \
  install-overlay-headers.sh \
  build-dri-stubs.sh \
  build-gles-stubs.sh \
  write-graphics-pkgconfig.sh; do
  printf '#!/usr/bin/env bash\n# exact %s\n' "$script" >"$SOURCE/scripts/$script"
  chmod 0755 "$SOURCE/scripts/$script"
done
git -C "$SOURCE" add .
git -C "$SOURCE" -c user.name=Fixture -c user.email=fixture.invalid \
  commit -qm 'toolchain source fixture'

FAKE_MUSL_BUILDER="$TMP_ROOT/fake-musl-builder"
cat >"$FAKE_MUSL_BUILDER" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
build_root="$1"
arch="$2"
[ "$(cat "$build_root/libc/musl/EXACT-MUSL")" = "exact musl source" ]
[ "$(cat "$build_root/libc/musl-overlay/EXACT-OVERLAY")" = "exact overlay" ]
[ "$(cat "$build_root/libc/glue/EXACT-GLUE")" = "exact glue" ]
[ ! -e "$build_root/AMBIENT-UNTRACKED" ]
if [ -n "${FAKE_TOOLCHAIN_STARTED_MARKER:-}" ]; then
  printf '%s\n' "$arch" >>"$FAKE_TOOLCHAIN_STARTED_MARKER"
fi
case "$arch" in
  wasm32posix)
    sysroot="$build_root/sysroot"
    mkdir -p "$sysroot/include/bits" "$sysroot/lib"
    : >"$sysroot/include/bits/ioctl_fix.h"
    printf 'wasm32 libc\n' >"$sysroot/lib/libc.a"
    ;;
  wasm64posix)
    sysroot="$build_root/sysroot64"
    mkdir -p "$sysroot/lib"
    printf 'wasm64 libc\n' >"$sysroot/lib/libc.a"
    ;;
  *) exit 72 ;;
esac
if [ "${FAKE_TOOLCHAIN_SYMLINK:-0}" = 1 ] && [ "$arch" = wasm64posix ]; then
  ln -s libc.a "$sysroot/lib/substitute.a"
fi
EOF
chmod 0755 "$FAKE_MUSL_BUILDER"

RESOURCE_ROOT="$TMP_ROOT/clang-resource"
mkdir -p "$RESOURCE_ROOT/include"
printf 'exact clang stddef\n' >"$RESOURCE_ROOT/include/stddef.h"
FAKE_LLVM_BIN="$TMP_ROOT/llvm-bin"
mkdir -p "$FAKE_LLVM_BIN"
cat >"$FAKE_LLVM_BIN/clang" <<EOF
#!/usr/bin/env bash
set -euo pipefail
[ "\${1:-}" = -print-resource-dir ] || exit 73
printf '%s\\n' '$RESOURCE_ROOT'
EOF
chmod 0755 "$FAKE_LLVM_BIN/clang"

run_helper() {
  local out="$1"
  env \
    KANDELO_ABI_STAGING_TESTING=1 \
    KANDELO_ABI_STAGING_MUSL_BUILDER="$FAKE_MUSL_BUILDER" \
    LLVM_BIN="$FAKE_LLVM_BIN" \
    "$HELPER" --source-root "$SOURCE" --out "$out"
}

OUT="$TMP_ROOT/out"
FAKE_TOOLCHAIN_STARTED_MARKER="$TMP_ROOT/started" run_helper "$OUT"
[ "$(cat "$TMP_ROOT/started")" = $'wasm32posix\nwasm64posix' ] ||
  fail "toolchain builder did not build both architectures exactly once"
[ "$(cat "$OUT/wasm32-sysroot/lib/libc.a")" = "wasm32 libc" ] ||
  fail "wasm32 sysroot was not staged"
[ -f "$OUT/wasm32-sysroot/include/bits/ioctl_fix.h" ] ||
  fail "intentional empty musl header was not staged"
[ "$(cat "$OUT/wasm64-sysroot/lib/libc.a")" = "wasm64 libc" ] ||
  fail "wasm64 sysroot was not staged"
[ "$(cat "$OUT/clang-resource-headers/include/stddef.h")" = \
  "exact clang stddef" ] || fail "Clang resource headers were not staged"
[ -z "$(find "$OUT" -type l -print -quit)" ] ||
  fail "toolchain output retained a symbolic link"
[ -z "$(git -C "$SOURCE" status --porcelain=v1 --untracked-files=all)" ] ||
  fail "toolchain build mutated the exact source checkout"
[ ! -e "$SOURCE/sysroot" ] && [ ! -e "$SOURCE/sysroot64" ] ||
  fail "toolchain build wrote into the exact source checkout"

if run_helper "$OUT" >"$TMP_ROOT/existing.out" 2>&1; then
  fail "toolchain builder accepted an existing output"
fi
grep -F 'output must be new' "$TMP_ROOT/existing.out" >/dev/null ||
  fail "existing-output rejection was not explicit"

printf 'ambient\n' >"$SOURCE/AMBIENT-UNTRACKED"
if FAKE_TOOLCHAIN_STARTED_MARKER="$TMP_ROOT/untracked.started" \
    run_helper "$TMP_ROOT/untracked" >"$TMP_ROOT/untracked.out" 2>&1; then
  fail "toolchain builder accepted an untracked source input"
fi
[ ! -e "$TMP_ROOT/untracked.started" ] ||
  fail "toolchain builder ran before rejecting the untracked source"
grep -F 'untracked' "$TMP_ROOT/untracked.out" >/dev/null ||
  fail "untracked-source rejection was not explicit"
rm "$SOURCE/AMBIENT-UNTRACKED"

if FAKE_TOOLCHAIN_SYMLINK=1 run_helper "$TMP_ROOT/symlink" \
    >"$TMP_ROOT/symlink.out" 2>&1; then
  fail "toolchain builder accepted a symlinked output"
fi
grep -F 'symbolic link' "$TMP_ROOT/symlink.out" >/dev/null ||
  fail "symlink rejection was not explicit"

if GITHUB_ACTIONS=true run_helper "$TMP_ROOT/github-test-seam" \
    >"$TMP_ROOT/github-test-seam.out" 2>&1; then
  fail "toolchain builder accepted its local replacement in GitHub Actions"
fi
grep -F 'local-test-only' "$TMP_ROOT/github-test-seam.out" >/dev/null ||
  fail "GitHub test-seam rejection was not explicit"

echo "ABI staging exact toolchain build: PASS"
