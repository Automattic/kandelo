#!/usr/bin/env bash
#
# Download and verify Wasm binaries for the release pinned in
# `binaries.lock`. Populates `binaries/` at the repo root.
#
# Consumer code resolves binaries via local-binaries/ → binaries/,
# so this script doesn't touch local-binaries/ (user-built) and
# refuses to overwrite anything there.
#
# Invariants:
#   * binaries/objects/<full-sha256>.<ext> is the canonical store.
#     Every byte in binaries/ comes from there (as a symlink or
#     extracted copy).
#   * manifest.json's sha256 must equal binaries.lock's manifest_sha256.
#   * Every entry's sha256 must verify after download.
#
# Flags:
#   --force       Re-download even if objects/ already has the file.
#   --prune       Delete binaries/objects/ entries not referenced by
#                 the current manifest.
#   --offline     Fail if an object isn't already in objects/ rather
#                 than hitting the network.
#
# Exit codes:
#   0  success
#   1  verification failure (hash mismatch, abi mismatch)
#   2  bad arguments / missing prerequisite tool

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

FORCE=0
PRUNE=0
OFFLINE=0
while [ $# -gt 0 ]; do
    case "$1" in
        --force)   FORCE=1; shift ;;
        --prune)   PRUNE=1; shift ;;
        --offline) OFFLINE=1; shift ;;
        -h|--help)
            sed -n '3,30p' "$0"
            exit 0
            ;;
        *) echo "unknown arg $1" >&2; exit 2 ;;
    esac
done

# --- Prerequisites --------------------------------------------------------
for tool in curl shasum unzip zstd jq; do
    command -v "$tool" >/dev/null 2>&1 || {
        echo "ERROR: $tool not found on PATH" >&2
        exit 2
    }
done

# --- Inputs ----------------------------------------------------------------
LOCK_FILE="$REPO_ROOT/binaries.lock"
[ -f "$LOCK_FILE" ] || { echo "ERROR: $LOCK_FILE not found" >&2; exit 1; }

LOCK_ABI=$(jq -r .abi_version "$LOCK_FILE")
LOCK_TAG=$(jq -r .release_tag "$LOCK_FILE")
LOCK_MANIFEST_SHA=$(jq -r .manifest_sha256 "$LOCK_FILE")

REL_BASE="https://github.com/brandonpayton/wasm-posix-kernel/releases/download/$LOCK_TAG"

BIN_DIR="$REPO_ROOT/binaries"
OBJ_DIR="$BIN_DIR/objects"
mkdir -p "$OBJ_DIR"

echo "fetch-binaries: release=$LOCK_TAG abi=$LOCK_ABI"

# --- Helper: verify a file's sha256 ---------------------------------------
verify_sha() {
    local file="$1" expected="$2"
    local got
    got=$(shasum -a 256 "$file" | awk '{print $1}')
    if [ "$got" != "$expected" ]; then
        echo "ERROR: sha256 mismatch for $file" >&2
        echo "  expected: $expected" >&2
        echo "  got:      $got" >&2
        return 1
    fi
}

# --- Helper: ensure one asset is in objects/ -------------------------------
# Args: <filename-in-release> <expected-sha256>
# Leaves the file at $OBJ_DIR/<sha>.<ext>.
ensure_object() {
    local rel_name="$1" expected_sha="$2"
    local ext="${rel_name##*.}"
    # Handle .vfs.zst (double extension).
    case "$rel_name" in
        *.vfs.zst) ext="vfs.zst" ;;
    esac
    local obj_path="$OBJ_DIR/$expected_sha.$ext"

    if [ -f "$obj_path" ] && [ "$FORCE" = "0" ]; then
        # Already cached. Trust the hash in the filename? No — verify.
        if verify_sha "$obj_path" "$expected_sha" 2>/dev/null; then
            return 0
        fi
        # Corrupted object file; fall through to redownload.
        echo "  (cached $rel_name is corrupt, redownloading)"
        rm -f "$obj_path"
    fi

    if [ "$OFFLINE" = "1" ]; then
        echo "ERROR: offline mode but $rel_name not in cache" >&2
        return 1
    fi

    local tmp="$obj_path.partial"
    echo "  downloading $rel_name..."
    if ! curl -fsSL --retry 3 -o "$tmp" "$REL_BASE/$rel_name"; then
        rm -f "$tmp"
        echo "ERROR: download failed for $rel_name" >&2
        return 1
    fi
    verify_sha "$tmp" "$expected_sha" || { rm -f "$tmp"; return 1; }
    mv "$tmp" "$obj_path"
}

