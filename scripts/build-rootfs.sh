#!/usr/bin/env bash
set -euo pipefail

rootfs_default_install=""
if [ "$#" -ne 0 ]; then
    if [ "$#" -ne 2 ] || [ "$1" != "--default-install" ]; then
        echo "usage: scripts/build-rootfs.sh [--default-install <lazy|eager>]" >&2
        exit 2
    fi
    case "$2" in
        lazy|eager) rootfs_default_install="$2" ;;
        *)
            echo 'build-rootfs: --default-install must be either "lazy" or "eager"' >&2
            exit 2
            ;;
    esac
fi

# Build the canonical rootfs.vfs image from the top-level MANIFEST +
# images/rootfs/ source tree, using the mkrootfs CLI under tools/mkrootfs/.
# Output defaults to host/wasm/rootfs.vfs (gitignored — built artifact).
#
# This is a Node.js/TypeScript invocation, not a wasm cross-compile,
# so it does not need scripts/dev-shell.sh — only `node` and `npx`
# from PATH (npx pulls tsx via the host package's devDeps).

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# shellcheck source=build-step-input-hash.sh
source "$REPO_ROOT/scripts/build-step-input-hash.sh"

OUT="${ROOTFS_OUT:-host/wasm/rootfs.vfs}"
STAMP="$OUT.input-hash"

# Resolve the manifest path, source-tree path, and target kernel ABI version
# BEFORE computing the input digest below. All three are overridable via env
# vars (ROOTFS_MANIFEST, ROOTFS_SOURCE_TREE, ROOTFS_ABI_VERSION) that this
# script's own invocation of mkrootfs (further down) actually consumes, so
# the digest must track the RESOLVED value, not the literal default —
# otherwise a caller that overrides one of these while still writing to the
# default $ROOTFS_OUT would get a false "up to date" skip against a
# rootfs.vfs built from different inputs.
ROOTFS_MANIFEST_PATH="${ROOTFS_MANIFEST:-MANIFEST}"
ROOTFS_SOURCE_TREE_PATH="${ROOTFS_SOURCE_TREE:-images/rootfs}"
if [ -n "${ROOTFS_ABI_VERSION:-}" ]; then
    ABI_VERSION="$ROOTFS_ABI_VERSION"
else
    ABI_VERSION="$(sed -nE 's/^pub const ABI_VERSION: u32 = ([0-9]+);$/\1/p' crates/shared/src/lib.rs)"
fi
if [ -z "$ABI_VERSION" ]; then
    echo "ERROR: could not read ABI_VERSION from crates/shared/src/lib.rs" >&2
    exit 1
fi
case "$ABI_VERSION" in
    *[!0-9]*)
        echo "ERROR: ROOTFS_ABI_VERSION must be a non-negative integer" >&2
        exit 2
        ;;
esac
if [ -n "${ROOTFS_ABI_SNAPSHOT_SHA256:-}" ] &&
   ! printf '%s' "$ROOTFS_ABI_SNAPSHOT_SHA256" | grep -Eq '^[0-9a-f]{64}$'; then
    echo "ERROR: ROOTFS_ABI_SNAPSHOT_SHA256 must be lowercase SHA-256" >&2
    exit 2
fi

PKG_MANIFEST="${ROOTFS_PACKAGE_MANIFEST:-target/rootfs-packages.MANIFEST}"
ROOTFS_SAB_SIZE="${ROOTFS_SAB_SIZE:-16777216}"
ROOTFS_MAX_SIZE="${ROOTFS_MAX_SIZE:-268435456}"
ROOTFS_PACKAGES="${ROOTFS_PACKAGES_CONFIG:-images/rootfs/PACKAGES.toml}"
ROOTFS_BUILD_REPO_ROOT="${ROOTFS_REPO_ROOT:-$REPO_ROOT}"

generator_args=(
    --packages "$ROOTFS_PACKAGES"
    --out "$PKG_MANIFEST"
)
if [ -n "$rootfs_default_install" ]; then
    generator_args+=(--default-install "$rootfs_default_install")
fi
# With none of these, the generator asks the repository's binary resolver for
# every output -- the resolver the hosts serve lazy outputs from. These three
# are the package system's sealed inputs (see packages/registry/rootfs).
resolver_mode=1
if [ "${ROOTFS_STAGE_RESOLVER_BINARIES:-0}" = "1" ]; then
    [ -n "${ROOTFS_BINARIES_DIR:-}" ] || {
        echo "build-rootfs: ROOTFS_BINARIES_DIR is required for resolver staging" >&2
        exit 2
    }
    generator_args+=(--stage-resolver-binaries "$ROOTFS_BINARIES_DIR")
    resolver_mode=0
