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
# Grandfathered ABI 42 exact-main rebuilds also pass
# --canonical-source-sha. The helper then rechecks live GitHub main beside
# every archive mutation and before committing the index transaction.
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
CANONICAL_SOURCE_SHA=""
RELEASE_ID=""
MAX_RELEASE_ASSET_PAGES="${INDEX_UPDATE_MAX_RELEASE_ASSET_PAGES:-100}"

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
    --canonical-source-sha) CANONICAL_SOURCE_SHA="$2"; shift 2 ;;
    --repair-only)   REPAIR_ONLY=1; shift ;;
    *)
      echo "index-update.sh: unknown flag $1" >&2
      exit 2
      ;;
  esac
done

require_canonical_source_authority() {
  [ -n "$CANONICAL_SOURCE_SHA" ] || return 0
  GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}" \
    bash .github/scripts/require-exact-kandelo-main.sh \
      --repository Automattic/kandelo \
      --source-sha "$CANONICAL_SOURCE_SHA" \
      >/dev/null
}

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
    pr-*-staging|pr-*-staging-run-*-attempt-*)
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
  local require_authority=0
  if [ "${1:-}" = "--canonical-mutation" ]; then
    require_authority=1
    shift
  fi
  local attempt=1
  local max_attempts=4
  local delay=2
  local stdout_file
  local stderr_file
  local rc

  stdout_file="$(mktemp)"
  stderr_file="$(mktemp)"

  while true; do
    : >"$stdout_file"
    : >"$stderr_file"

    if [ "$require_authority" = 1 ] &&
       ! require_canonical_source_authority; then
      rm -f "$stdout_file" "$stderr_file"
      return 86
    fi
    if "$@" >"$stdout_file" 2>"$stderr_file"; then
      cat "$stdout_file"
      rm -f "$stdout_file" "$stderr_file"
      return 0
    else
      # WHY: capture the command status inside the conditional. Reading $?
      # after `fi` would see the successful status of the `if` compound
      # command and falsely turn an exhausted publication retry into success.
      rc=$?
    fi

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
  local page page_json count matches match_count reached_end=false
  local match_file

  if ! [[ "$RELEASE_ID" =~ ^[1-9][0-9]*$ ]]; then
    echo "index-update.sh: exact release ID is unavailable" >&2
    return 1
  fi

  match_file="$(mktemp)"
  for ((page = 1; page <= MAX_RELEASE_ASSET_PAGES; page++)); do
    page_json="$(gh_retry gh api \
      "/repos/${GITHUB_REPOSITORY:?GITHUB_REPOSITORY required}/releases/${RELEASE_ID}/assets?per_page=100&page=${page}")"
    if ! jq -e '
      type == "array" and all(.[];
        (.id | type == "number" and . > 0 and floor == .) and
        (.name | type == "string" and length > 0) and
        (.size | type == "number" and . >= 0 and floor == .) and
        (.digest == null or
          (.digest | type == "string" and length > 0)))
    ' <<<"$page_json" >/dev/null; then
      echo "index-update.sh: malformed release asset page $page" >&2
      rm -f "$match_file"
      return 1
    fi
    jq -r --arg name "$asset_name" '
      .[] | select(.name == $name) |
      [.id, .size, (.digest // "")] | @tsv
    ' <<<"$page_json" >>"$match_file"
    count="$(jq 'length' <<<"$page_json")"
    if [ "$count" -lt 100 ]; then
      reached_end=true
      break
    fi
  done
  if [ "$reached_end" != true ]; then
    echo "index-update.sh: asset discovery reached its safety bound" >&2
    rm -f "$match_file"
    return 1
  fi

  match_count="$(wc -l <"$match_file" | tr -d '[:space:]')"
  if [ "$match_count" -gt 1 ]; then
    echo "index-update.sh: release has duplicate asset $asset_name" >&2
    rm -f "$match_file"
    return 1
  fi
  if [ "$match_count" = 0 ]; then
    rm -f "$match_file"
    return 0
  fi
  matches="$(cat "$match_file")"
  rm -f "$match_file"
  if ! [[ "$matches" =~ ^[0-9]+[[:space:]][0-9]+([[:space:]][^[:space:]]+)?$ ]]; then
    echo "index-update.sh: invalid release asset metadata for $asset_name: $matches" >&2
    return 1
  fi
  printf '%s\n' "$matches"
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
  asset_path="$tmp_dir/$asset_name"
  if ! gh_retry gh api -H 'Accept: application/octet-stream' \
      "/repos/${GITHUB_REPOSITORY}/releases/assets/${asset_id}" \
      >"$asset_path"; then
    rm -rf "$tmp_dir"
    return 1
  fi

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
  local empty_sentinel body_file release_target prerelease=false
  local candidate_dir candidate_json candidate_pr candidate_head
  local canonical_release_target="" release_id_file
  body_file="$(mktemp)"
  release_id_file="$(mktemp)"
  release_target="${GITHUB_SHA:?GITHUB_SHA required}"
  case "$TARGET_TAG" in
    pr-*-staging)
      if ! [[ "$TARGET_TAG" =~ ^pr-([1-9][0-9]*)-staging$ ]]; then
        echo "index-update.sh: malformed legacy staging tag $TARGET_TAG" >&2
        return 1
      fi
      prerelease=true
      printf 'PR #%s staging build' "${BASH_REMATCH[1]}" >"$body_file"
      ;;
    pr-*-staging-run-*-attempt-*)
      if ! [[ "$TARGET_TAG" =~ ^pr-([1-9][0-9]*)-staging-run-([1-9][0-9]*)-attempt-([1-9][0-9]*)$ ]]; then
        echo "index-update.sh: malformed run-specific staging tag $TARGET_TAG" >&2
        return 1
      fi
      prerelease=true
      printf 'PR #%s staging build run %s attempt %s' \
        "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}" \
        >"$body_file"
      ;;
    merge-candidate-abi-v*-pr-*-run-*-attempt-*)
      candidate_dir="$(mktemp -d)"
      if ! gh_retry gh release download "$TARGET_TAG" \
          --repo "$GITHUB_REPOSITORY" \
          --pattern candidate.json \
          --dir "$candidate_dir" >/dev/null; then
        echo "index-update.sh: candidate release must be initialized before package writers run" >&2
        return 1
      fi
      candidate_json="$candidate_dir/candidate.json"
      if ! jq -e --arg tag "$TARGET_TAG" '
          .candidate_tag == $tag and
          (.pr_number | type == "number" and . > 0) and
          (.head_sha | test("^[0-9a-f]{40}$"))
        ' "$candidate_json" >/dev/null; then
        echo "index-update.sh: candidate metadata does not match $TARGET_TAG" >&2
        return 1
      fi
      candidate_pr="$(jq -r .pr_number "$candidate_json")"
      candidate_head="$(jq -r .head_sha "$candidate_json")"
      release_target="$candidate_head"
      prerelease=true
      if jq -e '.recovery != null' "$candidate_json" >/dev/null; then
        printf 'Immutable recovery clone of %s; source rejection retained.' \
          "$(jq -r .recovery.source_candidate_tag "$candidate_json")" \
          >"$body_file"
      else
        printf '%s' \
          "Isolated package candidate for PR #${candidate_pr}; not resolver-visible until post-merge activation." \
          >"$body_file"
      fi
      ;;
    binaries-abi-v*)
      if [ "$TARGET_TAG" != binaries-abi-v42 ]; then
        # WHY: this per-package writer cannot know that a future immutable
        # canonical release contains the complete ABI ledger. Only post-merge
        # candidate activation has that proof and may create the draft.
        echo "index-update.sh: new immutable canonical ABI releases must be initialized by post-merge candidate activation" >&2
        return 1
      fi
      ABI="${TARGET_TAG#binaries-abi-v}"
      empty_sentinel=$(bash "${RELEASE_INDEX_STATE_SCRIPT:-scripts/release-index-state.sh}" sentinel)
      printf '%s' "${empty_sentinel}

