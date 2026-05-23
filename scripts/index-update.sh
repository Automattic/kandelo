#!/usr/bin/env bash
# scripts/index-update.sh — atomic per-package update of a release's
# index.toml.
#
# Called by per-package matrix-build jobs (Phase 10) after the archive
# has been built and ready to publish. Sequence:
#
#   1. Acquire state-lock for the target tag (refs/heads/github-actions/
#      state-lock/<target-tag>). Serialises all per-package updates
#      writing to the SAME release's index.toml; updates to a DIFFERENT
#      target tag don't contend.
#   2. Download the current index.toml from the release (or bootstrap an
#      empty one if the release has none yet).
#   3. Run `xtask index-update` to apply the success-or-failed mutation
#      in-place on the downloaded copy.
#   4. Upload the staged archive + the mutated index.toml back to the
#      release (--clobber on both so re-runs are idempotent).
#   5. Release the state-lock (also on failure via EXIT trap).
#
# Usage:
#   bash scripts/index-update.sh \
#     --target-tag binaries-abi-v8 \
#     --package mariadb \
#     --version 10.5.28 \
#     --revision 1 \
#     --arch wasm32 \
#     --status success \
#     --archive-path "$RUNNER_TEMP/staged/mariadb-...-wasm32-abc12345.tar.zst" \
#     --archive-name "mariadb-...-wasm32-abc12345.tar.zst" \
#     --cache-key-sha abc12345...
#
# For --status failed, omit --archive-path/--archive-name/--cache-key-sha
# and pass --error "<text>" instead.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

TARGET_TAG=""
PACKAGE=""
VERSION=""
REVISION=""
ARCH=""
STATUS=""
ARCHIVE_PATH=""
ARCHIVE_NAME=""
CACHE_KEY_SHA=""
ERROR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target-tag)    TARGET_TAG="$2"; shift 2 ;;
    --package)       PACKAGE="$2"; shift 2 ;;
    --version)       VERSION="$2"; shift 2 ;;
    --revision)      REVISION="$2"; shift 2 ;;
    --arch)          ARCH="$2"; shift 2 ;;
    --status)        STATUS="$2"; shift 2 ;;
    --archive-path)  ARCHIVE_PATH="$2"; shift 2 ;;
    --archive-name)  ARCHIVE_NAME="$2"; shift 2 ;;
    --cache-key-sha) CACHE_KEY_SHA="$2"; shift 2 ;;
    --error)         ERROR="$2"; shift 2 ;;
    *)
      echo "index-update.sh: unknown flag $1" >&2
      exit 2
      ;;
  esac
done

require() {
  local name="$1" value="$2"
  if [ -z "$value" ]; then
    echo "index-update.sh: --$name is required" >&2
    exit 2
  fi
}

require target-tag    "$TARGET_TAG"
require package       "$PACKAGE"
require version       "$VERSION"
require revision      "$REVISION"
require arch          "$ARCH"
require status        "$STATUS"

# Lets state-lock.sh distinguish a live same-run matrix owner from a
# completed same-run job that failed to release the lock after an upload
# or token error.
export STATE_LOCK_OWNER_DETAIL="${STATE_LOCK_OWNER_DETAIL:-${PACKAGE}, ${ARCH}}"

case "$STATUS" in
  success)
    require archive-path  "$ARCHIVE_PATH"
    require archive-name  "$ARCHIVE_NAME"
    require cache-key-sha "$CACHE_KEY_SHA"
    if [ ! -f "$ARCHIVE_PATH" ]; then
      echo "index-update.sh: --archive-path $ARCHIVE_PATH is not a file" >&2
      exit 2
    fi
    ;;
  failed)
    require error "$ERROR"
    ;;
  *)
    echo "index-update.sh: --status must be success or failed, got $STATUS" >&2
    exit 2
    ;;
esac

# 1. Acquire the state-lock for this target tag. Same script that
#    serialises durable-release publishes; the per-target-tag subject
#    keeps independent rebuilds (e.g. abi-v8 vs abi-v9) from blocking
#    each other.
bash .github/scripts/state-lock.sh acquire "$TARGET_TAG"
trap 'bash .github/scripts/state-lock.sh release || true' EXIT

