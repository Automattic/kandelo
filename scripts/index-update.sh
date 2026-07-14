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
#   3. Recover and read canonical index state, or read the isolated mutable
#      index for staging/candidate releases.
#   4. Run `xtask index-update` to apply the success-or-failed mutation
#      in-place on the downloaded copy.
#   5. Upload the staged archive and publish the ledger. Canonical releases
#      use the journaled release-index protocol; isolated releases retain the
#      simpler replace-under-lock path.
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
#
# To repair only release-level index metadata such as abi_version:
#   bash scripts/index-update.sh --target-tag pr-595-staging --repair-only
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
REPAIR_ONLY=0

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
    --repair-only)   REPAIR_ONLY=1; shift ;;
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

current_abi_version() {
  local abi
  abi="$(sed -nE 's/^pub const ABI_VERSION: u32 = ([0-9]+);$/\1/p' crates/shared/src/lib.rs | head -n1)"
  if [ -z "$abi" ]; then
    echo "index-update.sh: could not read ABI_VERSION from crates/shared/src/lib.rs" >&2
    exit 2
  fi
  printf '%s\n' "$abi"
}

expected_abi_for_target_tag() {
  local abi
  case "$TARGET_TAG" in
    binaries-abi-v*)
      abi="${TARGET_TAG#binaries-abi-v}"
      ;;
    pr-*-staging)
      abi="$(current_abi_version)"
      ;;
    merge-candidate-abi-v*-pr-*-run-*-attempt-*)
      abi="${TARGET_TAG#merge-candidate-abi-v}"
      abi="${abi%%-pr-*}"
      ;;
    *)
      echo "index-update.sh: can't infer ABI for target-tag $TARGET_TAG; \
        update expected_abi_for_target_tag for this tag shape." >&2
      exit 2
      ;;
  esac

  if ! [[ "$abi" =~ ^[0-9]+$ ]]; then
    echo "index-update.sh: inferred invalid ABI $abi for target-tag $TARGET_TAG" >&2
    exit 2
  fi
  printf '%s\n' "$abi"
}

archive_name_abi() {
  local name="$1"
  if [[ "$name" =~ (^|-)abi([0-9]+)- ]]; then
    printf '%s\n' "${BASH_REMATCH[2]}"
  fi
}

gh_retry() {
  local attempt=1
  local max_attempts=4
  local delay=2
  local stdout_file
  local stderr_file

  stdout_file="$(mktemp)"
  stderr_file="$(mktemp)"

  while true; do
    : >"$stdout_file"
    : >"$stderr_file"

    if "$@" >"$stdout_file" 2>"$stderr_file"; then
      cat "$stdout_file"
      rm -f "$stdout_file" "$stderr_file"
      return 0
    fi

    local rc=$?
    if [ "$attempt" -ge "$max_attempts" ]; then
      cat "$stderr_file" >&2
      if [ -s "$stdout_file" ]; then
        cat "$stdout_file" >&2
      fi
      rm -f "$stdout_file" "$stderr_file"
      return "$rc"
    fi

    cat "$stderr_file" >&2
    echo "index-update.sh: GitHub command failed (attempt ${attempt}/${max_attempts}); retrying in ${delay}s: $*" >&2
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
}

release_asset_info() {
  local asset_name="$1"
  local info

  info="$(gh_retry gh api "/repos/${GITHUB_REPOSITORY:?GITHUB_REPOSITORY required}/releases/tags/${TARGET_TAG}" \
    --jq ".assets[] | select(.name == \"$asset_name\") | [.id, .size, (.digest // \"\")] | @tsv"
  )"

  [ -n "$info" ] || return 0

  if ! [[ "$info" =~ ^[0-9]+[[:space:]][0-9]+([[:space:]][^[:space:]]+)?$ ]]; then
    echo "index-update.sh: invalid release asset metadata for $asset_name: $info" >&2
    return 1
  fi

  printf '%s\n' "$info"
}

sha256_file() {
  local path="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$path" | awk '{print $1}'
  else
    shasum -a 256 "$path" | awk '{print $1}'
  fi
}

release_asset_sha_matches() {
  local asset_name="$1"
  local expected_sha="$2"
  local info asset_id asset_size asset_digest

  info="$(release_asset_info "$asset_name")"
  [ -n "$info" ] || return 1
  read -r asset_id asset_size asset_digest <<< "$info"
  if [[ "${asset_digest:-}" == sha256:* ]]; then
    [ "${asset_digest#sha256:}" = "$expected_sha" ]
    return
  fi

  local tmp_dir asset_path actual_sha

  tmp_dir="$(mktemp -d)"
  if ! gh_retry gh release download "$TARGET_TAG" \
      --repo "$GITHUB_REPOSITORY" \
      --pattern "$asset_name" \
      --dir "$tmp_dir" \
      --clobber >/dev/null; then
    rm -rf "$tmp_dir"
    return 1
  fi

  asset_path="$tmp_dir/$asset_name"
  if [ ! -f "$asset_path" ]; then
    echo "index-update.sh: downloaded asset $asset_name not found at $asset_path" >&2
    rm -rf "$tmp_dir"
    return 1
  fi

  actual_sha="$(sha256_file "$asset_path")"
  rm -rf "$tmp_dir"
  [ "$actual_sha" = "$expected_sha" ]
}

