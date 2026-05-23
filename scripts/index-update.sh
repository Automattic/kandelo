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
#   2. Ensure the release exists.
#   3. Download the current index.toml from the release (or bootstrap an
#      empty one if the release has none yet).
#   4. Run `xtask index-update` to apply the success-or-failed mutation
#      in-place on the downloaded copy.
#   5. Upload the staged archive + the mutated index.toml back to the
#      release. Archive assets are content-addressed by their cache key,
#      so matching existing assets are reused instead of clobbered.
#   6. Release the state-lock (also on failure via EXIT trap).
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

gh_retry() {
  local attempt=1
  local max_attempts=4
  local delay=2

  while true; do
    if "$@"; then
      return 0
    fi

    local rc=$?
    if [ "$attempt" -ge "$max_attempts" ]; then
      return "$rc"
    fi

    echo "index-update.sh: GitHub command failed (attempt ${attempt}/${max_attempts}); retrying in ${delay}s: $*" >&2
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
}

release_asset_info() {
  local asset_name="$1"
  gh_retry gh api "/repos/${GITHUB_REPOSITORY:?GITHUB_REPOSITORY required}/releases/tags/${TARGET_TAG}" \
    --jq ".assets[] | select(.name == \"$asset_name\") | [.id, .size] | @tsv"
}

ensure_release_exists() {
  local err_file
  err_file="$(mktemp)"

  if gh release view "$TARGET_TAG" --repo "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY required}" >/dev/null 2>"$err_file"; then
    rm -f "$err_file"
    return 0
  fi

  if ! grep -qi 'release not found\|not found\|HTTP 404' "$err_file"; then
    local attempt=1
    local max_attempts=4
    local delay=2
    while [ "$attempt" -lt "$max_attempts" ]; do
      echo "index-update.sh: release lookup failed (attempt ${attempt}/${max_attempts}); retrying in ${delay}s." >&2
      cat "$err_file" >&2
      sleep "$delay"
      if gh release view "$TARGET_TAG" --repo "$GITHUB_REPOSITORY" >/dev/null 2>"$err_file"; then
        rm -f "$err_file"
        return 0
      fi
      if grep -qi 'release not found\|not found\|HTTP 404' "$err_file"; then
        break
      fi
      attempt=$((attempt + 1))
      delay=$((delay * 2))
    done

    if ! grep -qi 'release not found\|not found\|HTTP 404' "$err_file"; then
      cat "$err_file" >&2
      rm -f "$err_file"
      return 1
    fi
  fi

  rm -f "$err_file"

  local release_args=(
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

  if ! gh_retry gh release create "${release_args[@]}"; then
    # Another writer may have created the release after our miss. Treat
    # that race as success only if the release is now visible.
    gh_retry gh release view "$TARGET_TAG" --repo "$GITHUB_REPOSITORY" >/dev/null
  fi
}

file_size() {
  wc -c < "$1" | tr -d '[:space:]'
}

archive_asset_matches() {
  local expected_name="$1"
  local expected_size="$2"
  local info
  info="$(release_asset_info "$expected_name")"
  [ -n "$info" ] || return 1

  local asset_id asset_size
  read -r asset_id asset_size <<< "$info"
  [ -n "$asset_id" ] && [ "$asset_size" = "$expected_size" ]
}

upload_archive_asset() {
  local expected_size
  expected_size="$(file_size "$ARCHIVE_PATH")"

  local info
  info="$(release_asset_info "$ARCHIVE_NAME")"
  if [ -n "$info" ]; then
    local asset_id asset_size
    read -r asset_id asset_size <<< "$info"
    if [ "$asset_size" = "$expected_size" ]; then
      echo "index-update.sh: archive asset $ARCHIVE_NAME already exists with matching size; reusing it."
      return 0
    fi

    echo "index-update.sh: archive asset $ARCHIVE_NAME exists with size $asset_size, expected $expected_size; replacing it." >&2
    gh_retry gh api \
      -X DELETE \
      "/repos/${GITHUB_REPOSITORY}/releases/assets/${asset_id}" \
      >/dev/null
  fi

  local attempt=1
  local max_attempts=4
  local delay=2
  while true; do
    if gh release upload "$TARGET_TAG" \
         --repo "$GITHUB_REPOSITORY" \
         "$ARCHIVE_PATH"
    then
      return 0
    fi

    if archive_asset_matches "$ARCHIVE_NAME" "$expected_size"; then
      echo "index-update.sh: archive upload reported failure, but $ARCHIVE_NAME now exists with matching size; continuing."
      return 0
    fi

    if [ "$attempt" -ge "$max_attempts" ]; then
      return 1
    fi

    echo "index-update.sh: archive upload failed (attempt ${attempt}/${max_attempts}); retrying in ${delay}s." >&2
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
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

# 2. Ensure the release exists.
ensure_release_exists

# 3. Download the current index.toml (if any).
INDEX_DIR="$(mktemp -d)"
INDEX_PATH="$INDEX_DIR/index.toml"

index_info="$(release_asset_info 'index.toml')"
if [ -n "$index_info" ]; then
  gh_retry gh release download "$TARGET_TAG" \
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

# 4. Mutate via xtask. cargo run --quiet keeps the workflow log
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

# 5. Upload archive (success path only) + updated index back to the
#    release. Archive names include the content cache key, so a matching
#    existing asset is already the desired idempotent state. index.toml
#    is the mutable ledger and is replaced under the state lock.
if [ "$STATUS" = "success" ]; then
  upload_archive_asset
fi
gh_retry gh release upload "$TARGET_TAG" \
  --repo "$GITHUB_REPOSITORY" \
  --clobber \
  "$INDEX_PATH"

echo "index-update.sh: $PACKAGE@$VERSION ($ARCH, status=$STATUS) recorded in $TARGET_TAG/index.toml"

# 6. Lock release is via the EXIT trap.