Binaries for ABI v${ABI}" >"$body_file"
      release_target="${CANONICAL_SOURCE_SHA:-$release_target}"
      if [ "$TARGET_TAG" = binaries-abi-v42 ] &&
         canonical_release_target="$(gh api \
           "/repos/${GITHUB_REPOSITORY}/releases/tags/${TARGET_TAG}" \
           --jq .target_commitish 2>/dev/null)" &&
         [[ "$canonical_release_target" =~ ^[0-9a-f]{40}$ ]]; then
        # WHY: the grandfathered ledger predates this workflow and correctly
        # retains its original direct tag target while exact-main authority is
        # checked independently before every new mutation.
        release_target="$canonical_release_target"
      fi
      ;;
    *)
      echo "index-update.sh: unsupported package release tag $TARGET_TAG" >&2
      return 1
      ;;
  esac
  lifecycle_args=()
  if [ "$TARGET_TAG" = binaries-abi-v42 ]; then
    lifecycle_args+=(--allow-grandfathered-abi42)
  fi
  if [ -n "$CANONICAL_SOURCE_SHA" ]; then
    lifecycle_args+=(--canonical-source-sha "$CANONICAL_SOURCE_SHA")
  fi
  RELEASE_LIFECYCLE_STATE="$(bash \
    "${RELEASE_LIFECYCLE_SCRIPT:-.github/scripts/package-release-lifecycle.sh}" \
    ensure-draft \
      --tag "$TARGET_TAG" \
      --target-commit "$release_target" \
      --title "$TARGET_TAG" \
      --body-file "$body_file" \
      --prerelease "$prerelease" \
      --release-id-file "$release_id_file" \
      "${lifecycle_args[@]}")"
  RELEASE_ID="$(cat "$release_id_file")"
  if ! [[ "$RELEASE_ID" =~ ^[1-9][0-9]*$ ]]; then
    echo "index-update.sh: release lifecycle returned an invalid release ID" >&2
    return 1
  fi
  if [ "$RELEASE_LIFECYCLE_STATE" = immutable ]; then
    echo "index-update.sh: $TARGET_TAG is immutable; publish a new run or generation instead of mutating it" >&2
    return 1
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
    gh_retry --canonical-mutation gh api \
      -X DELETE \
      "/repos/${GITHUB_REPOSITORY}/releases/assets/${asset_id}" \
      >/dev/null
  fi

  local attempt=1
  local max_attempts=4
  local delay=2
  while true; do
    require_canonical_source_authority || return 1
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
        gh_retry --canonical-mutation gh api \
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

