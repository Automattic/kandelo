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
#   --force        Re-download even if objects/ already has the file.
#   --prune        Delete binaries/objects/ entries not referenced by
#                  the current manifest.
#   --offline      Fail if an object isn't already in objects/ rather
#                  than hitting the network.
#   --pr <N>       Force PR overlay from pr-<N>-staging. Without this
#                  flag, the script auto-detects the PR via the public
#                  api.github.com /commits/{sha}/pulls endpoint when the
#                  current HEAD belongs to an open PR. Skipped when
#                  binaries.lock.pr already exists locally.
#   --allow-stale  Tolerate manifest entries whose
#                  compatibility.cache_key_sha disagrees with the
#                  locally-computed value: skip them in install-release
#                  and source-build them via `xtask build-deps resolve`
#                  instead of aborting. Used for local package.toml edits
#                  that aren't yet covered by a PR overlay (pre-push,
#                  fork PRs without write access, in-flight WIP).
#
# Exit codes:
#   0  success
#   1  verification failure (hash mismatch, abi mismatch)
#   2  bad arguments / missing prerequisite tool

set -euo pipefail

# Tempfile cleanup: when --allow-stale is used we mktemp a STALE_OUT
# below; install the trap up front (with `${STALE_OUT:-}` guard) so it
# fires even if `cargo install-release` exits non-zero. Matches the
# convention in run-sortix-tests.sh / run-mariadb-tests.sh.
trap '[ -n "${STALE_OUT:-}" ] && rm -f "$STALE_OUT"' EXIT

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

FORCE=0
PRUNE=0
OFFLINE=0
PR_NUMBER=""
ALLOW_STALE=0
while [ $# -gt 0 ]; do
    case "$1" in
        --force)       FORCE=1; shift ;;
        --prune)       PRUNE=1; shift ;;
        --offline)     OFFLINE=1; shift ;;
        --pr)          PR_NUMBER="$2"; shift 2 ;;
        --allow-stale) ALLOW_STALE=1; shift ;;
        -h|--help)
            sed -n '3,38p' "$0"
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

# Consumer's source-of-truth ABI from glue/abi_constants.h (mirrored
# from `crates/shared/src/lib.rs::ABI_VERSION` by check-abi-version.sh).
# When the consumer has bumped past the lockfile's pinned release
# (legitimate state during an ABI-bump PR before a new durable release
# is cut), the archive-install path below is a no-op: every published
# archive's compatibility block lists only `LOCK_ABI` and every
# cache_key_sha was computed against `LOCK_ABI`, so install-release
# would correctly fail per-entry checks. Skipping the archive install
# (not the check inside install-release, which stays strict) lets
# staging-build proceed to source-build the ABI-current binaries.
CONSUMER_ABI=""
if [ -f "$REPO_ROOT/glue/abi_constants.h" ]; then
    CONSUMER_ABI=$(awk '/^#define WASM_POSIX_ABI_VERSION / {sub(/u$/,"",$3); print $3}' "$REPO_ROOT/glue/abi_constants.h")
fi

REL_BASE="https://github.com/brandonpayton/wasm-posix-kernel/releases/download/$LOCK_TAG"

BIN_DIR="$REPO_ROOT/binaries"
OBJ_DIR="$BIN_DIR/objects"
mkdir -p "$OBJ_DIR"

echo "fetch-binaries: release=$LOCK_TAG abi=$LOCK_ABI"

# --- Optional overlay (PR staging) ---------------------------------------
# When binaries.lock.pr exists at the repo root, fetch-binaries splits
# archive installation into two passes: durable entries minus overrides,
# and staging-release entries for overrides only. See
# docs/plans/2026-04-29-pr-package-builds-design.md §3.
OVERLAY_FILE="$REPO_ROOT/binaries.lock.pr"
OVERLAY_TAG=""
OVERLAY_MANIFEST_SHA=""
OVERLAY_OVERRIDES_JSON="[]"
OVERLAY_REL_BASE=""
OVERLAY_MANIFEST_OBJ=""

