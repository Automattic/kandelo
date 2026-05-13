#!/usr/bin/env bash
#
# Verify that every `archive_url` declared in any
# `examples/libs/*/package.toml` points at the expected release tag.
#
# prepare-merge.yml runs this in `merge-gate-empty-matrix` and
# `merge-gate-finalize` to catch the failure mode that bit #439:
# preflight saw all `cache_key_sha`s already on `target_tag` (because
# an earlier abandoned run had pre-populated it) → matrices empty →
# amend-package-toml never ran → the PR merged with kernel at ABI N+1
# but `package.toml` URLs still pointing at v_N. The resolver then
# rejects every v_N archive on the post-merge `main` with
# `abi mismatch: kernel ABI N+1, archive supports [N]` and the
# project unhelpfully fails to build until someone re-amends.
#
# Detect-and-fail rather than auto-fix because the recovery (downloading
# every archive from the durable release and recomputing sha256s) is
# heavy enough to deserve a human in the loop; CI just needs to refuse
# to merge a manifest that's known-broken.
#
# Usage:
#   check-package-toml-tags.sh <expected-tag>
#
# Example:
#   check-package-toml-tags.sh binaries-abi-v8
#
# Exits 0 if every URL points at <expected-tag>. Exits 1 (and prints
# the stale list) otherwise.

set -euo pipefail

if [ "$#" -ne 1 ] || [ -z "${1:-}" ]; then
    echo "usage: $0 <expected-tag>" >&2
    exit 2
fi
EXPECTED_TAG="$1"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIBS_DIR="$REPO_ROOT/examples/libs"
[ -d "$LIBS_DIR" ] || { echo "check-package-toml-tags: $LIBS_DIR not found" >&2; exit 2; }

stale_count=0
stale_lines=""

for ptoml in "$LIBS_DIR"/*/package.toml; do
    pkg=$(basename "$(dirname "$ptoml")")
    while IFS= read -r url; do
        [ -n "$url" ] || continue
        # Extract the tag segment between `releases/download/` and the
        # next `/`. Anything else (relative path, file://, etc.) skips.
        tag=$(echo "$url" | sed -nE 's|.*/releases/download/([^/]+)/.*|\1|p')
        [ -n "$tag" ] || continue
        if [ "$tag" != "$EXPECTED_TAG" ]; then
            stale_count=$((stale_count + 1))
            stale_lines="${stale_lines}  $pkg: $tag (expected $EXPECTED_TAG)
"
        fi
    done < <(grep -E '^archive_url *=' "$ptoml" 2>/dev/null | sed -E 's/^archive_url *= *"([^"]+)".*$/\1/')
done

if [ "$stale_count" -gt 0 ]; then
    echo "check-package-toml-tags: $stale_count package.toml URL(s) do not point at $EXPECTED_TAG:" >&2
    printf '%s' "$stale_lines" >&2
    echo "" >&2
    echo "This typically means a prior prepare-merge run published archives to" >&2
    echo "$EXPECTED_TAG but its amend-package-toml job was skipped (e.g., empty" >&2
    echo "matrices because the cache was pre-populated), leaving package.toml" >&2
    echo "URLs pinned to an older release. Re-amend (run xtask set-package-binary" >&2
    echo "for each stale (package, arch), pointing at the corresponding archive" >&2
    echo "in $EXPECTED_TAG) and push to this PR." >&2
    exit 1
fi

echo "check-package-toml-tags: all package.toml URLs point at $EXPECTED_TAG"
