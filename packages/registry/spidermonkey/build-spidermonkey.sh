#!/usr/bin/env bash
# Build Mozilla SpiderMonkey's JS shell for the Kandelo wasm32 POSIX target.
#
# It produces `js.wasm` plus `node.wasm`, a Node-compatible shell entry point
# that runs the Kandelo CommonJS bootstrap when invoked as node.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$SCRIPT_DIR"
# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"
# shellcheck source=/dev/null

VERSION="$WASM_POSIX_DEP_VERSION"
SOURCE_URL="$WASM_POSIX_DEP_SOURCE_URL"
SOURCE_SHA256="$WASM_POSIX_DEP_SOURCE_SHA256"
ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"

if [ "$ARCH" != "wasm32" ]; then
    echo "ERROR: SpiderMonkey package currently supports wasm32 only, got '$ARCH'." >&2
    exit 1
fi

# Validate declared core verification inputs and bundle freshness before
# downloading/staging sources or compiling. Never regenerate checkout inputs.
python3 "$REPO_ROOT/third_party/node-core/check-build-inputs.py" --quiet
python3 "$REPO_ROOT/third_party/node-core/build.py" --check

RESOLVER_BUILD=0
if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ]; then
    RESOLVER_BUILD=1
fi
SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ]; then
    WORK_DIR="$WASM_POSIX_DEP_WORK_DIR"
    BIN_DIR="$WORK_DIR/bin"
    DOWNLOAD_DIR="$WORK_DIR/downloads"
    SRC_PARENT="$WORK_DIR/source"
    OBJ_DIR="$WORK_DIR/obj-wasm32"
    MOZCONFIG_PATH="$WORK_DIR/mozconfig-wasm32"
    MOZBUILD_STATE_PATH="$WORK_DIR/.mozbuild"
else
    BIN_DIR="$SCRIPT_DIR/bin"
    DOWNLOAD_DIR="$SCRIPT_DIR/downloads"
    SRC_PARENT="$SCRIPT_DIR/source"
    OBJ_DIR="$SCRIPT_DIR/obj-wasm32"
    MOZCONFIG_PATH="$SCRIPT_DIR/mozconfig-wasm32"
    MOZBUILD_STATE_PATH="$SCRIPT_DIR/.mozbuild"
fi
WORK_DIR="${WORK_DIR:-$SCRIPT_DIR}"
SRC_DIR="$WORK_DIR/spidermonkey-source"
if [ -n "${SPIDERMONKEY_SRC_DIR:-}" ] && [ -z "${WASM_POSIX_DEP_SOURCE_DIR:-}" ]; then
    WASM_POSIX_DEP_SOURCE_DIR="$SPIDERMONKEY_SRC_DIR"
fi
kandelo_package_stage_primary_source spidermonkey "$SRC_DIR" "$WORK_DIR"
if [ ! -f "$SRC_DIR/mach" ]; then
    echo "ERROR: verified SpiderMonkey source has no mach entry point: $SRC_DIR" >&2
    exit 2
fi
HOST_OS="$(uname -s)"
MACOS_SDK_DIR="${WASM_POSIX_MACOS_SDK_DIR:-}"

if [ "$HOST_OS" = "Darwin" ] && [ -z "$MACOS_SDK_DIR" ]; then
    # Take the macOS SDK the dev shell declares for this build (`macosSdk` in
    # flake.nix). SpiderMonkey's configure refuses any macOS SDK older than
    # 15.5, and this nixpkgs pins the shell's default Darwin SDK at 14.4, so
    # the flake declares a 15.5 one for SpiderMonkey alone.
    #
    # This used to prefer /Applications/Xcode.app instead, which is the only
    # place in the package tree that left the Nix world. That made the build
    # depend on which Xcode the machine had and on its licence having been
    # accepted, and it broke outright when Xcode 27 shipped a libSystem.tbd
    # the pinned LLVM's ld64.lld cannot parse -- see the host-link preflight
    # further down, which now names that failure instead of letting it appear
    # as a wall of undefined libc symbols.
    MACOS_SDK_DIR="${KANDELO_MACOS_SDK_DIR:-}"
    if [ -n "$MACOS_SDK_DIR" ]; then
        export SDKROOT="$MACOS_SDK_DIR"
        if [ -n "${KANDELO_MACOS_DEVELOPER_DIR:-}" ]; then
            export DEVELOPER_DIR="$KANDELO_MACOS_DEVELOPER_DIR"
        fi
    elif command -v xcrun >/dev/null 2>&1; then
        # Outside the dev shell, fall back to whatever xcrun resolves.
        MACOS_SDK_DIR="$(xcrun --sdk macosx --show-sdk-path 2>/dev/null || true)"
    fi
fi

if [ -n "$MACOS_SDK_DIR" ] && [ ! -d "$MACOS_SDK_DIR" ]; then
    echo "ERROR: macOS SDK not found at $MACOS_SDK_DIR." >&2
    exit 1
fi

if [ ! -f "$SYSROOT/lib/libc.a" ]; then
    echo "ERROR: sysroot not found at $SYSROOT. Run 'bash build.sh' first." >&2
    exit 1
fi

for required_tool in python3 rustc cargo cbindgen node curl make; do
    if ! command -v "$required_tool" >/dev/null 2>&1; then
        echo "ERROR: required host tool '$required_tool' not found in PATH." >&2
        exit 1
    fi
done

HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
resolve_dep() {
    local name="$1"
    (cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TARGET" --quiet -- build-deps resolve "$name")
}

LIBCXX_PREFIX="${WASM_POSIX_DEP_LIBCXX_DIR:-}"
if [ -z "$LIBCXX_PREFIX" ]; then
    echo "==> Resolving libcxx via cargo xtask build-deps..."
    LIBCXX_PREFIX="$(resolve_dep libcxx)"
fi
[ -f "$LIBCXX_PREFIX/lib/libc++.a" ] || {
    echo "ERROR: libcxx resolve missing libc++.a at $LIBCXX_PREFIX" >&2
    exit 1
}
[ -f "$LIBCXX_PREFIX/lib/libc++abi.a" ] || {
    echo "ERROR: libcxx resolve missing libc++abi.a at $LIBCXX_PREFIX" >&2
    exit 1
}
[ -d "$LIBCXX_PREFIX/include/c++/v1" ] || {
    echo "ERROR: libcxx resolve missing include/c++/v1 at $LIBCXX_PREFIX" >&2
    exit 1
}

OPENSSL_PREFIX="${WASM_POSIX_DEP_OPENSSL_DIR:-}"
if [ -z "$OPENSSL_PREFIX" ]; then
    echo "==> Resolving openssl via cargo xtask build-deps..."
    OPENSSL_PREFIX="$(resolve_dep openssl)"
fi
[ -f "$OPENSSL_PREFIX/lib/libssl.a" ] || {
    echo "ERROR: openssl resolve missing libssl.a at $OPENSSL_PREFIX" >&2
    exit 1
}
[ -f "$OPENSSL_PREFIX/lib/libcrypto.a" ] || {
    echo "ERROR: openssl resolve missing libcrypto.a at $OPENSSL_PREFIX" >&2
    exit 1
}
[ -d "$OPENSSL_PREFIX/include" ] || {
    echo "ERROR: openssl resolve missing include directory at $OPENSSL_PREFIX" >&2
    exit 1
}

CODECS_PREFIX="${WASM_POSIX_DEP_NODE_CODECS_DIR:-}"
if [ -z "$CODECS_PREFIX" ]; then
    echo "==> Resolving Node's pinned codec libraries..."
    CODECS_PREFIX="$(resolve_dep node-codecs)"
fi
for codec_archive in libz.a libbrotli.a libzstd.a; do
    [ -f "$CODECS_PREFIX/lib/$codec_archive" ] || {
        echo "ERROR: node-codecs resolve missing $codec_archive at $CODECS_PREFIX" >&2
        exit 1
    }
done
[ -d "$CODECS_PREFIX/include" ] || {
    echo "ERROR: node-codecs resolve missing include directory at $CODECS_PREFIX" >&2
    exit 1
}
# A codec archive with a different Node source pin must not enter this target.
python3 - "$CODECS_PREFIX/share/node-codecs/provenance.json" \
    "$REPO_ROOT/packages/registry/node-compat/target.json" <<'PYCODECS'
import json,sys
from pathlib import Path
actual,target=[json.loads(Path(p).read_text()) for p in sys.argv[1:]]
if (actual.get('schema') != 1 or actual.get('compiled') is not True or actual.get('arch') != 'wasm32' or
    actual.get('nodeVersion') != target['version'] or actual.get('nodeSourceCommit') != target['source']['commit'] or
    any(actual.get('source', {}).get(k) != target['source'][k] for k in ['url','sha256'])):
    raise SystemExit('Node codec provenance differs from the exact API/source target; rebuild through the resolver')
PYCODECS

SQLITE_PREFIX="${WASM_POSIX_DEP_NODE_SQLITE_DIR:-}"
if [ -z "$SQLITE_PREFIX" ]; then
    echo "==> Resolving Node's pinned SQLite backend..."
    SQLITE_PREFIX="$(resolve_dep node-sqlite)"
fi
[ -f "$SQLITE_PREFIX/lib/libsqlite3.a" ] && [ -f "$SQLITE_PREFIX/include/sqlite3.h" ] || {
    echo "ERROR: node-sqlite resolve missing archive/header at $SQLITE_PREFIX" >&2
    exit 1
}
python3 - "$SQLITE_PREFIX/share/node-sqlite/provenance.json" \
    "$REPO_ROOT/packages/registry/node-compat/target.json" <<'PYSQLITE'
import json,sys
from pathlib import Path
actual,target=[json.loads(Path(p).read_text()) for p in sys.argv[1:]]
if (actual.get('schema') != 1 or actual.get('compiled') is not True or actual.get('arch') != 'wasm32' or
    actual.get('nodeVersion') != target['version'] or actual.get('nodeSourceCommit') != target['source']['commit'] or
    any(actual.get('source', {}).get(k) != target['source'][k] for k in ['url','sha256'])):
    raise SystemExit('Node SQLite provenance differs from the exact API/source target; rebuild through the resolver')
PYSQLITE
export WASM_POSIX_DEP_NODE_SQLITE_DIR="$SQLITE_PREFIX"

SIMDJSON_PREFIX="${WASM_POSIX_DEP_NODE_SIMDJSON_DIR:-}"
if [ -z "$SIMDJSON_PREFIX" ]; then
    SIMDJSON_PREFIX="$(resolve_dep node-simdjson)"
fi
[ -f "$SIMDJSON_PREFIX/lib/libsimdjson.a" ] && [ -f "$SIMDJSON_PREFIX/include/simdjson.h" ] || {
    echo "ERROR: node-simdjson resolve missing archive/header at $SIMDJSON_PREFIX" >&2
    exit 1
}
python3 - "$SIMDJSON_PREFIX/share/node-simdjson/provenance.json" \
    "$REPO_ROOT/packages/registry/node-compat/target.json" <<'PYSIMDJSON'
import json,sys
from pathlib import Path
actual,target=[json.loads(Path(p).read_text()) for p in sys.argv[1:]]
if (actual.get('schema') != 1 or actual.get('compiled') is not True or actual.get('arch') != 'wasm32' or
    actual.get('nodeVersion') != target['version'] or actual.get('nodeSourceCommit') != target['source']['commit'] or
    any(actual.get('source', {}).get(k) != target['source'][k] for k in ['url','sha256'])):
    raise SystemExit('Node simdjson provenance differs from the exact target; rebuild through the resolver')
PYSIMDJSON
export WASM_POSIX_DEP_NODE_SIMDJSON_DIR="$SIMDJSON_PREFIX"


CARES_PREFIX="${WASM_POSIX_DEP_NODE_CARES_DIR:-}"
if [ -z "$CARES_PREFIX" ]; then CARES_PREFIX="$(resolve_dep node-cares)"; fi
[ -f "$CARES_PREFIX/lib/libcares.a" ] && [ -f "$CARES_PREFIX/include/ares.h" ] || {
    echo "ERROR: node-cares resolve missing archive/header at $CARES_PREFIX" >&2
    exit 1
}
python3 - "$CARES_PREFIX/share/node-cares/provenance.json" \
    "$REPO_ROOT/packages/registry/node-compat/target.json" <<'PYCARES'
import json,sys
from pathlib import Path
actual,target=[json.loads(Path(p).read_text()) for p in sys.argv[1:]]
if (actual.get('compiled') is not True or actual.get('arch') != 'wasm32' or
    actual.get('nodeVersion') != target['version'] or actual.get('nodeSourceCommit') != target['source']['commit'] or
    any(actual.get('source', {}).get(k) != target['source'][k] for k in ['url','sha256'])):
    raise SystemExit('Node c-ares provenance differs from the exact target; rebuild through the resolver')
PYCARES
export WASM_POSIX_DEP_NODE_CARES_DIR="$CARES_PREFIX"

NCRYPTO_PREFIX="${WASM_POSIX_DEP_NODE_NCRYPTO_DIR:-}"
if [ -z "$NCRYPTO_PREFIX" ]; then NCRYPTO_PREFIX="$(resolve_dep node-ncrypto)"; fi
[ -f "$NCRYPTO_PREFIX/lib/libncrypto.a" ] && [ -f "$NCRYPTO_PREFIX/include/ncrypto.h" ] || {
    echo "ERROR: node-ncrypto resolve missing archive/header at $NCRYPTO_PREFIX" >&2
    exit 1
}
python3 - "$NCRYPTO_PREFIX/share/node-ncrypto/provenance.json" \
    "$REPO_ROOT/packages/registry/node-compat/target.json" <<'PYNCRYPTO'
import json,sys
from pathlib import Path
actual,target=[json.loads(Path(p).read_text()) for p in sys.argv[1:]]
if (actual.get('compiled') is not True or actual.get('arch') != 'wasm32' or
    actual.get('nodeVersion') != target['version'] or actual.get('nodeSourceCommit') != target['source']['commit'] or
    any(actual.get('source', {}).get(k) != target['source'][k] for k in ['url','sha256'])):
    raise SystemExit('Node ncrypto provenance differs from the exact target; rebuild through the resolver')
PYNCRYPTO
export WASM_POSIX_DEP_NODE_NCRYPTO_DIR="$NCRYPTO_PREFIX"

LLHTTP_PREFIX="${WASM_POSIX_DEP_NODE_LLHTTP_DIR:-}"
if [ -z "$LLHTTP_PREFIX" ]; then LLHTTP_PREFIX="$(resolve_dep node-llhttp)"; fi
[ -f "$LLHTTP_PREFIX/lib/libllhttp.a" ] && [ -f "$LLHTTP_PREFIX/include/llhttp.h" ] || {
    echo "ERROR: node-llhttp resolve missing archive/header at $LLHTTP_PREFIX" >&2
    exit 1
}
python3 - "$LLHTTP_PREFIX/share/node-llhttp/provenance.json" \
    "$REPO_ROOT/packages/registry/node-compat/target.json" <<'PYLLHTTP'
import json,sys
from pathlib import Path
actual,target=[json.loads(Path(p).read_text()) for p in sys.argv[1:]]
if (actual.get('compiled') is not True or actual.get('arch') != 'wasm32' or
    actual.get('nodeVersion') != target['version'] or actual.get('nodeSourceCommit') != target['source']['commit'] or
    any(actual.get('source', {}).get(k) != target['source'][k] for k in ['url','sha256'])):
    raise SystemExit('Node llhttp provenance differs from the exact target; rebuild through the resolver')
PYLLHTTP
export WASM_POSIX_DEP_NODE_LLHTTP_DIR="$LLHTTP_PREFIX"


export WASM_POSIX_DEP_LIBCXX_DIR="$LIBCXX_PREFIX"
export WASM_POSIX_DEP_OPENSSL_DIR="$OPENSSL_PREFIX"
export WASM_POSIX_DEP_NODE_CODECS_DIR="$CODECS_PREFIX"
# The codec projection also belongs in a private sysroot for direct builds;
# replacing headers/archives in the shared SDK would affect other consumers.
SYSROOT="$(
    WASM_POSIX_DEP_WORK_DIR="$WORK_DIR" kandelo_package_prepare_private_sysroot \
        spidermonkey "$SYSROOT" libcxx openssl node-codecs node-sqlite node-simdjson node-cares node-ncrypto node-llhttp
)"
export WASM_POSIX_SYSROOT="$SYSROOT"

