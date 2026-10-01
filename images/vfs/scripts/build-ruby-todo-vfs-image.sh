#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

# Reproducible product-manifest mode (staged inputs), mirroring the other
# product builders.
if [ "$#" -ne 0 ] && [ "${1:-}" = "--vfs-product-manifest" ]; then
  exec node "$REPO_ROOT/node_modules/tsx/dist/cli.mjs" \
    "$SCRIPT_DIR/staged-product-inputs.ts" browser-ruby-todo "$@"
fi

echo "==> Building Ruby todo VFS image..."

# Under the local-build engine the declared output must land in the package
# work dir (then install_local_binary places it in WASM_POSIX_DEP_OUT_DIR and
# the local mirror). Standalone invocations write straight into public/.
VFS_DIR="$REPO_ROOT/apps/browser-demos/public"
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
  : "${WASM_POSIX_DEP_WORK_DIR:?resolver VFS builds require WASM_POSIX_DEP_WORK_DIR}"
  VFS_DIR="$WASM_POSIX_DEP_WORK_DIR"
fi
VFS="$VFS_DIR/ruby-todo-vfs.vfs.zst"

work_tmpdir="$(mktemp -d /tmp/kandelo-ruby-todo-vfs.XXXXXX)"
trap 'rm -rf "$work_tmpdir"' EXIT

# Resolve and extract the Ruby runtime (standard library + gem scripts). It is
# laid out with a top-level usr/ directory. Under the engine the ruby package
# outputs are staged into WASM_POSIX_DEP_RUBY_DIR; prefer that so the build never
# re-enters the (policy-scoped) binary resolver. Fall back to the resolver for
# standalone/manual invocations.
if [ -n "${WASM_POSIX_DEP_RUBY_DIR:-}" ] && [ -f "$WASM_POSIX_DEP_RUBY_DIR/ruby-runtime.zip" ]; then
  RUNTIME_ZIP="$WASM_POSIX_DEP_RUBY_DIR/ruby-runtime.zip"
else
  RUNTIME_ZIP="$("$REPO_ROOT/scripts/resolve-binary.sh" programs/ruby/ruby-runtime.zip)"
fi
echo "==> Ruby runtime: $RUNTIME_ZIP"
mkdir -p "$work_tmpdir/runtime"
unzip -oq "$RUNTIME_ZIP" -d "$work_tmpdir/runtime"

RUBY_RUNTIME_DIR="$work_tmpdir/runtime" TMPDIR="$work_tmpdir" \
  npx tsx "$SCRIPT_DIR/build-ruby-todo-vfs-image.ts" "$VFS"

echo "==> Done."
ls -lh "$VFS"

# Mirror into local-binaries/ so the @binaries/ Vite alias and optional-binary
# resolver find the image. See build-nginx-php-vfs-image.sh for rationale.
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
  export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
  export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled
fi
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary ruby-todo-vfs "$VFS_DIR/ruby-todo-vfs.vfs.zst"