ensure_release_exists() {
  local err_file empty_sentinel
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
    merge-candidate-abi-v*-pr-*-run-*-attempt-*)
      release_args+=(--prerelease --notes "Isolated prepare-merge package candidate")
      ;;
    binaries-abi-v*)
      ABI="${TARGET_TAG#binaries-abi-v}"
      empty_sentinel=$(bash "${RELEASE_INDEX_STATE_SCRIPT:-scripts/release-index-state.sh}" sentinel)
      release_args+=(--notes "${empty_sentinel}

Binaries for ABI v${ABI}")
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
  local expected_sha="$3"
  local info
  info="$(release_asset_info "$expected_name")"
  [ -n "$info" ] || return 1

  local asset_id asset_size asset_digest
  read -r asset_id asset_size asset_digest <<< "$info"
  [ -n "$asset_id" ] &&
    [ "$asset_size" = "$expected_size" ] &&
    release_asset_sha_matches "$expected_name" "$expected_sha"
}

upload_archive_asset() {
  local expected_size
  expected_size="$(file_size "$ARCHIVE_PATH")"
  local expected_sha
  expected_sha="$(sha256_file "$ARCHIVE_PATH")"

  local info
  info="$(release_asset_info "$ARCHIVE_NAME")"
  if [ -n "$info" ]; then
    local asset_id asset_size asset_digest
    read -r asset_id asset_size asset_digest <<< "$info"
    if [ "$asset_size" = "$expected_size" ] &&
       release_asset_sha_matches "$ARCHIVE_NAME" "$expected_sha"; then
      echo "index-update.sh: archive asset $ARCHIVE_NAME already exists with matching sha256; reusing it."
      return 0
    fi

    echo "index-update.sh: archive asset $ARCHIVE_NAME exists but does not match staged bytes; replacing it." >&2
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
      if archive_asset_matches "$ARCHIVE_NAME" "$expected_size" "$expected_sha"; then
        return 0
      fi
      echo "index-update.sh: archive upload reported success, but $ARCHIVE_NAME does not match staged bytes; retrying." >&2
      info="$(release_asset_info "$ARCHIVE_NAME")"
      if [ -n "$info" ]; then
        local retry_asset_id
        read -r retry_asset_id _ _ <<< "$info"
        gh_retry gh api \
          -X DELETE \
          "/repos/${GITHUB_REPOSITORY}/releases/assets/${retry_asset_id}" \
          >/dev/null
      fi
    fi

    if archive_asset_matches "$ARCHIVE_NAME" "$expected_size" "$expected_sha"; then
      echo "index-update.sh: archive upload reported failure, but $ARCHIVE_NAME now exists with matching sha256; continuing."
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

if [ "$REPAIR_ONLY" = "1" ]; then
  STATUS="repair"
else
  require package       "$PACKAGE"
  require version       "$VERSION"
  require revision      "$REVISION"
  require arch          "$ARCH"
  require status        "$STATUS"
fi

# Include the matrix entry in lock diagnostics. Liveness comes only from the
# owner token or GitHub's status for the exact owning workflow run.
if [ "$STATUS" = "repair" ]; then
  export STATE_LOCK_OWNER_DETAIL="${STATE_LOCK_OWNER_DETAIL:-index repair}"
else
  export STATE_LOCK_OWNER_DETAIL="${STATE_LOCK_OWNER_DETAIL:-${ARCH}, ${PACKAGE}}"
fi

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
  repair)
    ;;
  *)
    echo "index-update.sh: --status must be success, failed, or repair, got $STATUS" >&2
    exit 2
    ;;
esac

EXPECTED_ABI="$(expected_abi_for_target_tag)"
RELEASE_INDEX_STATE_SCRIPT="${RELEASE_INDEX_STATE_SCRIPT:-scripts/release-index-state.sh}"
IS_CANONICAL=0
case "$TARGET_TAG" in binaries-abi-v*) IS_CANONICAL=1 ;; esac
if [ -n "$ARCHIVE_NAME" ]; then
  ARCHIVE_ABI="$(archive_name_abi "$ARCHIVE_NAME")"
  if [ -n "$ARCHIVE_ABI" ] && [ "$ARCHIVE_ABI" != "$EXPECTED_ABI" ]; then
    echo "index-update.sh: --archive-name $ARCHIVE_NAME declares ABI $ARCHIVE_ABI, \
but $TARGET_TAG expects ABI $EXPECTED_ABI" >&2
    exit 2
  fi