elif [ -n "${ROOTFS_BINARIES_DIR:-}" ]; then
    generator_args+=(--binaries-dir "$ROOTFS_BINARIES_DIR")
    resolver_mode=0
elif [ -n "${ROOTFS_RESOLVED_OUTPUT_MAP:-}" ]; then
    generator_args+=(--resolved-output-map "$ROOTFS_RESOLVED_OUTPUT_MAP")
    resolver_mode=0
fi

generate_package_fragment() {
    node scripts/generate-rootfs-package-manifest.mjs "${generator_args[@]}"
}

# The exact input set for host/wasm/rootfs.vfs.
#
# The package binaries enter through the generated fragment ($PKG_MANIFEST):
# it records a SHA-256 for every output it resolved (`lazy_sha256=` on a lazy
# line, a `# <path> sha256=` line above an eager one), so hashing the fragment
# hashes exactly the bytes the image is built from, wherever the resolver found
# them. This replaced hashing the local build's projection file as a stand-in:
# that covered one tier only, so a binary the image took from any other tier,
# or a leftover file that shadowed the local build, could change without the
# stamp noticing. The fragment also carries the package mapping and the
# `--default-install` choice, which the old input list omitted.
#
# `crates/shared/src/lib.rs` is hashed directly too (harmless
# over-inclusion) even though only its `ABI_VERSION` line matters here — the
# `literal:ABI_VERSION=...` entry is what actually captures the RESOLVED ABI
# value the build below uses, including an `ROOTFS_ABI_VERSION` override
# that never touches `lib.rs`.
#
# The fragment is an ordinary path argument: the shared helper hashes it like
# any other input (an absolute path, as the package build passes, works too).
rootfs_input_hash() {
    repo_input_hash "$REPO_ROOT" \
        "$PKG_MANIFEST" \
        "$ROOTFS_MANIFEST_PATH" \
        "$ROOTFS_SOURCE_TREE_PATH" \
        tools/mkrootfs/src \
        host/src/vfs/memory-fs.ts \
        host/src/vfs/zip.ts \
        scripts/build-rootfs.sh \
        scripts/generate-rootfs-package-manifest.mjs \
        scripts/build-step-input-hash.sh \
        crates/shared/src/lib.rs \
        "literal:ABI_VERSION=$ABI_VERSION"
}

# Up-to-date check. Resolution is cheap (one resolver call) and is the only way
# to learn which bytes an image built NOW would contain, so it runs first; the
# package provisioning below (about 20 s even when every package is cached)
# runs only when the image must be rebuilt. If resolution fails here (a package
# not built yet), the image is simply not current: provisioning follows, and
# the generator runs again and reports the failure loudly if it persists. The
# sealed package modes are one-shot builds into fresh directories, so they
# skip this.
if [ "$resolver_mode" = 1 ] &&
   [ "${KANDELO_BOOTSTRAP_FORCE_REBUILD:-0}" != "1" ] &&
   generate_package_fragment >/dev/null 2>&1; then
    ROOTFS_INPUT_HASH="$(rootfs_input_hash)"
    if build_step_is_current "$OUT" "$STAMP" "$ROOTFS_INPUT_HASH"; then
        echo "==> rootfs.vfs up to date ($ROOTFS_INPUT_HASH)"
        exit 0
    fi
fi

# Resolver-owned package builds must be read-only with respect to the source
# checkout. Their CI callers install the repository's locked JavaScript
# dependencies before invoking the package resolver.
if [ "${ROOTFS_SEALED_BUILD:-0}" = "1" ]; then
    for tool in \
        node_modules/tsx/dist/cli.mjs \
        node_modules/fflate \
        node_modules/fzstd; do
        [ -e "$tool" ] || {
            echo "build-rootfs: sealed build requires locked root dependency $tool" >&2
            echo "build-rootfs: install the repository's locked JavaScript" >&2
            echo "build-rootfs: dependencies first:  npm ci  (at the repo root)" >&2
            echo "build-rootfs: note \`npm --prefix host install\` is NOT enough --" >&2
            echo "build-rootfs: this tool is a ROOT dependency, not a host/ one." >&2
            exit 2
        }
    done