# --- Helper: place an object at a stable path in binaries/ ----------------
# Args: <obj-path-or-decompressed-bytes> <dest-relative-to-binaries>
place() {
    local src="$1" rel_dest="$2"
    local dest="$BIN_DIR/$rel_dest"
    mkdir -p "$(dirname "$dest")"
    # Remove old symlink/file (safe — `binaries/` is gitignored).
    rm -f "$dest"
    # Hard-linking would be ideal (no symlink following surprises),
    # but hard links don't work across different volumes. Prefer
    # symlink + relative path so the directory tree is self-contained.
    local src_abs
    src_abs=$(cd "$(dirname "$src")" && pwd)/"$(basename "$src")"
    ln -s "$src_abs" "$dest"
}

# --- Helper: is this zip only top-level .wasm files? ----------------------
# Multi-binary bundles like diffutils are flat. vim's zip has a nested
# runtime tree and must stay as a zip for lazy-archive consumers.
zip_all_flat_wasm() {
    local zip_file="$1"
    # unzip -Z -1 lists one entry per line (portable across unzip impls).
    local names
    names=$(unzip -Z -1 "$zip_file" 2>/dev/null) || return 1
    [ -n "$names" ] || return 1
    # Every entry must match *.wasm with no slash.
    while IFS= read -r line; do
        [ -z "$line" ] && continue
        case "$line" in
            */*)  return 1 ;;
            *.wasm) ;;
            LICENSE|LICENSE.*) ;; # allow LICENSE at root
            *) return 1 ;;
        esac
    done <<<"$names"
    return 0
}

# --- Helper: extract a flat zip into a destination dir ---------------------
extract_flat_zip() {
    local zip_file="$1" rel_dest_dir="$2"
    local dest_dir="$BIN_DIR/$rel_dest_dir"
    rm -rf "$dest_dir"
    mkdir -p "$dest_dir"
    # unzip -q into the destination.
    unzip -q -o "$zip_file" -d "$dest_dir"
}

# --- Step 1: manifest -----------------------------------------------------
MANIFEST_OBJ="$OBJ_DIR/$LOCK_MANIFEST_SHA.json"
ensure_object "manifest.json" "$LOCK_MANIFEST_SHA"

# Sanity: manifest's abi_version matches binaries.lock.
manifest_abi=$(jq -r .abi_version "$MANIFEST_OBJ")
if [ "$manifest_abi" != "$LOCK_ABI" ]; then
    echo "ERROR: manifest abi_version=$manifest_abi != lock abi_version=$LOCK_ABI" >&2
    exit 1
fi
manifest_tag=$(jq -r .release_tag "$MANIFEST_OBJ")
if [ "$manifest_tag" != "$LOCK_TAG" ]; then
    echo "ERROR: manifest release_tag=$manifest_tag != lock release_tag=$LOCK_TAG" >&2
    exit 1
fi

# Cached alias for consumer introspection.
place "$MANIFEST_OBJ" "manifest.json"

# --- Step 1.5: install package-archive entries via xtask -----------
# Each archive-style entry has archive_name + archive_sha256 +
# compatibility; remote_fetch in xtask handles fetch + verify + install
# into the resolver's canonical cache path. Program archives are also
# mirrored into local-binaries/programs/<arch>/ and (with
# --binaries-dir) symlinked under binaries/programs/<arch>/ so consumer
# Vite imports of `@binaries/programs/<arch>/<x>` resolve through the
# cache.
#
# Legacy zip/wasm-vintage entries (no archive_name) are left for Step
# 2's symlink-into-binaries/ codepath below — that path handles
# kernel/userspace/vfs-image entries which aren't archive-shape.
#
# NOTE: --offline / --force / --prune are NOT propagated into xtask
# install-release. Those flags continue to govern the legacy entry
# path. If you need offline-mode for archive entries, the resolver's
# cache will already serve them on subsequent runs once they've been
# installed.
if jq -e '.entries[] | select(.archive_name != null)' "$MANIFEST_OBJ" > /dev/null 2>&1; then
    if [ "$OFFLINE" = "1" ]; then
        echo "fetch-binaries: skipping archive install (offline mode)"
    else
        HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
        echo "fetch-binaries: installing archives via xtask install-release..."
        cargo run -p xtask --target "$HOST_TARGET" --quiet -- install-release \
            --manifest "$MANIFEST_OBJ" \
            --archive-base "$REL_BASE" \
            --binaries-dir "$BIN_DIR"
    fi
fi

# --- Step 2: download every entry + place it at its stable path -----------
#
# Placement rules:
#   program=kernel       → binaries/kernel.wasm
#   program=userspace    → binaries/userspace.wasm
#   kind=vfs-image       → binaries/vfs/<program>.vfs.zst     (served as-is)
#   kind=program, .wasm  → binaries/programs/<program>.wasm
#   kind=program, .zip   → depends on contents:
#     - vim.zip (has runtime tree): binaries/programs/vim.zip (kept as zip)
#     - multi-binary bundles: extracted to
#       binaries/programs/<program>/<file-in-zip>
#
# Every decision here is driven by what the *consumer* expects to
# find. See docs/binary-releases.md for the rationale.

entry_count=$(jq '.entries | length' "$MANIFEST_OBJ")
echo "fetch-binaries: $entry_count entries"

REFERENCED_SHAS=()
REFERENCED_SHAS+=("$LOCK_MANIFEST_SHA")

for i in $(seq 0 $((entry_count - 1))); do
    entry=$(jq -c ".entries[$i]" "$MANIFEST_OBJ")
    archive_name=$(echo "$entry" | jq -r '.archive_name // empty')
    if [ -n "$archive_name" ]; then
        # archive entry; xtask install-release already handled it above.
        continue
    fi
    name=$(echo "$entry" | jq -r .name)
    kind=$(echo "$entry" | jq -r .kind)
    program=$(echo "$entry" | jq -r .program)
    sha=$(echo "$entry" | jq -r .sha256)

    ensure_object "$name" "$sha"
    obj="$OBJ_DIR/$sha.${name##*.}"
    case "$name" in
        *.vfs.zst) obj="$OBJ_DIR/$sha.vfs.zst" ;;
    esac
    REFERENCED_SHAS+=("$sha")

    case "$kind" in
        kernel)
            place "$obj" "kernel.wasm"
            ;;
        userspace)
            place "$obj" "userspace.wasm"
            ;;
        vfs-image)
            place "$obj" "vfs/$program.vfs.zst"
            ;;
        program)
            case "$name" in
                *.wasm)
                    place "$obj" "programs/$program.wasm"
                    ;;
                *.zip)
                    # Peek at zip contents. If every entry is a
                    # top-level .wasm, extract flat. Otherwise keep
                    # the zip as-is (lazy-archive consumers handle it).
                    if zip_all_flat_wasm "$obj"; then
                        extract_flat_zip "$obj" "programs/$program"
                    else
                        place "$obj" "programs/$program.zip"
                    fi
                    ;;
                *)
                    echo "WARN: unknown extension for $name (kind=$kind), placing as-is"
                    place "$obj" "programs/$name"
                    ;;
            esac
            ;;
        *)
            echo "WARN: unknown kind $kind for $name, skipping"
            ;;
    esac
done

# --- Step 3: prune unreferenced objects -----------------------------------
if [ "$PRUNE" = "1" ]; then
    echo "fetch-binaries: pruning unreferenced objects..."
    # shellcheck disable=SC2207
    referenced_set=$(printf '%s\n' "${REFERENCED_SHAS[@]}" | sort -u)
    removed=0
    for obj in "$OBJ_DIR"/*; do
        [ -f "$obj" ] || continue
        name=$(basename "$obj")
        sha="${name%%.*}"
        if ! echo "$referenced_set" | grep -qx "$sha"; then
            rm -f "$obj"
            removed=$((removed + 1))
        fi
    done
    echo "  removed $removed unreferenced objects"
fi

echo
echo "fetch-binaries: done. Binaries at $BIN_DIR"
echo "  $(find "$BIN_DIR" -maxdepth 3 -type l -o -type f 2>/dev/null | wc -l | tr -d ' ') entries"