upload_isolated_asset_by_tag() {
  local path="$1"
  gh release upload "$TARGET_TAG" \
    --repo "$GITHUB_REPOSITORY" \
    "$path"
}

upload_isolated_index() {
  local expected_size expected_sha info asset_id
  local attempt=1 max_attempts=4 delay=2
  expected_size="$(file_size "$INDEX_PATH")"
  expected_sha="$(sha256_file "$INDEX_PATH")"

  info="$(release_asset_info index.toml)"
  if [ -n "$info" ]; then
    if archive_asset_matches index.toml "$expected_size" "$expected_sha"; then
      return 0
    fi
    read -r asset_id _ _ <<<"$info"
    gh_retry gh api -X DELETE \
      "/repos/${GITHUB_REPOSITORY}/releases/assets/${asset_id}" \
      >/dev/null
  fi

  while true; do
    # WHY: `gh release upload` can find a draft that GitHub's tag REST
    # endpoint hides. Accept success only after the asset appears on the
    # exact release ID. An ambiguous tag cannot redirect the ledger.
    if upload_isolated_asset_by_tag "$INDEX_PATH"; then
      if archive_asset_matches index.toml "$expected_size" "$expected_sha"; then
        return 0
      fi
      echo "index-update.sh: index upload reported success, but exact release verification failed" >&2
    elif archive_asset_matches index.toml "$expected_size" "$expected_sha"; then
      echo "index-update.sh: index upload response failed after the exact release received matching bytes"
      return 0
    fi

    info="$(release_asset_info index.toml)"
    if [ -n "$info" ]; then
      read -r asset_id _ _ <<<"$info"
      gh_retry gh api -X DELETE \
        "/repos/${GITHUB_REPOSITORY}/releases/assets/${asset_id}" \
        >/dev/null
    fi
    if [ "$attempt" -ge "$max_attempts" ]; then
      return 1
    fi
    echo "index-update.sh: index upload failed (attempt ${attempt}/${max_attempts}); retrying in ${delay}s" >&2
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
}

