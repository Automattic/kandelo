#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

BUILD_DIR="$REPO_ROOT/target/homebrew-bootstrap"
OUTPUT="$BUILD_DIR/homebrew-bootstrap.vfs"
SAB_SIZE=805306368
MAX_SIZE=""
SKIP_PACKAGE_RESOLVE=0

# Homebrew itself is ABI-independent. Keep this revision pinned so the
# bootstrap image is reproducible while Kandelo package artifacts follow the
# ABI declared by the checked-out Kandelo tree.
BREW_REPOSITORY="${HOMEBREW_BOOTSTRAP_BREW_REPOSITORY:-https://github.com/Homebrew/brew.git}"
BREW_REVISION="${HOMEBREW_BOOTSTRAP_BREW_REVISION:-21aba0bc7080a75753f01c06d2358ca27706bfeb}"
BREW_PATCH="$REPO_ROOT/homebrew/patches/0001-add-kandelo-wasm-bottle-tags.patch"
BREW_PATCH_SHA256="9c52238d811616c210cd1ecdd23b0192a3e0333219a70b34d8ea6d77dbcfbf74"
BOOTSTRAP_ARCH="wasm32"

usage() {
    cat <<'EOF'
Usage: scripts/build-homebrew-bootstrap.sh [options]

Build an ABI-current VFS image containing provenance-bound Homebrew with
Kandelo bottle-tag support and the programs needed to start it inside
NodeKernelHost.

Options:
  -o, --output <path>          output VFS path
      --sab-size <bytes>       initial writable VFS capacity (default: 805306368)
      --max-size <bytes>       maximum growable VFS size (default: sab-size)
      --skip-package-resolve   use already-materialized binaries/ artifacts
  -h, --help                   print this help

Run through scripts/dev-shell.sh. Generated inputs are staged under
target/homebrew-bootstrap/.
EOF
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        -o|--output)
            [ "$#" -ge 2 ] || { echo "build-homebrew-bootstrap: $1 requires a value" >&2; exit 2; }
            OUTPUT="$2"
            shift 2
            ;;
        --sab-size)
            [ "$#" -ge 2 ] || { echo "build-homebrew-bootstrap: $1 requires a value" >&2; exit 2; }
            SAB_SIZE="$2"
            shift 2
            ;;
        --max-size)
            [ "$#" -ge 2 ] || { echo "build-homebrew-bootstrap: $1 requires a value" >&2; exit 2; }
            MAX_SIZE="$2"
            shift 2
            ;;
        --skip-package-resolve)
            SKIP_PACKAGE_RESOLVE=1
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "build-homebrew-bootstrap: unknown option: $1" >&2
            usage >&2
            exit 2
            ;;
    esac
done

if ! [[ "$SAB_SIZE" =~ ^[1-9][0-9]*$ ]]; then
    echo "build-homebrew-bootstrap: --sab-size must be a positive integer" >&2
    exit 2
fi
if [ -z "$MAX_SIZE" ]; then
    MAX_SIZE="$SAB_SIZE"
elif ! [[ "$MAX_SIZE" =~ ^[1-9][0-9]*$ ]]; then
    echo "build-homebrew-bootstrap: --max-size must be a positive integer" >&2
    exit 2
fi
if [ "$MAX_SIZE" -lt "$SAB_SIZE" ]; then
    echo "build-homebrew-bootstrap: --max-size must be at least --sab-size" >&2
    exit 2
fi
if ! [[ "$BREW_REVISION" =~ ^[0-9a-f]{40}$ ]]; then
    echo "build-homebrew-bootstrap: Homebrew revision must be a full 40-character commit id" >&2
    exit 2
fi

for tool in cargo git node npm rustc sha256sum; do
    command -v "$tool" >/dev/null 2>&1 || {
        echo "build-homebrew-bootstrap: $tool not found; run through scripts/dev-shell.sh" >&2
        exit 2
    }
done

# mkrootfs imports the host VFS implementation and its own TypeScript runtime.
# Keep dependency installation aligned with scripts/build-rootfs.sh so a clean
# worktree does not accidentally depend on another worktree's node_modules.
if [ ! -d host/node_modules ]; then
    echo "==> Installing host dependencies needed by mkrootfs"
    (cd host && npm ci --no-audit --no-fund --prefer-offline --silent)
fi
if [ ! -d tools/mkrootfs/node_modules ]; then
    echo "==> Installing mkrootfs dependencies"
    (cd tools/mkrootfs && npm ci --no-audit --no-fund --prefer-offline --silent)
fi

ABI_VERSION="$(sed -nE 's/^pub const ABI_VERSION: u32 = ([0-9]+);$/\1/p' crates/shared/src/lib.rs)"
if [ -z "$ABI_VERSION" ]; then
    echo "build-homebrew-bootstrap: could not read ABI_VERSION from crates/shared/src/lib.rs" >&2
    exit 1
fi

HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
if [ -z "$HOST_TARGET" ]; then
    echo "build-homebrew-bootstrap: rustc -vV did not report a host triple" >&2
    exit 2
fi

mkdir -p "$BUILD_DIR" "$(dirname "$OUTPUT")"

BREW_GIT_DIR="$BUILD_DIR/homebrew-brew.git"
BREW_ARCHIVE="$BUILD_DIR/homebrew-brew.zip"
BREW_ENV="$BUILD_DIR/brew.env"
BREW_SOURCE_PROVENANCE="$BUILD_DIR/homebrew-source.json"

"$REPO_ROOT/scripts/prepare-homebrew-bootstrap-source.sh" \
    --repository "$BREW_REPOSITORY" \
    --revision "$BREW_REVISION" \
    --patch "$BREW_PATCH" \
    --expected-patch-sha256 "$BREW_PATCH_SHA256" \
    --arch "$BOOTSTRAP_ARCH" \
    --git-dir "$BREW_GIT_DIR" \
    --archive "$BREW_ARCHIVE" \
    --env "$BREW_ENV" \
    --provenance "$BREW_SOURCE_PROVENANCE"

XTASK=(cargo run --release -p xtask --target "$HOST_TARGET" --quiet -- build-deps --arch wasm32)

resolve_package() {
    local package="$1"
    echo "  resolve $package (wasm32)"
    "${XTASK[@]}" --binaries-dir "$REPO_ROOT/binaries" resolve "$package" >/dev/null
}