# --- PR auto-detect + overlay download -----------------------------------
# When --pr <N> is not given and no binaries.lock.pr is on disk, query
# the public GitHub API to find the PR (if any) for the current HEAD.
OWNER_REPO=""
auto_detect_pr() {
    # Echoes PR number on stdout, or empty if not found.
    # Sets OWNER_REPO as a side effect.
    local origin head_sha pulls_json pr_num
    origin=$(git -C "$REPO_ROOT" config --get remote.origin.url 2>/dev/null) || return 0
    head_sha=$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null) || return 0
    case "$origin" in
        git@github.com:*)        OWNER_REPO="${origin#git@github.com:}";   OWNER_REPO="${OWNER_REPO%.git}" ;;
        https://github.com/*)    OWNER_REPO="${origin#https://github.com/}"; OWNER_REPO="${OWNER_REPO%.git}" ;;
        *) return 0 ;;
    esac
    [ -z "$OWNER_REPO" ] && return 0
    case "$OWNER_REPO" in */*) ;; *) OWNER_REPO=""; return 0 ;; esac

    if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
        pulls_json=$(gh api "repos/$OWNER_REPO/commits/$head_sha/pulls" 2>/dev/null) || return 0
    else
        pulls_json=$(curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL \
            -H "Accept: application/vnd.github+json" \
            "https://api.github.com/repos/$OWNER_REPO/commits/$head_sha/pulls" 2>/dev/null) || return 0
    fi
    pr_num=$(echo "$pulls_json" | jq -r '[.[] | select(.state=="open")][0].number // empty' 2>/dev/null)
    echo "$pr_num"
}

if [ -z "$PR_NUMBER" ] && [ ! -f "$OVERLAY_FILE" ]; then
    PR_NUMBER=$(auto_detect_pr || true)
    [ -n "$PR_NUMBER" ] && echo "fetch-binaries: detected PR #$PR_NUMBER"
fi

if [ -n "$PR_NUMBER" ] && [ ! -f "$OVERLAY_FILE" ]; then
    # Need OWNER_REPO populated. If --pr was passed explicitly without
    # going through auto_detect_pr, derive it now from origin.
    if [ -z "$OWNER_REPO" ]; then
        origin_url=$(git -C "$REPO_ROOT" config --get remote.origin.url 2>/dev/null || true)
        case "$origin_url" in
            git@github.com:*)     OWNER_REPO="${origin_url#git@github.com:}";   OWNER_REPO="${OWNER_REPO%.git}" ;;
            https://github.com/*) OWNER_REPO="${origin_url#https://github.com/}"; OWNER_REPO="${OWNER_REPO%.git}" ;;
        esac
    fi
    if [ -n "$OWNER_REPO" ]; then
        STAGING_TAG_GUESS="pr-${PR_NUMBER}-staging"
        STAGING_BASE="https://github.com/$OWNER_REPO/releases/download/$STAGING_TAG_GUESS"
        echo "fetch-binaries: downloading overlay from $STAGING_TAG_GUESS..."
        # Prefer `gh release download` over curl for the overlay file:
        # the release-asset CDN aggressively caches by URL path, so a
        # maintainer-side re-publish (or a freshly-rebuilt staging
        # release on a PR push) can be silently masked by curl. The
        # GitHub API call that gh uses bypasses the CDN.
        downloaded=0
        if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
            if gh release download "$STAGING_TAG_GUESS" \
                    --repo "$OWNER_REPO" \
                    --pattern binaries.lock.pr \
                    --output "$OVERLAY_FILE.partial" \
                    --clobber >/dev/null 2>&1; then
                mv "$OVERLAY_FILE.partial" "$OVERLAY_FILE"
                downloaded=1
            else
                rm -f "$OVERLAY_FILE.partial"
            fi
        fi
        if [ "$downloaded" = "0" ]; then
            if curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL --retry 2 -o "$OVERLAY_FILE.partial" "$STAGING_BASE/binaries.lock.pr"; then
                mv "$OVERLAY_FILE.partial" "$OVERLAY_FILE"
            else
                rm -f "$OVERLAY_FILE.partial"
                echo "fetch-binaries: no overlay at $STAGING_TAG_GUESS (PR may not have a staging release yet); falling back to durable release"
            fi
        fi
    fi
fi

if [ -f "$OVERLAY_FILE" ]; then
    OVERLAY_TAG=$(jq -r .staging_tag "$OVERLAY_FILE")
    OVERLAY_MANIFEST_SHA=$(jq -r .staging_manifest_sha256 "$OVERLAY_FILE")
    OVERLAY_OVERRIDES_JSON=$(jq -c .overrides "$OVERLAY_FILE")
    [ "$OVERLAY_TAG" = "null" ] && { echo "ERROR: overlay missing staging_tag" >&2; exit 1; }
    [ "$OVERLAY_MANIFEST_SHA" = "null" ] && { echo "ERROR: overlay missing staging_manifest_sha256" >&2; exit 1; }
    [ "$OVERLAY_OVERRIDES_JSON" = "null" ] && { echo "ERROR: overlay missing overrides" >&2; exit 1; }
    OVERLAY_REL_BASE="https://github.com/brandonpayton/wasm-posix-kernel/releases/download/$OVERLAY_TAG"
    echo "fetch-binaries: overlay tag=$OVERLAY_TAG ($(echo "$OVERLAY_OVERRIDES_JSON" | jq 'length') overrides)"
fi

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
    if ! curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL --retry 3 -o "$tmp" "$REL_BASE/$rel_name"; then
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

# --- Step 1.25: overlay manifest (if any) --------------------------------
# Fetch + verify the staging manifest the same way as the durable one.
# Reuse ensure_object by temporarily swapping REL_BASE.
if [ -n "$OVERLAY_TAG" ]; then
    OVERLAY_MANIFEST_OBJ="$OBJ_DIR/$OVERLAY_MANIFEST_SHA.json"
    REL_BASE_SAVE="$REL_BASE"
    REL_BASE="$OVERLAY_REL_BASE"
    ensure_object "manifest.json" "$OVERLAY_MANIFEST_SHA"
    REL_BASE="$REL_BASE_SAVE"
    overlay_abi=$(jq -r .abi_version "$OVERLAY_MANIFEST_OBJ")
    # An overlay represents archives staged by the current PR. During an
    # ABI-bump-in-flight (CONSUMER_ABI ahead of LOCK_ABI before a new
    # durable release is cut), the overlay legitimately disagrees with
    # the lockfile while still matching the consumer. The invariant is
    # `overlay_abi == consumer_abi`, not `overlay_abi == lock_abi`. Fall
    # back to LOCK_ABI when CONSUMER_ABI is unavailable (preserves the
    # original check for callers that don't expose abi_constants.h).
    expected_overlay_abi="${CONSUMER_ABI:-$LOCK_ABI}"
    if [ "$overlay_abi" != "$expected_overlay_abi" ]; then
        echo "ERROR: overlay manifest abi=$overlay_abi != consumer abi=$expected_overlay_abi" >&2
        exit 1
    fi
fi

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

        # Durable install: skip when the consumer's ABI is ahead of the
        # lockfile's pinned release (legitimate state during an ABI-bump
        # PR before a new durable release is cut). The strict
        # cache_key_sha check inside install-release stays valid; this
        # branch just doesn't invoke it across ABI generations. Overlay
        # archives — which were built at the consumer's ABI by the
        # staging-build workflow — still install below.
        SKIP_DURABLE=0
        if [ -n "$CONSUMER_ABI" ] && [ "$CONSUMER_ABI" != "$LOCK_ABI" ]; then
            SKIP_DURABLE=1
        fi

        DURABLE_FILTERED=""

        # Set up --allow-stale plumbing once, outside the SKIP_DURABLE
        # branching, so both the durable and overlay install-release
        # passes get the same flags. install-release writes the names
        # of skipped entries (cache_key_sha mismatches against the
        # consumer's package.toml) to STALE_OUT; we source-build those
        # via `xtask build-deps resolve` after each pass. The trap
        # set up earlier in this script removes STALE_OUT on exit.
        EXTRA_FLAGS=()
        if [ "$ALLOW_STALE" -eq 1 ]; then
            STALE_OUT="$(mktemp -t fetch-binaries-stale.XXXXXX.json)"
            EXTRA_FLAGS+=(--allow-stale-manifest --stale-out "$STALE_OUT")
        fi

        # Truncate STALE_OUT after each install-release pass so the
        # next pass starts with a clean slate. local-binaries/ — the
        # eventual home of the source-built outputs — is what the
        # Vite resolver and downstream consumers prefer over
        # binaries/, so this transparently picks up locally-built
        # artifacts while binaries/ stays pinned to the release tag.
        process_stale_out() {
            [ "$ALLOW_STALE" -eq 1 ] && [ -s "$STALE_OUT" ] || return 0
            local stale_count
            stale_count=$(jq 'length' "$STALE_OUT")
            [ "$stale_count" -gt 0 ] || { : > "$STALE_OUT"; return 0; }
            echo "fetch-binaries: $stale_count package(s) had stale manifests; source-building locally..."
            # Per-entry tolerance matches `--allow-stale`'s stated design
            # (PR #385): "lets CI keep functioning by skipping stale
            # entries during fetch and source-building them via xtask
            # build-deps resolve." Aborting the loop on the first source-
            # build failure would defeat that — one stuck package (e.g. a
            # consumer with stale `[binary]` URLs that fall back to a
            # source build the runner can't perform) would block every
            # subsequent entry. Track failures and surface them at the
            # end so the operator still sees what didn't build.
            local failed=()
            while IFS= read -r entry; do
                local program arch
                program=$(echo "$entry" | jq -r .program)
                arch=$(echo "$entry" | jq -r .arch)
                echo "  - $program ($arch)"
                if ! cargo run -p xtask --target "$HOST_TARGET" --quiet -- \
                        build-deps --arch "$arch" resolve "$program"; then
                    echo "fetch-binaries: WARN $program ($arch) source-build failed; continuing under --allow-stale" >&2
                    failed+=("$program ($arch)")
                fi
            done < <(jq -c '.[]' "$STALE_OUT")
            if [ ${#failed[@]} -gt 0 ]; then
                echo "fetch-binaries: source-build complete with ${#failed[@]} failure(s): ${failed[*]}" >&2
                echo "fetch-binaries: failed packages stay at the durable-release version in binaries/." >&2
            else
                echo "fetch-binaries: source-build complete. binaries/ remains pinned to $LOCK_TAG."
            fi
            : > "$STALE_OUT"
        }

        if [ "$SKIP_DURABLE" = "1" ]; then
            echo "fetch-binaries: consumer abi=$CONSUMER_ABI != lock abi=$LOCK_ABI — skipping durable archive install"
            echo "fetch-binaries: a new durable release at abi=$CONSUMER_ABI must be cut after this PR merges; overlay archives + source-build cover the gap"
        else
            # Compute filtered manifests when an overlay is in play.
            # Filter unit is (.program, .arch) — derived from the overlay
            # manifest's actual entries. A staging build that produced
            # only wasm32 archives for a given program leaves the wasm64
            # archive coming from the durable release, rather than
            # silently dropping it (which happened when overrides was a
            # flat program-name list and we filtered both arches out).
            DURABLE_MANIFEST="$MANIFEST_OBJ"
            if [ -n "$OVERLAY_TAG" ]; then
                DURABLE_FILTERED=$(mktemp -t fetch-binaries-durable.XXXXXX).json
                # Build [{program, arch}, ...] set from overlay manifest.
                OVERLAY_SET=$(jq -c '[.entries[] | {program, arch}]' "$OVERLAY_MANIFEST_OBJ")
                jq --argjson set "$OVERLAY_SET" '
                    .entries |= map(select(
                        . as $e
                        | $set
                        | any(.program == $e.program and .arch == $e.arch)
                        | not
                    ))
                ' "$MANIFEST_OBJ" > "$DURABLE_FILTERED"
                DURABLE_MANIFEST="$DURABLE_FILTERED"
            fi

            echo "fetch-binaries: installing archives via xtask install-release..."
            cargo run -p xtask --target "$HOST_TARGET" --quiet -- install-release \
                --manifest "$DURABLE_MANIFEST" \
                --archive-base "$REL_BASE" \
                --binaries-dir "$BIN_DIR" \
                ${EXTRA_FLAGS[@]+"${EXTRA_FLAGS[@]}"}

            # Source-build durable-pass stale entries here so the
            # cache is warm before the overlay install-release runs.
            process_stale_out
        fi

        # Overlay install runs independently of the durable-skip decision.
        # Overlay archives carry abi_versions matching the consumer (verified
        # against `expected_overlay_abi` in Step 1.25 above), so install-release
        # passes its per-entry compatibility checks against the consumer's ABI.
        if [ -n "$OVERLAY_TAG" ]; then
            echo "fetch-binaries: installing overlay archives from $OVERLAY_TAG..."
            cargo run -p xtask --target "$HOST_TARGET" --quiet -- install-release \
                --manifest "$OVERLAY_MANIFEST_OBJ" \
                --archive-base "$OVERLAY_REL_BASE" \
                --binaries-dir "$BIN_DIR" \
                ${EXTRA_FLAGS[@]+"${EXTRA_FLAGS[@]}"}
            # Overlay-pass stale entries are rare (overlay is built
            # from the developer's package.toml at PR-build time) but can
            # appear if the developer made further local edits past
            # their last CI build.
            process_stale_out
        fi

        [ -n "$DURABLE_FILTERED" ] && rm -f "$DURABLE_FILTERED"
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
