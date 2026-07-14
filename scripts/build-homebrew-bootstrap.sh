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
BREW_PATCH_SHA256="38e23e9ca020dbfcd9903e63c3660ce8a93758c51859b2fb112bc8e477528eba"
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
BOOTSTRAP_MANIFEST="$BUILD_DIR/bootstrap.MANIFEST"
IMAGE_METADATA="$BUILD_DIR/homebrew-image.json"

echo "==> Generating rootfs package manifest"
node scripts/generate-rootfs-package-manifest.mjs \
    --binaries-dir "$REPO_ROOT/binaries" \
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
while IFS= read -r lazy_path; do
    WASM_ARTIFACTS+=("$REPO_ROOT/$lazy_path")
done < <(awk '
    {
        for (i = 1; i <= NF; i++) {
            if ($i ~ /^lazy_url=binaries\/.*\.wasm$/) {
                path = $i
                sub(/^lazy_url=/, "", path)
                if (!seen[path]++) print path
            }
        }
    }
' "$ROOTFS_PACKAGE_MANIFEST")
"$REPO_ROOT/host/node_modules/.bin/tsx" scripts/validate-wasm-artifacts.ts \
    --abi "$ABI_VERSION" --profile kernel "$REPO_ROOT/binaries/kernel.wasm"
"$REPO_ROOT/host/node_modules/.bin/tsx" scripts/validate-wasm-artifacts.ts \
    --abi "$ABI_VERSION" --profile program "${WASM_ARTIFACTS[@]}"

node scripts/write-homebrew-bootstrap-metadata.mjs \
    --source "$BREW_SOURCE_PROVENANCE" \
    --abi "$ABI_VERSION" \
    --out "$IMAGE_METADATA"

cat > "$BOOTSTRAP_MANIFEST" <<EOF
# Generated by scripts/build-homebrew-bootstrap.sh; do not edit.

/home/linuxbrew d 0755 1000 1000
/home/linuxbrew/.linuxbrew d 0755 1000 1000
/home/linuxbrew/.linuxbrew/bin d 0755 1000 1000
/home/linuxbrew/.linuxbrew/etc d 0755 1000 1000
/home/linuxbrew/.linuxbrew/etc/homebrew d 0755 1000 1000
/home/linuxbrew/.linuxbrew/var d 0755 1000 1000
/home/linuxbrew/.linuxbrew/var/homebrew d 0755 1000 1000
/home/linuxbrew/.linuxbrew/var/homebrew/locks d 0755 1000 1000
/home/linuxbrew/.cache d 0755 1000 1000
/home/linuxbrew/.cache/Homebrew d 0755 1000 1000
/home/linuxbrew/.config d 0755 1000 1000
/home/linuxbrew/.config/homebrew d 0755 1000 1000

/etc/homebrew d 0755 0 0
/etc/homebrew/brew.env f 0644 0 0 src=target/homebrew-bootstrap/brew.env
/etc/kandelo d 0755 0 0
/etc/kandelo/homebrew-image.json f 0644 0 0 src=target/homebrew-bootstrap/homebrew-image.json

/usr/bin/ruby f 0755 0 0 src=binaries/programs/wasm32/$RUBY_REL
/usr/bin/git f 0755 0 0 src=binaries/programs/wasm32/$GIT_REL
/usr/bin/git-remote-http f 0755 0 0 src=binaries/programs/wasm32/$GIT_REMOTE_HTTP_REL
/usr/bin/git-remote-https l 0777 0 0 target=/usr/bin/git-remote-http
/usr/bin/curl f 0755 0 0 src=binaries/programs/wasm32/$CURL_REL
/usr/bin/tar f 0755 0 0 src=binaries/programs/wasm32/$TAR_REL
/usr/bin/gzip f 0755 0 0 src=binaries/programs/wasm32/$GZIP_REL
/usr/bin/xz f 0755 0 0 src=binaries/programs/wasm32/$XZ_REL
/usr/bin/zstd f 0755 0 0 src=binaries/programs/wasm32/$ZSTD_REL
/usr/bin/bzip2 f 0755 0 0 src=binaries/programs/wasm32/$BZIP2_REL

/bin/ruby l 0777 0 0 target=/usr/bin/ruby
/bin/git l 0777 0 0 target=/usr/bin/git
/bin/curl l 0777 0 0 target=/usr/bin/curl
/bin/tar l 0777 0 0 target=/usr/bin/tar
/bin/gzip l 0777 0 0 target=/usr/bin/gzip
/bin/xz l 0777 0 0 target=/usr/bin/xz
/bin/zstd l 0777 0 0 target=/usr/bin/zstd
/bin/bzip2 l 0777 0 0 target=/usr/bin/bzip2

/usr/bin/brew l 0777 0 0 target=/home/linuxbrew/.linuxbrew/bin/brew

archive url=target/homebrew-bootstrap/homebrew-brew.zip base=/home/linuxbrew/.linuxbrew fmode=0644 fmode_policy=preserve-executable dmode=0755 uid=1000 gid=1000
archive url=binaries/programs/wasm32/$RUBY_RUNTIME_REL base=/ fmode=0644 dmode=0755 uid=0 gid=0
EOF

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