require target-tag    "$TARGET_TAG"

if ! [[ "$MAX_RELEASE_ASSET_PAGES" =~ ^[1-9][0-9]*$ ]]; then
  echo "index-update.sh: INDEX_UPDATE_MAX_RELEASE_ASSET_PAGES must be positive" >&2
  exit 2
fi

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
NORMALIZED_REPOSITORY="$(printf '%s' "${GITHUB_REPOSITORY:-}" | tr '[:upper:]' '[:lower:]')"
# WHY: the existing ABI 42 release in Automattic/kandelo is the one mutable
# canonical ledger. Making its authority flag optional would let a caller
# bypass the exact-main checks that its grandfathered writer relies on.
if [ "$IS_CANONICAL" = 1 ] &&
   [ "$NORMALIZED_REPOSITORY" = "automattic/kandelo" ] &&
   [ -z "$CANONICAL_SOURCE_SHA" ]; then
  echo "index-update.sh: Automattic/kandelo canonical publication requires --canonical-source-sha" >&2
  exit 2
fi
if [ -n "$CANONICAL_SOURCE_SHA" ]; then
  if [ "$IS_CANONICAL" != 1 ] ||
     [ "$NORMALIZED_REPOSITORY" != "automattic/kandelo" ] ||
     ! [[ "$CANONICAL_SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]]; then
    echo "index-update.sh: --canonical-source-sha requires an Automattic/kandelo binaries-abi-v<N> target and an exact lowercase 40-character SHA" >&2
    exit 2
  fi
fi
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
require_canonical_source_authority
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
  index_state_authority_args=()
  if [ -n "$CANONICAL_SOURCE_SHA" ]; then
    index_state_authority_args+=(--canonical-source-sha "$CANONICAL_SOURCE_SHA")
  fi
  bash "$RELEASE_INDEX_STATE_SCRIPT" read \
    --target-tag "$TARGET_TAG" \
    --expected-abi "$EXPECTED_ABI" \
    --output "$INDEX_PATH" \
    --head-file "$INDEX_HEAD_FILE" \
    "${index_state_authority_args[@]}"
else
  index_info="$(release_asset_info 'index.toml')"
  if [ -n "$index_info" ]; then
    read -r index_asset_id _ _ <<<"$index_info"
    # WHY: GitHub's get-by-tag API returns 404 for drafts. Read the asset
    # through the exact release identity selected by the lifecycle helper.
    gh_retry gh api -H 'Accept: application/octet-stream' \
      "/repos/${GITHUB_REPOSITORY}/releases/assets/${index_asset_id}" \
      >"$INDEX_PATH"
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
  require_canonical_source_authority
  bash "$RELEASE_INDEX_STATE_SCRIPT" publish \
    --target-tag "$TARGET_TAG" \
    --expected-abi "$EXPECTED_ABI" \
    --index-path "$INDEX_PATH" \
    --expected-head "$(cat "$INDEX_HEAD_FILE")" \
    "${index_state_authority_args[@]}"
else
  upload_isolated_index
fi

if [ "$STATUS" = "repair" ]; then
  echo "index-update.sh: repaired $TARGET_TAG/index.toml for ABI $EXPECTED_ABI"
else
  echo "index-update.sh: $PACKAGE@$VERSION ($ARCH, status=$STATUS) recorded in $TARGET_TAG/index.toml"
fi

# 6. Lock release is via the EXIT trap.