if [ "$SKIP_PACKAGE_RESOLVE" -eq 0 ]; then
    echo "==> Resolving canonical rootfs packages"
    while IFS= read -r package; do
        resolve_package "$package"
    done < <(awk '
        /^\[\[packages\]\]/ { in_pkg = 1; next }
        /^\[/ { in_pkg = 0; next }
        in_pkg && /^name[[:space:]]*=/ {
            line = $0
            sub(/^[^=]*=[[:space:]]*/, "", line)
            gsub(/["[:space:]]/, "", line)
            if (line != "" && !seen[line]++) print line
        }
    ' images/rootfs/PACKAGES.toml)

    echo "==> Resolving Homebrew bootstrap packages"
    for package in kernel ruby git curl tar gzip xz zstd bzip2; do
        resolve_package "$package"
    done
else
    echo "==> Skipping package resolution; verifying existing binaries/ artifacts"
fi

if [ ! -f "$REPO_ROOT/binaries/kernel.wasm" ]; then
    echo "build-homebrew-bootstrap: missing resolved Node runtime artifact binaries/kernel.wasm" >&2
    exit 1
fi

output_rel() {
    local package="$1"
    local basename="$2"
    local rel
    rel="$("${XTASK[@]}" output-path "$package" "$basename")"
    if [[ "$rel" = /* ]] || [[ "$rel" == *".."* ]] || [[ "$rel" =~ [[:space:]] ]]; then
        echo "build-homebrew-bootstrap: unsafe resolver output path for $package/$basename: $rel" >&2
        exit 1
    fi
    local path="$REPO_ROOT/binaries/programs/wasm32/$rel"
    if [ ! -f "$path" ]; then
        echo "build-homebrew-bootstrap: missing resolved artifact binaries/programs/wasm32/$rel" >&2
        exit 1
    fi
    printf '%s\n' "$rel"
}

RUBY_REL="$(output_rel ruby ruby.wasm)"
RUBY_RUNTIME_REL="$(output_rel ruby ruby-runtime.zip)"
GIT_REL="$(output_rel git git.wasm)"
GIT_REMOTE_HTTP_REL="$(output_rel git git-remote-http.wasm)"
CURL_REL="$(output_rel curl curl.wasm)"
TAR_REL="$(output_rel tar tar.wasm)"
GZIP_REL="$(output_rel gzip gzip.wasm)"
XZ_REL="$(output_rel xz xz.wasm)"
ZSTD_REL="$(output_rel zstd zstd.wasm)"
BZIP2_REL="$(output_rel bzip2 bzip2.wasm)"

ROOTFS_PACKAGE_MANIFEST="$BUILD_DIR/rootfs-packages.MANIFEST"
ROOTFS_EAGER_ARGUMENTS="$BUILD_DIR/rootfs-eager-arguments.txt"
BOOTSTRAP_MANIFEST="$BUILD_DIR/bootstrap.MANIFEST"
IMAGE_METADATA="$BUILD_DIR/homebrew-image.json"
BOOTSTRAP_LAYOUT_REL="target/homebrew-bootstrap/homebrew-bootstrap-layout.json"
BOOTSTRAP_LAYOUT="$REPO_ROOT/$BOOTSTRAP_LAYOUT_REL"

echo "==> Generating rootfs package manifest"
node scripts/homebrew-bootstrap-layout.ts --print-rootfs-eager-arguments \
    >"$ROOTFS_EAGER_ARGUMENTS"
ROOTFS_EAGER_ARGS=()
while IFS= read -r argument; do
    [ -n "$argument" ] || continue
    ROOTFS_EAGER_ARGS+=("$argument")
done <"$ROOTFS_EAGER_ARGUMENTS"
[ "${#ROOTFS_EAGER_ARGS[@]}" -gt 0 ] || {
    echo "build-homebrew-bootstrap: authoritative eager rootfs closure is empty" >&2
    exit 1
}
node scripts/generate-rootfs-package-manifest.mjs \
    --binaries-dir "$REPO_ROOT/binaries" \
    "${ROOTFS_EAGER_ARGS[@]}" \
    --out "$ROOTFS_PACKAGE_MANIFEST"

WASM_ARTIFACTS=(
    "$REPO_ROOT/binaries/programs/wasm32/$RUBY_REL"
    "$REPO_ROOT/binaries/programs/wasm32/$GIT_REL"
    "$REPO_ROOT/binaries/programs/wasm32/$GIT_REMOTE_HTTP_REL"
    "$REPO_ROOT/binaries/programs/wasm32/$CURL_REL"
    "$REPO_ROOT/binaries/programs/wasm32/$TAR_REL"
    "$REPO_ROOT/binaries/programs/wasm32/$GZIP_REL"
    "$REPO_ROOT/binaries/programs/wasm32/$XZ_REL"
    "$REPO_ROOT/binaries/programs/wasm32/$ZSTD_REL"
    "$REPO_ROOT/binaries/programs/wasm32/$BZIP2_REL"
)
while IFS= read -r rootfs_artifact_path; do
    WASM_ARTIFACTS+=("$REPO_ROOT/$rootfs_artifact_path")
done < <(awk '
    {
        for (i = 1; i <= NF; i++) {
            if ($i ~ /^(lazy_url|src)=binaries\/.*\.wasm$/) {
                path = $i
                sub(/^(lazy_url|src)=/, "", path)
                if (!seen[path]++) print path
            }
        }
    }
' "$ROOTFS_PACKAGE_MANIFEST")
"$REPO_ROOT/host/node_modules/.bin/tsx" scripts/validate-wasm-artifacts.ts \
    --abi "$ABI_VERSION" --profile kernel "$REPO_ROOT/binaries/kernel.wasm"
"$REPO_ROOT/host/node_modules/.bin/tsx" scripts/validate-wasm-artifacts.ts \
    --abi "$ABI_VERSION" --profile program "${WASM_ARTIFACTS[@]}"

node scripts/homebrew-bootstrap-layout.ts \
    --out "$BOOTSTRAP_MANIFEST" \
    --layout-out "$BOOTSTRAP_LAYOUT_REL" \
    --ruby "binaries/programs/wasm32/$RUBY_REL" \
    --ruby-runtime "binaries/programs/wasm32/$RUBY_RUNTIME_REL" \
    --git "binaries/programs/wasm32/$GIT_REL" \
    --git-remote-http "binaries/programs/wasm32/$GIT_REMOTE_HTTP_REL" \
    --curl "binaries/programs/wasm32/$CURL_REL" \
    --tar "binaries/programs/wasm32/$TAR_REL" \
    --gzip "binaries/programs/wasm32/$GZIP_REL" \
    --xz "binaries/programs/wasm32/$XZ_REL" \
    --zstd "binaries/programs/wasm32/$ZSTD_REL" \
    --bzip2 "binaries/programs/wasm32/$BZIP2_REL" \
    --brew-archive "target/homebrew-bootstrap/homebrew-brew.zip" \
    --brew-env "target/homebrew-bootstrap/brew.env" \
    --image-metadata "target/homebrew-bootstrap/homebrew-image.json"

node scripts/write-homebrew-bootstrap-metadata.mjs \
    --source "$BREW_SOURCE_PROVENANCE" \
    --layout "$BOOTSTRAP_LAYOUT" \
    --abi "$ABI_VERSION" \
    --out "$IMAGE_METADATA"

echo "==> Building Homebrew bootstrap image for Kandelo ABI $ABI_VERSION"
node tools/mkrootfs/bin/mkrootfs.mjs build MANIFEST images/rootfs \
    --repo-root "$REPO_ROOT" \
    --manifest-fragment "$ROOTFS_PACKAGE_MANIFEST" \
    --manifest-fragment "$BOOTSTRAP_MANIFEST" \
    --sab-size "$SAB_SIZE" \
    --max-size "$MAX_SIZE" \
    --kernel-abi "$ABI_VERSION" \
    -o "$OUTPUT"

SIZE="$(wc -c < "$OUTPUT" | tr -d ' ')"
echo "==> Built $OUTPUT ($SIZE bytes)"
echo "==> Homebrew $BREW_REVISION ($(node -e 'console.log(require(process.argv[1]).homebrew_archive_sha256)' "$BREW_SOURCE_PROVENANCE"))"
