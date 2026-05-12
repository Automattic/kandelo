#!/usr/bin/env bash
#
# prune-staging-release.sh — prune stale per-archive uploads from a
# per-PR staging release so downstream `xtask build-index` sees a
# clean set: exactly one archive per `(name, arch)` at the current ABI.
#
# Why this exists
# ---------------
#
# `pr-<NNN>-staging` releases accumulate state across CI runs of the
# same PR. The `publish` step in `staging-build.yml` and
# `prepare-merge.yml` uploads with `gh release upload --clobber`,
# which only overwrites assets with the *exact same filename*. Two
# common changes between runs leave orphans behind:
#
#   1. ABI bump on main. When a PR rebases across an `ABI_VERSION`
#      bump, every archive from prior runs of this same PR has
#      `abi<old>` in its filename. The next run uploads the
#      `abi<new>` set, but the `abi<old>` set stays — different
#      filenames, so `--clobber` doesn't touch them. `xtask build-index
#      --abi <new>` then refuses every `abi<old>` archive
#      ("filename declares abi<old> but --abi is <new>").
#
#   2. Revision/cache_key churn. When a package's source content
#      changes mid-PR (revision bump, source tweak → new cache_key
#      sha → new filename suffix), the prior archive stays under its
#      old sha-suffixed filename. `build-index` enforces "one
#      `(name, arch)` per index" and fails on the duplicate.
#
# Both have hit PR #423 in succession. The right fix is to prune
# defensively after each `publish` so the state never accumulates.
#
# Production releases (`binaries-abi-v<N>`) are append-only at a
# single ABI and don't have this problem, so this script is scoped
# to `pr-*-staging` tags by design — it refuses to touch anything
# else.
#
# Usage
# -----
#
#     prune-staging-release.sh <tag> <current-abi> <repo>
#
# Where:
#   <tag>           per-PR staging release tag, e.g. `pr-423-staging`.
#   <current-abi>   integer matching `ABI_VERSION` in
#                   `crates/shared/src/lib.rs` for the current commit.
#   <repo>          owner/name slug, e.g. `brandonpayton/wasm-posix-kernel`.
#
# Filename format (per docs/plans/2026-05-05-decoupled-package-builds-design.md §5.3):
#
#     <name>-<version>-rev<R>-abi<A>-<arch>-<sha>.tar.zst
#
# Splitting from the right is unambiguous because version, rev<R>,
# abi<A>, arch, and sha never contain `-`. Names like `mariadb-test`
# or `perl-vfs` parse correctly.
#
# Behavior
# --------
#
#   * Reads asset list (name + updatedAt) from the release.
#   * Drops every archive whose filename declares an ABI other than
#     `<current-abi>`.
#   * Within the surviving set, dedupes by `(name, arch)` keeping the
#     asset with the latest `updatedAt` (matches what `--clobber`
#     just uploaded).
#   * Calls `gh release delete-asset` for each filename to drop.
#   * Exits 0 on success (including the no-op case).

set -euo pipefail

if [ $# -ne 3 ]; then
    echo "usage: $0 <tag> <current-abi> <repo>" >&2
    exit 2
fi

TAG="$1"
CURRENT_ABI="$2"
REPO="$3"

case "$TAG" in
    pr-*-staging) ;;
    *)
        echo "prune-staging-release: refusing to prune non-staging tag '$TAG'" >&2
        echo "  (only pr-*-staging tags are pruned; binaries-abi-v<N> is append-only)" >&2
        exit 0
        ;;
esac

if ! [[ "$CURRENT_ABI" =~ ^[0-9]+$ ]]; then
    echo "prune-staging-release: <current-abi> must be an integer, got '$CURRENT_ABI'" >&2
    exit 2
fi

# Fields produced: name<TAB>version<TAB>rev<TAB>abi<TAB>arch<TAB>sha
parse_archive_name() {
    local base="${1%.tar.zst}"
    local sha=${base##*-};     base=${base%-*}
    local arch=${base##*-};    base=${base%-*}
    local abi=${base##*-};     base=${base%-*}
    local rev=${base##*-};     base=${base%-*}
    local version=${base##*-}; base=${base%-*}
    local name=$base
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$name" "$version" "$rev" "$abi" "$arch" "$sha"
}

# `gh release view --json assets` returns name + updatedAt for each
# asset. Sort ascending by updatedAt so when we walk the list, the
# most recently uploaded copy of any (name, arch) is seen last and
# wins the dedupe.
mapfile -t ASSETS < <(
    gh release view "$TAG" --repo "$REPO" --json assets \
        --jq '.assets[] | select(.name | endswith(".tar.zst")) | "\(.updatedAt)\t\(.name)"' \
        | sort
)

declare -A KEEP
TO_DELETE=()

for line in "${ASSETS[@]:-}"; do
    [ -z "$line" ] && continue
    asset_name=${line#*$'\t'}
    if ! fields=$(parse_archive_name "$asset_name"); then
        echo "prune-staging-release: cannot parse '$asset_name', skipping" >&2
        continue
    fi
    IFS=$'\t' read -r p_name p_version p_rev p_abi p_arch p_sha <<<"$fields"

    if [ "$p_abi" != "abi$CURRENT_ABI" ]; then
        TO_DELETE+=("$asset_name")
        continue
    fi

    key="$p_name"$'\t'"$p_arch"
    if [ -n "${KEEP[$key]:-}" ]; then
        TO_DELETE+=("${KEEP[$key]}")
    fi
    KEEP[$key]="$asset_name"
done

if [ ${#TO_DELETE[@]} -eq 0 ]; then
    echo "prune-staging-release: nothing to prune on $TAG (abi=$CURRENT_ABI, ${#KEEP[@]} kept)"
    exit 0
fi

echo "prune-staging-release: deleting ${#TO_DELETE[@]} stale archive(s) from $TAG (abi=$CURRENT_ABI, keeping ${#KEEP[@]})"
for asset_name in "${TO_DELETE[@]}"; do
    echo "  delete $asset_name"
    gh release delete-asset "$TAG" "$asset_name" --repo "$REPO" --yes >/dev/null
done