# 2. Download the current index.toml (if any).
INDEX_DIR="$(mktemp -d)"
INDEX_PATH="$INDEX_DIR/index.toml"

if gh release view "$TARGET_TAG" \
     --repo "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY required}" \
     --json assets --jq '.assets[].name' 2>/dev/null \
     | grep -qx 'index.toml'
then
  gh release download "$TARGET_TAG" \
    --repo "$GITHUB_REPOSITORY" \
    --pattern index.toml \
    --dir "$INDEX_DIR" \
    --clobber
else
  # Bootstrap: empty ledger with the matching ABI. ABI is encoded in
  # the target-tag (binaries-abi-v<N>); strip the prefix to recover.
  case "$TARGET_TAG" in
    binaries-abi-v*)
      ABI="${TARGET_TAG#binaries-abi-v}"
      ;;
    pr-*-staging)
      # Staging tags carry the ABI inside their archive filenames, not
      # the tag name. Read ABI_VERSION from the source tree.
      ABI=$(grep -E 'pub const ABI_VERSION: u32 = [0-9]+' \
              crates/shared/src/lib.rs \
              | sed -E 's/.* = ([0-9]+).*/\1/')
      ;;
    *)
      echo "index-update.sh: can't infer ABI for target-tag $TARGET_TAG; \
        update the bootstrap clause for this tag shape." >&2
      exit 2
      ;;
  esac
  cat > "$INDEX_PATH" <<EOF
abi_version = $ABI
generated_at = "$(date -u +%FT%TZ)"
generator = "index-update.sh bootstrap"
EOF
fi

# 3. Mutate via xtask. cargo run --quiet keeps the workflow log
#    focused on the upload step's output.
HOST_TRIPLE="$(rustc -vV | awk '/^host/ {print $2}')"
cargo run --release -p xtask --target "$HOST_TRIPLE" --quiet -- \
  index-update \
    --index-path "$INDEX_PATH" \
    --package "$PACKAGE" \
    --version "$VERSION" \
    --revision "$REVISION" \
    --arch "$ARCH" \
    --status "$STATUS" \
    ${ARCHIVE_PATH:+--archive-path "$ARCHIVE_PATH"} \
    ${ARCHIVE_NAME:+--archive-name "$ARCHIVE_NAME"} \
    ${CACHE_KEY_SHA:+--cache-key-sha "$CACHE_KEY_SHA"} \
    ${ERROR:+--error "$ERROR"} \
    --built-at "$(date -u +%FT%TZ)" \
    --built-by "${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID:-local}"

# 4. Upload archive (success path only) + updated index back to the
#    release. --clobber for idempotency: a retried matrix-build job
#    must produce the same final state.
if ! gh release view "$TARGET_TAG" --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1; then
  release_args=(
    "$TARGET_TAG"
    --repo "$GITHUB_REPOSITORY"
    --target "${GITHUB_SHA:?GITHUB_SHA required}"
    --title "$TARGET_TAG"
  )
  case "$TARGET_TAG" in
    pr-*-staging)
      PR_NUMBER="${TARGET_TAG#pr-}"
      PR_NUMBER="${PR_NUMBER%-staging}"
      release_args+=(--prerelease --notes "PR #${PR_NUMBER} staging build")
      ;;
    binaries-abi-v*)
      ABI="${TARGET_TAG#binaries-abi-v}"
      release_args+=(--notes "Binaries for ABI v${ABI}")
      ;;
    *)
      release_args+=(--notes "Package binary index for ${TARGET_TAG}")
      ;;
  esac
  gh release create "${release_args[@]}" || true
fi

if [ "$STATUS" = "success" ]; then
  gh release upload "$TARGET_TAG" \
    --repo "$GITHUB_REPOSITORY" \
    --clobber \
    "$ARCHIVE_PATH"
fi
gh release upload "$TARGET_TAG" \
  --repo "$GITHUB_REPOSITORY" \
  --clobber \
  "$INDEX_PATH"

echo "index-update.sh: $PACKAGE@$VERSION ($ARCH, status=$STATUS) recorded in $TARGET_TAG/index.toml"

# 5. Lock release is via the EXIT trap.