# Mozilla's build uses the compiler driver directly and expects libc++ to be
# visible from the target sysroot. Keep the sysroot as an index of cache-managed
# libcxx artifacts, matching the MariaDB and C++ program build paths.
mkdir -p "$SYSROOT/lib" "$SYSROOT/include/c++"
ln -sf "$LIBCXX_PREFIX/lib/libc++.a" "$SYSROOT/lib/libc++.a"
ln -sf "$LIBCXX_PREFIX/lib/libc++abi.a" "$SYSROOT/lib/libc++abi.a"
ln -sf "$OPENSSL_PREFIX/lib/libssl.a" "$SYSROOT/lib/libssl.a"
ln -sf "$OPENSSL_PREFIX/lib/libcrypto.a" "$SYSROOT/lib/libcrypto.a"
ln -sf "$CODECS_PREFIX/lib/libz.a" "$SYSROOT/lib/libz.a"
ln -sf "$CODECS_PREFIX/lib/libbrotli.a" "$SYSROOT/lib/libbrotli.a"
ln -sf "$CODECS_PREFIX/lib/libzstd.a" "$SYSROOT/lib/libzstd.a"
rm -rf "$SYSROOT/include/c++/v1"
ln -sfn "$LIBCXX_PREFIX/include/c++/v1" "$SYSROOT/include/c++/v1"

mkdir -p "$BIN_DIR" "$DOWNLOAD_DIR" "$SRC_PARENT"