fi

# 1. Acquire the state-lock for this target tag. Same script that
#    serialises durable-release publishes; the per-target-tag subject
#    keeps independent rebuilds (e.g. abi-v8 vs abi-v9) from blocking
#    each other.
STATE_LOCK_SCRIPT="${STATE_LOCK_SCRIPT:-.github/scripts/state-lock.sh}"
bash "$STATE_LOCK_SCRIPT" acquire "$TARGET_TAG"
trap 'bash "$STATE_LOCK_SCRIPT" release || true' EXIT

# 2. Ensure the release exists.
ensure_release_exists

# A ready marker seals the exact candidate index exercised by the test gate.
# Post-test mutation would make activation unverifiable, so candidate writers
# fail closed once that marker exists.
case "$TARGET_TAG" in
  merge-candidate-abi-v*-pr-*-run-*-attempt-*)
    if [ -n "$(release_asset_info ready.json)" ]; then
      echo "index-update.sh: candidate $TARGET_TAG is sealed by ready.json; refusing post-test mutation" >&2
      exit 1
    fi
    ;;
esac

# 3. Download the current index.toml (if any).
INDEX_DIR="$(mktemp -d)"
INDEX_PATH="$INDEX_DIR/index.toml"
INDEX_HEAD_FILE="$INDEX_DIR/head"

if [ "$IS_CANONICAL" = 1 ]; then
  bash "$RELEASE_INDEX_STATE_SCRIPT" read \
    --target-tag "$TARGET_TAG" \
    --expected-abi "$EXPECTED_ABI" \
    --output "$INDEX_PATH" \
    --head-file "$INDEX_HEAD_FILE"
else
  index_info="$(release_asset_info 'index.toml')"
  if [ -n "$index_info" ]; then
    gh_retry gh release download "$TARGET_TAG" \
      --repo "$GITHUB_REPOSITORY" \
      --pattern index.toml \
      --dir "$INDEX_DIR" \
      --clobber
  else
    cat > "$INDEX_PATH" <<EOF
abi_version = $EXPECTED_ABI
generated_at = "$(date -u +%FT%TZ)"
generator = "index-update.sh bootstrap"
EOF
  fi
fi

# 4. Mutate via xtask. cargo run --quiet keeps the workflow log
#    focused on the upload step's output.
HOST_TRIPLE="$(rustc -vV | awk '/^host/ {print $2}')"
cargo run --release -p xtask --target "$HOST_TRIPLE" --quiet -- \
  index-update \
    --index-path "$INDEX_PATH" \
    --status "$STATUS" \
    ${PACKAGE:+--package "$PACKAGE"} \
    ${VERSION:+--version "$VERSION"} \
    ${REVISION:+--revision "$REVISION"} \
    ${ARCH:+--arch "$ARCH"} \
    ${ARCHIVE_PATH:+--archive-path "$ARCHIVE_PATH"} \
    ${ARCHIVE_NAME:+--archive-name "$ARCHIVE_NAME"} \
    ${CACHE_KEY_SHA:+--cache-key-sha "$CACHE_KEY_SHA"} \
    ${ERROR:+--error "$ERROR"} \
    --expected-abi "$EXPECTED_ABI" \
    --built-at "$(date -u +%FT%TZ)" \
    --built-by "${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID:-local}"

# 5. Upload archive (success path only) + updated index back to the
#    release. Archive names include the content cache key, so a matching
#    existing asset is already the desired idempotent state. index.toml
#    is the mutable ledger and is replaced under the state lock.
if [ "$STATUS" = "success" ]; then
  upload_archive_asset
fi
if [ "$IS_CANONICAL" = 1 ]; then
  bash "$RELEASE_INDEX_STATE_SCRIPT" publish \
    --target-tag "$TARGET_TAG" \
    --expected-abi "$EXPECTED_ABI" \
    --index-path "$INDEX_PATH" \
    --expected-head "$(cat "$INDEX_HEAD_FILE")"
else
  gh_retry gh release upload "$TARGET_TAG" \
    --repo "$GITHUB_REPOSITORY" \
    --clobber \
    "$INDEX_PATH"
fi

if [ "$STATUS" = "repair" ]; then
  echo "index-update.sh: repaired $TARGET_TAG/index.toml for ABI $EXPECTED_ABI"
else
  echo "index-update.sh: $PACKAGE@$VERSION ($ARCH, status=$STATUS) recorded in $TARGET_TAG/index.toml"
fi

# 6. Lock release is via the EXIT trap.