else
    # Direct developer builds retain the convenient legacy bootstrap.
    if [ ! -d host/node_modules ]; then
        echo "==> Installing host/ dependencies (needed by mkrootfs)..."
        (cd host && npm ci --no-audit --no-fund --prefer-offline --silent)
    fi
    if [ ! -d tools/mkrootfs/node_modules ]; then
        echo "==> Installing tools/mkrootfs/ dependencies..."
        (cd tools/mkrootfs && npm ci --no-audit --no-fund --prefer-offline --silent)
    fi
fi

mkdir -p "$(dirname "$OUT")"

# Provisioning, not lookup: this materializes the `binaries/` tier (a checkout
# that fetched release archives has nothing else). Which copy of a package the
# image then records is the resolver's decision alone, made by the generator
# below; a local build's tier outranks `binaries/` there, exactly as it does
# when the hosts serve the bytes.
if [ "${ROOTFS_SKIP_PACKAGE_RESOLVE:-0}" != "1" ]; then
    for tool in cargo rustc; do
        command -v "$tool" >/dev/null 2>&1 || {
            echo "build-rootfs: $tool not found on PATH" >&2
            exit 2
        }
    done
    HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
    [ -n "$HOST_TARGET" ] || {
        echo "build-rootfs: rustc -vV did not report host triple" >&2
        exit 2
    }

    echo "==> Resolving rootfs packages from $ROOTFS_PACKAGES..."
    awk '
        /^\[\[packages\]\]/ { in_pkg = 1; next }
        /^\[/ { in_pkg = 0; next }
        in_pkg && /^name[[:space:]]*=/ {
            line = $0
            sub(/^[^=]*=[[:space:]]*/, "", line)
            gsub(/["[:space:]]/, "", line)
            if (line != "" && !seen[line]++) print line
        }
    ' "$ROOTFS_PACKAGES" | while IFS= read -r pkg; do
        echo "  resolve $pkg (wasm32)"
        cargo run --release -p xtask --target "$HOST_TARGET" --quiet -- \
            build-deps --arch wasm32 --binaries-dir "$REPO_ROOT/binaries" \
            resolve "$pkg" >/dev/null
    done
else
    echo "==> Skipping package resolution (ROOTFS_SKIP_PACKAGE_RESOLVE=1)"
fi

echo "==> Generating rootfs package manifest from $ROOTFS_PACKAGES..."
generate_package_fragment
ROOTFS_INPUT_HASH="$(rootfs_input_hash)"

echo "==> Building rootfs.vfs from MANIFEST + images/rootfs/ + packages..."
if [ "${ROOTFS_SEALED_BUILD:-0}" = "1" ]; then
    # WHY: the wrapper uses npx, which is allowed to install missing tools.
    # Package builds instead execute the already-installed lockfile version so
    # an undeclared network fetch can never become build authority.
    ROOTFS_TSX_TMP="$(mktemp -d /tmp/kandelo-rootfs.XXXXXX)"
    trap 'rm -rf -- "$ROOTFS_TSX_TMP"' EXIT
    mkrootfs=(env TMPDIR="$ROOTFS_TSX_TMP" node node_modules/tsx/dist/cli.mjs tools/mkrootfs/src/index.ts)
else
    mkrootfs=(node tools/mkrootfs/bin/mkrootfs.mjs)
fi
metadata_args=(--kernel-abi "$ABI_VERSION")
if [ -n "${ROOTFS_ABI_SNAPSHOT_SHA256:-}" ]; then
    metadata_args+=(--abi-snapshot-sha256 "$ROOTFS_ABI_SNAPSHOT_SHA256")
fi
"${mkrootfs[@]}" build "$ROOTFS_MANIFEST_PATH" "$ROOTFS_SOURCE_TREE_PATH" \
    -o "$OUT" \
    --repo-root "$ROOTFS_BUILD_REPO_ROOT" \
    --manifest-fragment "$PKG_MANIFEST" \
    --sab-size "$ROOTFS_SAB_SIZE" \
    --max-size "$ROOTFS_MAX_SIZE" \
    "${metadata_args[@]}"

SIZE=$(wc -c < "$OUT" | tr -d ' ')
echo "==> Built $OUT ($SIZE bytes)"

# Record the stamp only after a successful build, so a failed/interrupted
# build never leaves behind a stamp that would make a broken/stale output
# look up to date on the next run.
write_build_stamp "$STAMP" "$ROOTFS_INPUT_HASH"