PATCH_DIR="$SCRIPT_DIR/patches"
if [ -d "$PATCH_DIR" ]; then
    for patch_file in "$PATCH_DIR"/*.patch; do
        [ -f "$patch_file" ] || continue
        patch_name="$(basename "$patch_file")"
        if patch -p1 -N --dry-run --silent -d "$SRC_DIR" < "$patch_file" >/dev/null 2>&1; then
            echo "==> Applying $patch_name..."
            patch -p1 -N -d "$SRC_DIR" < "$patch_file"
        elif patch -p1 -R --dry-run --silent -d "$SRC_DIR" < "$patch_file" >/dev/null 2>&1; then
            # Reverse-applies cleanly: this patch is already present in the
            # source tree (e.g. a re-run against a previously patched
            # checkout). Nothing to do.
            echo "==> $patch_name already applied, skipping."
        else
            # Neither a forward nor a reverse dry-run succeeded: the patch
            # does not cleanly apply to this source tree at all. Silently
            # continuing here would ship a build missing a platform fix
            # (e.g. 0015/0016/0017) with no signal that it was dropped.
            echo "ERROR: patch $patch_name does not apply to $SRC_DIR (source may have drifted from what the patch expects). Update the patch or the pinned source version." >&2
            exit 1
        fi
    done
fi

# Generate only into this resolve's private engine source tree. The excerpts
# and generator are declared build inputs, and verify the exact Node source pin.
python3 "$REPO_ROOT/third_party/node-core/generate-codec-contexts.py" \
    --output "$SRC_DIR/js/src/shell/kandelo-node-codec-contexts.h"
python3 "$REPO_ROOT/third_party/node-core/generate-uv-error-table.py" \
    --output "$SRC_DIR/js/src/shell/kandelo-node-uv-error-table.h"
cp "$REPO_ROOT/third_party/node-core/upstream/uv-errors/deps/uv/include/uv/errno.h" \
    "$SRC_DIR/js/src/shell/kandelo-node-uv-errno.h"
mkdir -p "$SRC_DIR/third_party/kandelo-node/merve"
cp "$REPO_ROOT/third_party/node-core/upstream/esm-source/deps/merve/merve.h" "$SRC_DIR/third_party/kandelo-node/merve/merve.h"
cp "$REPO_ROOT/third_party/node-core/upstream/esm-source/deps/merve/merve.cpp" "$SRC_DIR/third_party/kandelo-node/merve/merve.cpp"
cp "$REPO_ROOT/third_party/node-core/upstream/esm-source/deps/merve/LICENSE-MIT" "$SRC_DIR/third_party/kandelo-node/merve/LICENSE-MIT"
cp "$REPO_ROOT/third_party/node-core/ffi-borrowed-backing.h" "$SRC_DIR/js/src/shell/kandelo-node-ffi-borrowed-backing.h"
sed 's|#include "ffi-library-owner.h"|#include "kandelo-node-ffi-library-owner.h"|' \
    "$REPO_ROOT/third_party/node-core/ffi-memory-owner.h" > "$SRC_DIR/js/src/shell/kandelo-node-ffi-memory-owner.h"
cp "$REPO_ROOT/third_party/node-core/ffi-library-owner.h" "$SRC_DIR/js/src/shell/kandelo-node-ffi-library-owner.h"
cp "$REPO_ROOT/third_party/node-core/dns-errors.h" "$SRC_DIR/js/src/shell/kandelo-node-dns-errors.h"
cp "$REPO_ROOT/third_party/node-core/dns-lookup.h" "$SRC_DIR/js/src/shell/kandelo-node-dns-lookup.h"
cp "$REPO_ROOT/third_party/node-core/datagram-operations.h" "$SRC_DIR/js/src/shell/kandelo-node-datagram-operations.h"
cp "$REPO_ROOT/third_party/node-core/datagram-send-spans.h" "$SRC_DIR/js/src/shell/kandelo-node-datagram-send-spans.h"
cp "$REPO_ROOT/third_party/node-core/dns-records.h" "$SRC_DIR/js/src/shell/kandelo-node-dns-records.h"
cp "$REPO_ROOT/third_party/node-core/dns-resolver.h" "$SRC_DIR/js/src/shell/kandelo-node-dns-resolver.h"
# Canonical staged names preserve the portable backend/control header owner.
python3 - "$SRC_DIR/js/src/shell/kandelo-node-dns-resolver.h" <<'PYDNS'
from pathlib import Path
import sys
p=Path(sys.argv[1]);p.write_text(p.read_text().replace('#include "dns-records.h"', '#include "kandelo-node-dns-records.h"'))
PYDNS
python3 "$REPO_ROOT/third_party/node-core/generate-dns-constants.py" \
    --output "$SRC_DIR/js/src/shell/kandelo-node-dns-constants.h"
cp "$REPO_ROOT/third_party/node-core/process-state.h" "$SRC_DIR/js/src/shell/kandelo-node-process-state.h"
cp "$REPO_ROOT/third_party/node-core/os-operations.h" "$SRC_DIR/js/src/shell/kandelo-node-os-operations.h"
cp "$REPO_ROOT/third_party/node-core/default-locale.h" "$SRC_DIR/js/src/shell/kandelo-node-default-locale.h"
cp "$REPO_ROOT/third_party/node-core/terminal-operations.h" "$SRC_DIR/js/src/shell/kandelo-node-terminal-operations.h"
python3 "$REPO_ROOT/third_party/node-core/generate-dotenv.py" --check
cp "$REPO_ROOT/third_party/node-core/dotenv-parser.h" "$SRC_DIR/js/src/shell/kandelo-node-dotenv-parser.h"
cp "$REPO_ROOT/third_party/node-core/dotenv-file.h" "$SRC_DIR/js/src/shell/kandelo-node-dotenv-file.h"
python3 "$REPO_ROOT/third_party/node-core/generate-address-inet.py" --check
cp "$REPO_ROOT/third_party/node-core/address-rules.h" "$SRC_DIR/js/src/shell/kandelo-node-address-rules.h"
cp "$REPO_ROOT/third_party/node-core/address-inet.h" "$SRC_DIR/js/src/shell/kandelo-node-address-inet.h"
cp "$REPO_ROOT/third_party/node-core/upstream/address-rules/src/node_hash.h" "$SRC_DIR/js/src/shell/kandelo-node-address-hash.h"
cp "$REPO_ROOT/third_party/node-core/random-operations.h" "$SRC_DIR/js/src/shell/kandelo-node-random-operations.h"
cp "$REPO_ROOT/third_party/node-core/hkdf-operations.h" "$SRC_DIR/js/src/shell/kandelo-node-hkdf-operations.h"
cp "$REPO_ROOT/third_party/node-core/http-parser.h" "$SRC_DIR/js/src/shell/kandelo-node-http-parser.h"
cp "$REPO_ROOT/third_party/node-core/kdf-operations.h" "$SRC_DIR/js/src/shell/kandelo-node-kdf-operations.h"
cp "$REPO_ROOT/third_party/node-core/path-metadata-operations.h" "$SRC_DIR/js/src/shell/kandelo-node-path-metadata-operations.h"
cp "$REPO_ROOT/third_party/node-core/copy-file-operations.h" "$SRC_DIR/js/src/shell/kandelo-node-copy-file-operations.h"
python3 "$REPO_ROOT/third_party/node-core/stage-copy-directory.py" "$SRC_DIR/js/src/shell"
cp "$REPO_ROOT/third_party/node-core/write-file-operations.h" "$SRC_DIR/js/src/shell/kandelo-node-write-file-operations.h"
cp "$REPO_ROOT/third_party/node-core/read-file-buffer.h" "$SRC_DIR/js/src/shell/kandelo-node-read-file-buffer.h"
cp "$REPO_ROOT/third_party/node-core/codec-pledge.h" "$SRC_DIR/js/src/shell/kandelo-node-codec-pledge.h"
cp "$REPO_ROOT/third_party/node-core/key-operations.h" "$SRC_DIR/js/src/shell/kandelo-node-key-operations.h"
cp "$REPO_ROOT/third_party/node-core/x509-operations.h" "$SRC_DIR/js/src/shell/kandelo-node-x509-operations.h"
cp "$REPO_ROOT/third_party/node-core/cipher-operations.h" "$SRC_DIR/js/src/shell/kandelo-node-cipher-operations.h"
cp "$REPO_ROOT/third_party/node-core/rsa-operations.h" "$SRC_DIR/js/src/shell/kandelo-node-rsa-operations.h"
cp "$REPO_ROOT/third_party/node-core/signature-operations.h" "$SRC_DIR/js/src/shell/kandelo-node-signature-operations.h"
cp "$REPO_ROOT/third_party/node-core/signature-job-operations.h" "$SRC_DIR/js/src/shell/kandelo-node-signature-job-operations.h"
python3 "$REPO_ROOT/third_party/node-core/generate-crypto-errors.py" --check
cp "$REPO_ROOT/third_party/node-core/crypto-errors.h" "$SRC_DIR/js/src/shell/crypto-errors.h"
cp "$REPO_ROOT/third_party/node-core/digest-operations.h" "$SRC_DIR/js/src/shell/kandelo-node-digest-operations.h"
cp "$REPO_ROOT/third_party/node-core/child-wait.h" "$SRC_DIR/js/src/shell/kandelo-node-child-wait.h"
cp "$REPO_ROOT/third_party/node-core/performance-clock.h" "$SRC_DIR/js/src/shell/kandelo-node-performance-clock.h"
cp "$REPO_ROOT/third_party/node-core/monotonic-clock.h" "$SRC_DIR/js/src/shell/kandelo-node-monotonic-clock.h"
cp "$REPO_ROOT/third_party/node-core/port-queue.h" "$SRC_DIR/js/src/shell/kandelo-node-port-queue.h"
cp "$REPO_ROOT/third_party/node-core/port-transit-graph.h" "$SRC_DIR/js/src/shell/kandelo-node-port-transit-graph.h"
cp "$REPO_ROOT/third_party/node-core/port-transit-owner.h" "$SRC_DIR/js/src/shell/kandelo-node-port-transit-owner.h"
cp "$REPO_ROOT/third_party/node-core/lock-manager.h" "$SRC_DIR/js/src/shell/kandelo-node-lock-manager.h"
cp "$REPO_ROOT/third_party/node-core/provider-rotation.h" "$SRC_DIR/js/src/shell/kandelo-node-provider-rotation.h"
cp "$REPO_ROOT/third_party/node-core/sqlite-store.h" \
    "$SRC_DIR/js/src/shell/kandelo-node-sqlite-store.h"
sed 's|#include "sqlite-store.h"|#include "kandelo-node-sqlite-store.h"|' \
    "$REPO_ROOT/third_party/node-core/sqlite-backup.h" > "$SRC_DIR/js/src/shell/kandelo-node-sqlite-backup.h"
cp "$REPO_ROOT/third_party/node-core/sqlite-limit-names.h" "$SRC_DIR/js/src/shell/kandelo-node-sqlite-limits.h"
python3 "$REPO_ROOT/third_party/node-core/generate-sqlite-constants.py" \
    --output "$SRC_DIR/js/src/shell/kandelo-node-sqlite-constants.h"
cp "$REPO_ROOT/third_party/node-core/callback-scope.h" "$SRC_DIR/js/src/shell/kandelo-node-callback-scope.h"
cp "$REPO_ROOT/third_party/node-core/callback-execution-stack.h" "$SRC_DIR/js/src/shell/kandelo-node-callback-execution-stack.h"
cp "$REPO_ROOT/third_party/node-core/socket-owner.h" "$SRC_DIR/js/src/shell/kandelo-node-socket-owner.h"
python3 "$REPO_ROOT/third_party/node-core/generate-socket-state.py" --check
cp "$REPO_ROOT/third_party/node-core/socket-stream-state.h" "$SRC_DIR/js/src/shell/kandelo-node-socket-stream-state.h"
cp "$REPO_ROOT/third_party/node-core/native-retained-memory.h" "$SRC_DIR/js/src/shell/native-retained-memory.h"
python3 "$REPO_ROOT/third_party/node-core/generate-process-signals.py" --shell-dir "$SRC_DIR/js/src/shell"
python3 "$REPO_ROOT/third_party/node-core/stage-wasi.py" --shell-dir "$SRC_DIR/js/src/shell"
python3 "$REPO_ROOT/third_party/node-core/stage-stat-watcher.py" \
    --shell-dir "$SRC_DIR/js/src/shell"
# The VM's native capability boundary stays C++17; only this existing C++20
# shell embedding consumes the canonical retained-memory owner implementation.
cp "$SRC_DIR/js/public/experimental/KandeloBackingCapabilities.h" \
    "$SRC_DIR/js/src/shell/kandelo-node-backing-capabilities.h"
cp "$REPO_ROOT/third_party/node-core/retained-backing-store.h" \
    "$SRC_DIR/js/src/shell/retained-backing-store.h"
cp "$REPO_ROOT/third_party/node-core/removal-operations.h" "$SRC_DIR/js/src/shell/kandelo-node-removal-operations.h"
cp "$REPO_ROOT/third_party/node-core/directory-operations.h" "$SRC_DIR/js/src/shell/kandelo-node-directory-operations.h"
python3 "$REPO_ROOT/third_party/node-core/generate-fs-constants.py" \
    --output "$SRC_DIR/js/src/shell/kandelo-node-fs-constants.h"
python3 "$REPO_ROOT/third_party/node-core/generate-public-constants.py" \
    --output "$SRC_DIR/js/src/shell/kandelo-node-public-constants.h"

cp "$REPO_ROOT/third_party/node-core/readdir-operations.h" "$SRC_DIR/js/src/shell/kandelo-node-readdir-operations.h"
cp "$REPO_ROOT/third_party/node-core/dir-cursor.h" "$SRC_DIR/js/src/shell/kandelo-node-dir-cursor.h"
cp "$REPO_ROOT/third_party/node-core/package-config.h" "$SRC_DIR/js/src/shell/kandelo-node-package-config.h"
python3 "$REPO_ROOT/third_party/node-core/generate-tls-context.py" \
    --header "$SRC_DIR/js/src/shell/kandelo-node-tls-context-trust.h"
python3 "$REPO_ROOT/third_party/node-core/generate-tls-credentials.py" \
    --header "$SRC_DIR/js/src/shell/kandelo-node-tls-credential-operations.h"
python3 "$REPO_ROOT/third_party/node-core/generate-tls-state.py" \
    --output "$SRC_DIR/js/src/shell/kandelo-node-tls-state.h"
python3 "$REPO_ROOT/third_party/node-core/generate-package-parser.py" \
    --output "$SRC_DIR/js/src/shell/kandelo-node-package-parser.h"
python3 "$REPO_ROOT/third_party/node-core/generate-dirent-types.py" \
    --output "$SRC_DIR/js/src/shell/kandelo-node-dirent-types.h"
cp "$REPO_ROOT/third_party/node-core/incremental-hash.h" "$SRC_DIR/js/src/shell/kandelo-node-incremental-hash.h"
python3 "$REPO_ROOT/third_party/node-core/generate-native-encoding.py" \
    --output "$SRC_DIR/js/src/shell/kandelo-node-native-encoding.h"
python3 "$REPO_ROOT/third_party/node-core/stage-string-bytes.py" \
    --output "$SRC_DIR/js/src/shell/kandelo-node-string-bytes.h"
python3 "$REPO_ROOT/third_party/node-core/generate-histogram-owner.py" --check
for histogram_source in histogram-binding.h histogram-portability.h histogram-owner.h histogram-owner-inl.h histogram-work.h histogram-window.h histogram-owner.cc histogram-window.cc; do
    cp "$REPO_ROOT/third_party/node-core/$histogram_source" "$SRC_DIR/js/src/shell/$histogram_source"
done
# Repeated staging must not nest the vendor tree or retain stale headers.
rm -rf "$SRC_DIR/js/src/shell/histogram-vendor"
mkdir -p "$SRC_DIR/third_party/kandelo-node"
rm -rf "$SRC_DIR/third_party/kandelo-node/histogram"
cp -R "$REPO_ROOT/third_party/node-core/upstream/histogram-reference/deps/histogram" "$SRC_DIR/third_party/kandelo-node/histogram"
cp "$REPO_ROOT/third_party/node-core/event-loop-delay.h" "$SRC_DIR/js/src/shell/event-loop-delay.h"
cp "$REPO_ROOT/third_party/node-core/event-loop-delay-lifetime.h" "$SRC_DIR/js/src/shell/event-loop-delay-lifetime.h"
cp "$REPO_ROOT/third_party/node-core/vm-module-hooks.h" "$SRC_DIR/js/src/shell/kandelo-node-vm-module-hooks.h"
cp "$REPO_ROOT/third_party/node-core/vm-execution-deadline.h" "$SRC_DIR/js/src/shell/kandelo-node-vm-execution-deadline.h"
python3 "$REPO_ROOT/third_party/node-core/generate-native-embedding.py" \
    --shell-dir "$SRC_DIR/js/src/shell"


NODE_ADAPTER_JS="$SCRIPT_DIR/node-compat/adapter.js"
NODE_SHARED_BOOTSTRAP_JS="$REPO_ROOT/packages/registry/node-compat/bootstrap.js"
NODE_WEB_PLATFORM_JS="$REPO_ROOT/third_party/node-web-platform/node-web-platform.js"
NODE_CORE_JS="$REPO_ROOT/third_party/node-core/node-core.js"
NODE_SUFFIX_JS="$SCRIPT_DIR/node-compat/suffix.js"
NODE_BOOTSTRAP_JS="$OBJ_DIR/kandelo-node-bootstrap.generated.js"
NODE_BOOTSTRAP_INC="$SRC_DIR/js/src/shell/kandelo-node-bootstrap.h"
for bootstrap_part in "$NODE_ADAPTER_JS" "$NODE_SHARED_BOOTSTRAP_JS" "$NODE_SUFFIX_JS" "$NODE_WEB_PLATFORM_JS" "$NODE_CORE_JS"; do
    [ -f "$bootstrap_part" ] || {
        echo "ERROR: SpiderMonkey Node bootstrap input missing at $bootstrap_part" >&2
        exit 1
    }
done
mkdir -p "$OBJ_DIR"
echo "==> Generating SpiderMonkey Node bootstrap include..."
python3 "$REPO_ROOT/scripts/generate-node-bootstrap.py" \
    "$NODE_ADAPTER_JS" "$NODE_SHARED_BOOTSTRAP_JS" "$NODE_SUFFIX_JS" \
    "$NODE_BOOTSTRAP_JS" "$NODE_BOOTSTRAP_INC" "$NODE_WEB_PLATFORM_JS" \
    "$REPO_ROOT/packages/registry/node-compat/target.json" "$NODE_CORE_JS"

WASM_RUST_TARGET_FEATURES='-Ctarget-feature=+atomics,+bulk-memory,+mutable-globals'
GETRANDOM_BACKEND_RUSTFLAG='--cfg=getrandom_backend=\"custom\"'
WASM_RUSTFLAGS="$WASM_RUST_TARGET_FEATURES $GETRANDOM_BACKEND_RUSTFLAG"
# Reproducibility: strip the per-build work directory — whose absolute path
# embeds the build scratch location and a PID-suffixed component — from Rust
# panic/debug source paths. Without this, js.wasm (and node.wasm, which links
# SpiderMonkey's Rust objects) vary across build paths and reruns because the
# vendored crate paths under $WORK_DIR/spidermonkey-source leak in. Mirrors the
# SDK cc wrapper's -ffile-prefix-map for C/C++.
if [ -n "${WORK_DIR:-}" ]; then
    WASM_RUSTFLAGS="$WASM_RUSTFLAGS --remap-path-prefix=$WORK_DIR=/usr/src/kandelo-build/spidermonkey"
fi

cat > "$MOZCONFIG_PATH" <<EOF
export RUSTFLAGS="\${RUSTFLAGS:+\$RUSTFLAGS }$WASM_RUSTFLAGS"
ac_add_options --enable-project=js
ac_add_options --target=wasm32-unknown-kandelo
ac_add_options --disable-debug
ac_add_options --enable-optimize="-O2"
ac_add_options --disable-jit
ac_add_options --disable-jemalloc
ac_add_options --without-system-zlib
ac_add_options --with-intl-api
ac_add_options --enable-icu4x
ac_add_options --disable-shared-js
ac_add_options --enable-shared-memory
ac_add_options --enable-explicit-resource-management
ac_add_options --disable-clang-plugin
ac_add_options --disable-tests
ac_add_options --disable-debug-symbols
mk_add_options MOZ_OBJDIR=$OBJ_DIR
EOF
if [ -n "$MACOS_SDK_DIR" ]; then
    echo "ac_add_options --with-macos-sdk=$MACOS_SDK_DIR" >> "$MOZCONFIG_PATH"
fi

export MOZCONFIG="$MOZCONFIG_PATH"
export MOZBUILD_STATE_PATH
export MACH_BUILD_PYTHON_NATIVE_PACKAGE_SOURCE=system

# Mozilla's explicit Kandelo target checks this recipe-local identity together
# with the SDK's actual Wasm/Unix macros; it rejects Linux/WASI/Emscripten.
# The SDK's LLVM code-generation triple remains wasm32-unknown-unknown.
export CC="${WASM_POSIX_TARGET_CC:-wasm32posix-cc} -D__kandelo__=1"
export CXX="${WASM_POSIX_TARGET_CXX:-wasm32posix-c++} -D__kandelo__=1"
export AS="${WASM_POSIX_TARGET_AS:-wasm32posix-cc} -D__kandelo__=1"
export AR="${WASM_POSIX_TARGET_AR:-wasm32posix-ar}"
export RANLIB="${WASM_POSIX_TARGET_RANLIB:-wasm32posix-ranlib}"
export NM="${WASM_POSIX_TARGET_NM:-wasm32posix-nm}"
export STRIP="${WASM_POSIX_TARGET_STRIP:-wasm32posix-strip}"
# One host compiler everywhere: the dev shell's clang. Darwin used to be
# special-cased to /usr/bin/cc, which required Xcode's command line tools and
# an accepted Xcode licence for a build that otherwise needs neither.
export HOST_CC="${HOST_CC:-cc}"
export HOST_CXX="${HOST_CXX:-c++}"

# Preflight: prove the host linker can link against the chosen macOS SDK
# BEFORE spending half an hour getting to the first host program.
#
# SpiderMonkey's configure picks lld for host programs whenever the host
# compiler is clang 15 or newer, and that choice cannot be overridden from
# here: `select_linker_tmpl(host)` in build/moz.configure/toolchain.configure
# is handed no linker option at all, and configure appends its own
# `-fuse-ld=lld` AFTER whatever HOST_LDFLAGS carries -- where the last
# `-fuse-ld` on a clang command line wins. HOST_LD is not a mozbuild variable
# either. So an SDK the selected linker cannot read is fatal, and the way it
# surfaces is a screen of "undefined symbol: strcpy" naming neither the SDK
# nor the linker.
#
# `$HOST_CC -fuse-ld=lld -Wl,--version` is configure's own selection test, so
# asking it first means this check probes lld only when configure will
# actually choose lld -- a host without lld gets ld64 from both, and no
# spurious failure from here.
if [ "$HOST_OS" = "Darwin" ] && $HOST_CC -fuse-ld=lld -Wl,--version >/dev/null 2>&1; then
    echo "==> Checking the host linker can link against the macOS SDK..."
    PREFLIGHT_DIR="$OBJ_DIR/.host-link-preflight"
    rm -rf "$PREFLIGHT_DIR"
    mkdir -p "$PREFLIGHT_DIR"
    cat > "$PREFLIGHT_DIR/probe.c" <<'PROBE'
#include <string.h>
#include <unistd.h>
int main(void)
{
    int reached = access("/", F_OK);
    int compared = strncmp("a", "b", 1);
    return reached + compared;
}
PROBE
    PREFLIGHT_SDK_FLAGS=""
    if [ -n "$MACOS_SDK_DIR" ]; then
        PREFLIGHT_SDK_FLAGS="-isysroot $MACOS_SDK_DIR"
    fi
    # shellcheck disable=SC2086
    if ! $HOST_CC $PREFLIGHT_SDK_FLAGS -fuse-ld=lld \
            -o "$PREFLIGHT_DIR/probe" "$PREFLIGHT_DIR/probe.c" \
            > "$PREFLIGHT_DIR/log" 2>&1; then
        {
            echo "ERROR: the host linker cannot link against the selected macOS SDK."
            echo "  host compiler: $HOST_CC"
            echo "  macOS SDK:     ${MACOS_SDK_DIR:-<host compiler default>}"
            echo "  linker:        lld, which SpiderMonkey's configure selects for"
            echo "                 host programs and offers no way to override"
            echo ""
            sed 's/^/  /' "$PREFLIGHT_DIR/log"
            echo ""
            echo "A 'could not load TAPI file ... unknown architecture' failure above"
            echo "means the SDK is NEWER than the pinned LLVM's ld64.lld can parse."
            echo "Point KANDELO_MACOS_SDK_DIR ('macosSdk' in flake.nix) at an SDK it"
            echo "can read, or raise the pinned LLVM."
        } >&2
        exit 1
    fi
    rm -rf "$PREFLIGHT_DIR"
fi
export CFLAGS="${CFLAGS:-} -pthread -D_GNU_SOURCE -I$OPENSSL_PREFIX/include -I$CODECS_PREFIX/include -I$SQLITE_PREFIX/include -I$SIMDJSON_PREFIX/include -I$NCRYPTO_PREFIX/include"
export CXXFLAGS="${CXXFLAGS:-} -pthread -D_GNU_SOURCE -fexceptions -I$OPENSSL_PREFIX/include -I$CODECS_PREFIX/include -I$SQLITE_PREFIX/include -I$SIMDJSON_PREFIX/include -I$NCRYPTO_PREFIX/include"
export LDFLAGS="${LDFLAGS:-} -pthread -ldl -lc++ -lc++abi $NCRYPTO_PREFIX/lib/libncrypto.a $LLHTTP_PREFIX/lib/libllhttp.a $OPENSSL_PREFIX/lib/libssl.a $OPENSSL_PREFIX/lib/libcrypto.a $CODECS_PREFIX/lib/libz.a $CODECS_PREFIX/lib/libbrotli.a $CODECS_PREFIX/lib/libzstd.a $SQLITE_PREFIX/lib/libsqlite3.a $SIMDJSON_PREFIX/lib/libsimdjson.a $CARES_PREFIX/lib/libcares.a -lm -Wl,-z,stack-size=16777216"

if [ -f "$OBJ_DIR/config.status" ] && {
    ! grep -q 'getrandom_backend' "$OBJ_DIR/config.status" ||
        grep -q 'getrandom_backend=custom' "$OBJ_DIR/config.status" ||
        ! grep -q 'target-feature=+atomics' "$OBJ_DIR/config.status"
}; then
    echo "==> Refreshing stale Mozilla configure state for Rust target flags..."
    rm -f "$OBJ_DIR/config.status" "$OBJ_DIR/.mozconfig.json"
fi

RUST_RELEASE_DIR="$OBJ_DIR/wasm32-unknown-unknown/release"
JSRUST_FINGERPRINT="$(
    find "$RUST_RELEASE_DIR/.fingerprint" -path '*/lib-jsrust.json' -type f -print -quit 2>/dev/null || true
)"
if [ -n "$JSRUST_FINGERPRINT" ] && ! grep -q 'target-feature=+atomics' "$JSRUST_FINGERPRINT"; then
    echo "==> Rebuilding stale SpiderMonkey Rust archive for wasm atomics..."
    rm -f "$RUST_RELEASE_DIR/libjsrust.a"
    rm -rf "$RUST_RELEASE_DIR/.fingerprint"/jsrust-*
fi

echo "==> Building SpiderMonkey JS shell for wasm32..."
(cd "$SRC_DIR" && ./mach --no-interactive build)

JS_BIN=""
for candidate in "$OBJ_DIR/dist/bin/js" "$OBJ_DIR/dist/bin/js.wasm"; do
    if [ -f "$candidate" ]; then
        JS_BIN="$candidate"
        break
    fi
done

if [ -z "$JS_BIN" ]; then
    echo "ERROR: SpiderMonkey build finished but no js shell was found under $OBJ_DIR/dist/bin." >&2
    exit 1
fi

cp "$JS_BIN" "$BIN_DIR/js.wasm"

WASM_OPT="${WASM_OPT:-wasm-opt}"
if command -v "$WASM_OPT" >/dev/null 2>&1; then
    echo "==> Optimizing js.wasm with wasm-opt -O2..."
    "$WASM_OPT" -O2 "$BIN_DIR/js.wasm" -o "$BIN_DIR/js.wasm"
else
    echo "WARNING: wasm-opt not found; leaving unoptimized js.wasm." >&2
fi

FORK_INSTRUMENT="$REPO_ROOT/scripts/run-wasm-fork-instrument.sh"
echo "==> Applying fork instrumentation to js.wasm..."
"$FORK_INSTRUMENT" "$BIN_DIR/js.wasm" -o "$BIN_DIR/js.wasm.instr"
mv "$BIN_DIR/js.wasm.instr" "$BIN_DIR/js.wasm"

JS_SIZE="$(wc -c < "$BIN_DIR/js.wasm" | tr -d ' ')"
echo "==> SpiderMonkey built successfully: $BIN_DIR/js.wasm ($JS_SIZE bytes)"

cp "$BIN_DIR/js.wasm" "$BIN_DIR/node.wasm"
NODE_SIZE="$(wc -c < "$BIN_DIR/node.wasm" | tr -d ' ')"
echo "==> SpiderMonkey Node-compatible runtime staged: $BIN_DIR/node.wasm ($NODE_SIZE bytes)"

# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-local-binary.sh"
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    WASM_POSIX_INSTALL_LOCAL_MIRROR=0 \
        WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto \
        install_local_binary spidermonkey "$BIN_DIR/js.wasm" js.wasm
else
    WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto \
        install_local_binary spidermonkey "$BIN_DIR/js.wasm" js.wasm
    WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto \
        install_local_binary spidermonkey-node "$BIN_DIR/node.wasm" node.wasm
    WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto \
        install_local_binary node "$BIN_DIR/node.wasm" node.wasm
fi
