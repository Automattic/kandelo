#!/usr/bin/env bash
# Crash-recoverable publication for a release's stable index.toml asset.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=.github/scripts/github-api-get.sh
source "$REPO_ROOT/.github/scripts/github-api-get.sh"

EMPTY_SENTINEL='<!-- kandelo-index-state-v1:empty -->'
MARKER_NAME='kandelo-index-state-v1.json'
MARKER_CONTENT='{"schema_version":1,"kind":"kandelo-release-index-state"}'
HEAD_EMPTY='index-head-v1:empty'
GEN_PREFIX='kandelo-index-generation-v1-'
PENDING_PREFIX='kandelo-index-pending-v1-'
WAL_PREFIX='kandelo-index-transaction-v1-'
RETIRED_PREFIX='kandelo-index-retired-v1-'

COMMAND="${1:-}"
if [ -n "$COMMAND" ]; then shift; fi
TARGET_TAG=""
EXPECTED_ABI=""
OUTPUT=""
HEAD_FILE=""
INDEX_PATH=""
EXPECTED_HEAD=""
MAX_ASSET_PAGES="${INDEX_STATE_MAX_ASSET_PAGES:-20}"
ASSET_PER_PAGE="${INDEX_STATE_ASSET_PER_PAGE:-100}"
RETRY_DELAY_SECONDS="${INDEX_STATE_RETRY_DELAY_SECONDS:-2}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --target-tag) TARGET_TAG="$2"; shift 2 ;;
    --expected-abi) EXPECTED_ABI="$2"; shift 2 ;;
    --output) OUTPUT="$2"; shift 2 ;;
    --head-file) HEAD_FILE="$2"; shift 2 ;;
    --index-path) INDEX_PATH="$2"; shift 2 ;;
    --expected-head) EXPECTED_HEAD="$2"; shift 2 ;;
    --max-asset-pages) MAX_ASSET_PAGES="$2"; shift 2 ;;
    --asset-per-page) ASSET_PER_PAGE="$2"; shift 2 ;;
    *) echo "release-index-state: unknown flag $1" >&2; exit 2 ;;
  esac
done

if [ "$COMMAND" = sentinel ]; then
  printf '%s\n' "$EMPTY_SENTINEL"
  exit 0
fi
case "$COMMAND" in read|snapshot|publish|recover) ;; *)
  echo "release-index-state: command must be read, snapshot, publish, recover, or sentinel" >&2
  exit 2
esac
if [ -z "$TARGET_TAG" ] || ! [[ "$EXPECTED_ABI" =~ ^[0-9]+$ ]]; then
  echo "release-index-state: --target-tag and numeric --expected-abi are required" >&2
  exit 2
fi
if { [ "$COMMAND" = read ] || [ "$COMMAND" = snapshot ]; } &&
   { [ -z "$OUTPUT" ] || [ -z "$HEAD_FILE" ]; }; then
  echo "release-index-state: $COMMAND requires --output and --head-file" >&2
  exit 2
fi
if [ "$COMMAND" = publish ] && { [ ! -f "$INDEX_PATH" ] || [ -z "$EXPECTED_HEAD" ]; }; then
  echo "release-index-state: publish requires --index-path and --expected-head" >&2
  exit 2
fi
if ! [[ "$MAX_ASSET_PAGES" =~ ^[0-9]+$ ]] || [ "$MAX_ASSET_PAGES" = 0 ] ||
   ! [[ "$ASSET_PER_PAGE" =~ ^[0-9]+$ ]] || [ "$ASSET_PER_PAGE" = 0 ] || [ "$ASSET_PER_PAGE" -gt 100 ] ||
   ! [[ "$RETRY_DELAY_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "release-index-state: invalid pagination or retry configuration" >&2
  exit 2
fi

REPOSITORY="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY required}"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT
RELEASE_JSON="$TMP_ROOT/release.json"
ASSETS_JSON="$TMP_ROOT/assets.json"
RELEASE_ID=""
MARKER_ID=""
MARKER_HEAD=""

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

sha256_text() {
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$1" | sha256sum | awk '{print $1}'
  else
    printf '%s' "$1" | shasum -a 256 | awk '{print $1}'
  fi
}

file_size() { wc -c < "$1" | tr -d '[:space:]'; }

failpoint() {
  if [ "${INDEX_STATE_FAILPOINT:-}" = "$1" ]; then
    echo "release-index-state: injected failure at $1" >&2
    exit 86
  fi
}

gh_retry() {
  local attempt=1 delay="$RETRY_DELAY_SECONDS" attempt_output
  attempt_output=$(mktemp "$TMP_ROOT/gh-retry.XXXXXX")
  while true; do
    if "$@" > "$attempt_output"; then
      cat "$attempt_output"
      rm -f "$attempt_output"
      return 0
    fi
    if [ "$attempt" -ge 4 ]; then
      rm -f "$attempt_output"
      return 1
    fi
    echo "release-index-state: GitHub command failed; retrying in ${delay}s: $*" >&2
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
}

refresh_state() {
  local rc page page_json count reached_end=false lines="$TMP_ROOT/assets.jsonl"
  GITHUB_API_CONTEXT=release-index-state \
    GITHUB_API_RETRY_DELAY_SECONDS="$RETRY_DELAY_SECONDS" \
    github_api_get_json "/repos/${REPOSITORY}/releases/tags/${TARGET_TAG}" "$RELEASE_JSON" || rc=$?
  rc=${rc:-0}
  if [ "$rc" -eq 44 ]; then return 44; fi
  [ "$rc" -eq 0 ] || return 1
  if ! jq -e --arg tag "$TARGET_TAG" '
      (.id | type == "number" and . > 0) and .tag_name == $tag and
      (.body == null or (.body | type == "string"))
    ' "$RELEASE_JSON" >/dev/null
  then
    echo "release-index-state: malformed release response for $TARGET_TAG" >&2
    return 1
  fi
  RELEASE_ID=$(jq -r .id "$RELEASE_JSON")
  : > "$lines"
  for ((page = 1; page <= MAX_ASSET_PAGES; page++)); do
    page_json=$(gh_retry gh api "/repos/${REPOSITORY}/releases/${RELEASE_ID}/assets?per_page=${ASSET_PER_PAGE}&page=${page}")
    if ! jq -e '
        type == "array" and all(.[];
          (.id | type == "number" and . > 0) and
          (.name | type == "string" and length > 0) and
          (.label == null or (.label | type == "string")) and
          (.state == "uploaded" or .state == "starter") and
          (.size | type == "number" and . >= 0) and
          (.digest == null or (.digest | type == "string")))
      ' <<<"$page_json" >/dev/null
    then
      echo "release-index-state: malformed asset page $page" >&2
      return 1
    fi
    count=$(jq 'length' <<<"$page_json")
    jq -c '.[]' <<<"$page_json" >> "$lines"
    if [ "$count" -lt "$ASSET_PER_PAGE" ]; then reached_end=true; break; fi
  done
  if [ "$reached_end" != true ]; then
    echo "release-index-state: asset scan reached its safety bound" >&2
    return 1
  fi
  if [ -s "$lines" ]; then jq -s . "$lines" > "$ASSETS_JSON"; else printf '[]\n' > "$ASSETS_JSON"; fi
  if ! jq -e '
      (group_by(.id) | all(.[]; length == 1)) and
      (sort_by(.name) | group_by(.name) | all(.[]; length == 1))
    ' "$ASSETS_JSON" >/dev/null
  then
    echo "release-index-state: duplicate asset ID or name" >&2
    return 1
  fi
}

asset_by_name() { jq -c --arg name "$1" '.[] | select(.name == $name)' "$ASSETS_JSON"; }
asset_by_id() { jq -c --argjson id "$1" '.[] | select(.id == $id)' "$ASSETS_JSON"; }

download_asset_id() {
  local id="$1" output="$2"
  gh_retry gh api -H 'Accept: application/octet-stream' \
    "/repos/${REPOSITORY}/releases/assets/${id}" > "$output"
}

verify_asset() {
  local asset="$1" expected_sha="$2" expected_size="${3:-}"
  local id name state size digest path actual
  id=$(jq -r .id <<<"$asset")
  name=$(jq -r .name <<<"$asset")
  state=$(jq -r .state <<<"$asset")
  size=$(jq -r .size <<<"$asset")
  digest=$(jq -r '.digest // ""' <<<"$asset")
  [ "$state" = uploaded ] || { echo "release-index-state: asset $name is not uploaded" >&2; return 1; }
  [ -z "$expected_size" ] || [ "$size" = "$expected_size" ] || return 1
  if [[ "$digest" == sha256:* ]] && [ "${digest#sha256:}" != "$expected_sha" ]; then return 1; fi
  path="$TMP_ROOT/asset-${id}"
  download_asset_id "$id" "$path"
  actual=$(sha256_file "$path")
  [ "$actual" = "$expected_sha" ]
}

upload_exact_asset() {
  local name="$1" source="$2"
  local expected_sha expected_size asset attempt=1 upload_dir="$TMP_ROOT/upload-$RANDOM"
  expected_sha=$(sha256_file "$source")
  expected_size=$(file_size "$source")
  while true; do
    refresh_state
    asset=$(asset_by_name "$name")
    if [ -n "$asset" ]; then
      if verify_asset "$asset" "$expected_sha" "$expected_size"; then
        printf '%s\n' "$asset"
        return 0
      fi
      if [ "$(jq -r .state <<<"$asset")" = starter ]; then
        delete_asset "$(jq -r .id <<<"$asset")"
      else
        echo "release-index-state: reserved asset $name exists with different bytes" >&2
        return 1
      fi
    fi
    mkdir -p "$upload_dir"
    cp "$source" "$upload_dir/$name"
    if gh release upload "$TARGET_TAG" --repo "$REPOSITORY" "$upload_dir/$name"; then :; fi
    refresh_state
    asset=$(asset_by_name "$name")
    if [ -n "$asset" ] && verify_asset "$asset" "$expected_sha" "$expected_size"; then
      printf '%s\n' "$asset"
      return 0
    fi
    if [ "$attempt" -ge 4 ]; then return 1; fi
    attempt=$((attempt + 1))
  done
}

patch_asset() {
  local id="$1" field="$2" value="$3" attempt=1 asset actual
  while true; do
    if gh api --method PATCH "/repos/${REPOSITORY}/releases/assets/${id}" \
        -f "${field}=${value}" >/dev/null
    then :; fi
    refresh_state
    asset=$(asset_by_id "$id")
    if [ -n "$asset" ]; then
      actual=$(jq -r --arg field "$field" '.[$field] // ""' <<<"$asset")
      if [ "$actual" = "$value" ]; then return 0; fi
    fi
    if [ "$attempt" -ge 4 ]; then return 1; fi
    attempt=$((attempt + 1))
  done
}

delete_asset() {
  local id="$1" attempt=1
  while true; do
    if gh api --method DELETE "/repos/${REPOSITORY}/releases/assets/${id}" >/dev/null; then :; fi
    refresh_state
    if [ -z "$(asset_by_id "$id")" ]; then return 0; fi
    if [ "$attempt" -ge 4 ]; then return 1; fi
    attempt=$((attempt + 1))
  done
}

head_sha() {
  case "$1" in
    "$HEAD_EMPTY") printf 'empty\n' ;;
    index-head-v1:sha256:*) printf '%s\n' "${1#index-head-v1:sha256:}" ;;
    *) return 1 ;;
  esac
}

generation_name() { printf '%s%s.toml\n' "$GEN_PREFIX" "$1"; }

ensure_generation() {
  local sha="$1" source="$2"
  upload_exact_asset "$(generation_name "$sha")" "$source" >/dev/null
}

marker_file() { printf '%s\n' "$MARKER_CONTENT" > "$TMP_ROOT/$MARKER_NAME"; }

normalize_marker() {
  local marker live live_file live_sha marker_file_path="$TMP_ROOT/$MARKER_NAME"
  marker=$(asset_by_name "$MARKER_NAME")
  live=$(asset_by_name index.toml)
  if [ -n "$marker" ] && [ "$(jq -r .state <<<"$marker")" = starter ]; then
    delete_asset "$(jq -r .id <<<"$marker")"
    refresh_state
    marker=""
    live=$(asset_by_name index.toml)
  fi
  if [ -z "$marker" ]; then
    if [ -n "$live" ]; then
      live_file="$TMP_ROOT/migration-live"
      download_asset_id "$(jq -r .id <<<"$live")" "$live_file"
      live_sha=$(sha256_file "$live_file")
      verify_asset "$live" "$live_sha" "$(file_size "$live_file")"
      ensure_generation "$live_sha" "$live_file"
      failpoint after-migration-generation
      marker_file
      marker=$(upload_exact_asset "$MARKER_NAME" "$marker_file_path")
      patch_asset "$(jq -r .id <<<"$marker")" label "index-head-v1:sha256:${live_sha}"
      failpoint after-migration-marker
      refresh_state
    else
      if ! jq -er '.body // ""' "$RELEASE_JSON" | grep -Fq "$EMPTY_SENTINEL"; then
        echo "release-index-state: existing empty release lacks the v1 empty-store sentinel" >&2
        return 1
      fi
      marker_file
      marker=$(upload_exact_asset "$MARKER_NAME" "$marker_file_path")
      patch_asset "$(jq -r .id <<<"$marker")" label "$HEAD_EMPTY"
      failpoint after-bootstrap-marker
      refresh_state
    fi
  fi

  marker=$(asset_by_name "$MARKER_NAME")
  [ -n "$marker" ] || return 1
  if ! verify_asset "$marker" "$(sha256_file "$marker_file_path")"; then
    marker_file
    verify_asset "$marker" "$(sha256_file "$marker_file_path")" || {
      echo "release-index-state: marker bytes are invalid" >&2; return 1;
    }
  fi
  MARKER_ID=$(jq -r .id <<<"$marker")
  MARKER_HEAD=$(jq -r '.label // ""' <<<"$marker")
  if ! current=$(head_sha "$MARKER_HEAD"); then
    # An upload may have succeeded immediately before its first label PATCH.
    if [ -z "$MARKER_HEAD" ]; then
      live=$(asset_by_name index.toml)
      if [ -n "$live" ]; then
        live_file="$TMP_ROOT/unlabelled-live"
        download_asset_id "$(jq -r .id <<<"$live")" "$live_file"
        live_sha=$(sha256_file "$live_file")
        patch_asset "$MARKER_ID" label "index-head-v1:sha256:${live_sha}"
      elif jq -er '.body // ""' "$RELEASE_JSON" | grep -Fq "$EMPTY_SENTINEL"; then
        patch_asset "$MARKER_ID" label "$HEAD_EMPTY"
      else
        echo "release-index-state: unlabelled marker has no provable head" >&2
        return 1
      fi
      refresh_state
      MARKER_HEAD=$(jq -r '.label // ""' <<<"$(asset_by_name "$MARKER_NAME")")
      current=$(head_sha "$MARKER_HEAD") || return 1
    else
      echo "release-index-state: marker has malformed label $MARKER_HEAD" >&2
      return 1
    fi
  fi
}

validate_reserved_names() {
  local invalid
  invalid=$(jq -r --arg marker "$MARKER_NAME" \
    --arg gen "$GEN_PREFIX" --arg pending "$PENDING_PREFIX" \
    --arg wal "$WAL_PREFIX" --arg retired "$RETIRED_PREFIX" '
      .[] | .name |
      select(
        (. == $marker or . == "index.toml" or
         test("^" + $gen + "[0-9a-f]{64}\\.toml$") or
         test("^" + $pending + "[0-9a-f]{64}\\.toml$") or
         test("^" + $wal + "[0-9a-f]{64}\\.json$") or
         test("^" + $retired + "[0-9a-f]{64}\\.toml$")) | not
      ) |
      select(startswith("kandelo-index-") or startswith("index.toml."))
    ' "$ASSETS_JSON")
  if [ -n "$invalid" ]; then
    echo "release-index-state: malformed reserved asset name: $invalid" >&2
    return 1
  fi
}

cleanup_transaction_assets() {
  local keep_sha="$1" asset name id deleted=0
  while IFS= read -r asset; do
    [ -n "$asset" ] || continue
    name=$(jq -r .name <<<"$asset")
    case "$name" in
      "$(generation_name "$keep_sha")") continue ;;
      ${GEN_PREFIX}*.toml|${PENDING_PREFIX}*.toml|${WAL_PREFIX}*.json|${RETIRED_PREFIX}*.toml)
        id=$(jq -r .id <<<"$asset")
        delete_asset "$id"
        if [ "$deleted" = 0 ]; then failpoint during-cleanup; fi
        deleted=$((deleted + 1))
        refresh_state
        ;;
    esac
  done < <(jq -c '.[]' "$ASSETS_JSON")
}

verify_live_head() {
  local head="$1" live generation live_file gen_file public_dir
  live=$(asset_by_name index.toml)
  if [ "$head" = empty ]; then
    [ -z "$live" ] || { echo "release-index-state: empty marker has a live index without a transaction" >&2; return 1; }
    return 0
  fi
  generation=$(asset_by_name "$(generation_name "$head")")
  [ -n "$generation" ] || { echo "release-index-state: marker generation $head is missing" >&2; return 1; }
  verify_asset "$generation" "$head" || return 1
  if [ -z "$live" ]; then
    gen_file="$TMP_ROOT/repair-$head"
    download_asset_id "$(jq -r .id <<<"$generation")" "$gen_file"
    repair_name="${PENDING_PREFIX}$(sha256_text "repair:${REPOSITORY}:${RELEASE_ID}:${head}").toml"
    repair=$(upload_exact_asset "$repair_name" "$gen_file")
    patch_asset "$(jq -r .id <<<"$repair")" name index.toml
    refresh_state
    live=$(asset_by_name index.toml)
    ensure_generation "$head" "$gen_file"
  fi
  live_file="$TMP_ROOT/live-$head"
  download_asset_id "$(jq -r .id <<<"$live")" "$live_file"
  if [ "$(sha256_file "$live_file")" != "$head" ]; then
    echo "release-index-state: live index disagrees with the committed marker" >&2
    return 1
  fi
  public_dir="$TMP_ROOT/public-$head"
  mkdir -p "$public_dir"
  gh_retry gh release download "$TARGET_TAG" --repo "$REPOSITORY" \
    --pattern index.toml --dir "$public_dir" --clobber >/dev/null
  if [ "$(sha256_file "$public_dir/index.toml")" != "$head" ]; then
    echo "release-index-state: stable index.toml download disagrees with the committed marker" >&2
    return 1
  fi
}

snapshot_public_live() {
  local expected_sha="$1" output="$2" public_dir
  public_dir="$TMP_ROOT/snapshot-public-$expected_sha"
  mkdir -p "$public_dir"
  gh_retry gh release download "$TARGET_TAG" --repo "$REPOSITORY" \
    --pattern index.toml --dir "$public_dir" --clobber >/dev/null
  if [ "$(sha256_file "$public_dir/index.toml")" != "$expected_sha" ]; then
    echo "release-index-state: stable index.toml download disagrees with release state" >&2
    return 1
  fi
  cp "$public_dir/index.toml" "$output"
}

snapshot_current() {
  local rc marker live current generation expected_marker_sha
  local live_file="$TMP_ROOT/snapshot-live" marker_file_path="$TMP_ROOT/$MARKER_NAME"
  local snapshot_file="$TMP_ROOT/snapshot-index.toml"
  refresh_state || rc=$?
  rc=${rc:-0}
  if [ "$rc" -eq 44 ]; then
    echo "release-index-state: release $TARGET_TAG is absent" >&2
    return 44
  fi
  [ "$rc" -eq 0 ] || return 1
  validate_reserved_names
  marker=$(asset_by_name "$MARKER_NAME")
  live=$(asset_by_name index.toml)

  if [ -z "$marker" ]; then
    if [ -z "$live" ]; then
      echo "release-index-state: release has neither a managed marker nor a legacy index.toml" >&2
      return 1
    fi
    download_asset_id "$(jq -r .id <<<"$live")" "$live_file"
    current=$(sha256_file "$live_file")
    if ! verify_asset "$live" "$current" "$(file_size "$live_file")"; then
      echo "release-index-state: legacy index.toml metadata or bytes are invalid" >&2
      return 1
    fi
    snapshot_public_live "$current" "$snapshot_file"
  else
    marker_file
    expected_marker_sha=$(sha256_file "$marker_file_path")
    if ! verify_asset "$marker" "$expected_marker_sha"; then
      echo "release-index-state: managed marker bytes are invalid; post-merge recovery is required" >&2
      return 1
    fi
    MARKER_HEAD=$(jq -r '.label // ""' <<<"$marker")
    if ! current=$(head_sha "$MARKER_HEAD"); then
      echo "release-index-state: managed marker label is invalid; post-merge recovery is required" >&2
      return 1
    fi

    if [ "$current" = empty ]; then
      if [ -n "$live" ]; then
        echo "release-index-state: empty marker has a live index; post-merge recovery is required" >&2
        return 1
      fi
      cat > "$snapshot_file" <<EOF
abi_version = $EXPECTED_ABI
generated_at = "1970-01-01T00:00:00Z"
generator = "release-index-state empty snapshot"
EOF
    else
      generation=$(asset_by_name "$(generation_name "$current")")
      if [ -z "$generation" ] || [ -z "$live" ]; then
        echo "release-index-state: managed marker, generation, and live index are incomplete; post-merge recovery is required" >&2
        return 1
      fi
      if ! verify_asset "$generation" "$current"; then
        echo "release-index-state: committed generation is invalid; post-merge recovery is required" >&2
        return 1
      fi
      if ! verify_asset "$live" "$current"; then
        echo "release-index-state: live index disagrees with the committed marker; post-merge recovery is required" >&2
        return 1
      fi
      snapshot_public_live "$current" "$snapshot_file"
    fi
  fi

  mkdir -p "$(dirname "$OUTPUT")" "$(dirname "$HEAD_FILE")"
  cp "$snapshot_file" "$OUTPUT"
  printf '%s\n' "$current" > "$HEAD_FILE"
}

recover_transaction() {
  local wal_assets wal wal_file wal_name txid old_head new_sha pending_name retired_name
  local old_live_id new_asset_id marker_head_value old_asset new_asset live new_file old_sha
  wal_assets=$(jq -c --arg p "$WAL_PREFIX" '[.[] | select(.name | startswith($p))]' "$ASSETS_JSON")
  if [ "$(jq 'length' <<<"$wal_assets")" -gt 1 ]; then
    echo "release-index-state: multiple active index transactions" >&2
    return 1
  fi
  if [ "$(jq 'length' <<<"$wal_assets")" -eq 0 ]; then
    current=$(head_sha "$MARKER_HEAD") || return 1
    verify_live_head "$current"
    refresh_state
    cleanup_transaction_assets "$current"
    return 0
  fi

  wal=$(jq -c '.[0]' <<<"$wal_assets")
  if [ "$(jq -r .state <<<"$wal")" = starter ]; then
    delete_asset "$(jq -r .id <<<"$wal")"
    refresh_state
    recover_transaction
    return
  fi

  wal_name=$(jq -r .name <<<"$wal")
  txid=${wal_name#"$WAL_PREFIX"}
  txid=${txid%.json}
  wal_file="$TMP_ROOT/wal.json"
  download_asset_id "$(jq -r .id <<<"$wal")" "$wal_file"
  if ! jq -e \
      --arg repo "$REPOSITORY" --arg tag "$TARGET_TAG" --argjson release_id "$RELEASE_ID" \
      --argjson marker_id "$MARKER_ID" --argjson abi "$EXPECTED_ABI" '
        .schema_version == 1 and .repository == $repo and .target_tag == $tag and
        .release_id == $release_id and .marker_id == $marker_id and .abi_version == $abi and
        (.old_head == "empty" or (.old_head | test("^[0-9a-f]{64}$"))) and
        (.old_live_id == null or (.old_live_id | type == "number" and . > 0)) and
        (.new_sha | test("^[0-9a-f]{64}$")) and
        (.new_asset_id | type == "number" and . > 0) and
        (.pending_name | type == "string") and (.retired_name | type == "string")
      ' "$wal_file" >/dev/null
  then
    echo "release-index-state: transaction journal is malformed" >&2
    return 1
  fi
  old_head=$(jq -r .old_head "$wal_file")
  new_sha=$(jq -r .new_sha "$wal_file")
  old_live_id=$(jq -r '.old_live_id // ""' "$wal_file")
  new_asset_id=$(jq -r .new_asset_id "$wal_file")
  pending_name=$(jq -r .pending_name "$wal_file")
  retired_name=$(jq -r .retired_name "$wal_file")
  if [ "$pending_name" != "${PENDING_PREFIX}${txid}.toml" ] ||
     [ "$retired_name" != "${RETIRED_PREFIX}${txid}.toml" ]; then
    echo "release-index-state: transaction journal names are inconsistent" >&2
    return 1
  fi
  marker_head_value=$(head_sha "$MARKER_HEAD") || return 1
  if [ "$marker_head_value" != "$old_head" ] && [ "$marker_head_value" != "$new_sha" ]; then
    echo "release-index-state: marker head is unrelated to the active transaction" >&2
    return 1
  fi

  new_asset=$(asset_by_id "$new_asset_id")
  [ -n "$new_asset" ] || { echo "release-index-state: transaction pending asset disappeared" >&2; return 1; }
  verify_asset "$new_asset" "$new_sha" || return 1
  case "$(jq -r .name <<<"$new_asset")" in
    "$pending_name"|index.toml) ;;
    *) echo "release-index-state: transaction pending asset has an unexpected name" >&2; return 1 ;;
  esac
  if [ "$marker_head_value" = "$old_head" ]; then
    live=$(asset_by_name index.toml)
    if [ "$old_head" != empty ]; then
      [ -n "$old_live_id" ] || return 1
      old_asset=$(asset_by_id "$old_live_id")
      [ -n "$old_asset" ] || { echo "release-index-state: transaction old asset disappeared" >&2; return 1; }
      old_sha="$old_head"
      verify_asset "$old_asset" "$old_sha" || return 1
      case "$(jq -r .name <<<"$old_asset")" in
        index.toml) patch_asset "$old_live_id" name "$retired_name" ;;
        "$retired_name") ;;
        *) echo "release-index-state: old asset has an unexpected name" >&2; return 1 ;;
      esac
      failpoint after-live-retire
      refresh_state
    elif [ -n "$live" ] && [ "$(jq -r .id <<<"$live")" != "$new_asset_id" ]; then
      echo "release-index-state: an index appeared during empty bootstrap" >&2
      return 1
    fi

    new_asset=$(asset_by_id "$new_asset_id")
    case "$(jq -r .name <<<"$new_asset")" in
      "$pending_name") patch_asset "$new_asset_id" name index.toml ;;
      index.toml) ;;
      *) echo "release-index-state: new asset has an unexpected name" >&2; return 1 ;;
    esac
    failpoint after-live-promote
    refresh_state
    new_file="$TMP_ROOT/promoted-$new_sha"
    live=$(asset_by_name index.toml)
    [ "$(jq -r .id <<<"$live")" = "$new_asset_id" ] || return 1
    download_asset_id "$new_asset_id" "$new_file"
    [ "$(sha256_file "$new_file")" = "$new_sha" ] || return 1
    patch_asset "$MARKER_ID" label "index-head-v1:sha256:${new_sha}"
    failpoint after-marker-commit
    refresh_state
    MARKER_HEAD=$(jq -r '.label // ""' <<<"$(asset_by_id "$MARKER_ID")")
  fi
  verify_live_head "$new_sha"
  refresh_state
  cleanup_transaction_assets "$new_sha"
}

initialize_and_recover() {
  local rc
  refresh_state || rc=$?
  rc=${rc:-0}
  if [ "$rc" -eq 44 ]; then
    echo "release-index-state: release $TARGET_TAG is absent" >&2
    return 44
  fi
  [ "$rc" -eq 0 ] || return 1
  validate_reserved_names
  marker_file
  normalize_marker
  refresh_state
  validate_reserved_names
  recover_transaction
  refresh_state
  normalize_marker
}

read_current() {
  local current live
  initialize_and_recover
  current=$(head_sha "$MARKER_HEAD")
  mkdir -p "$(dirname "$OUTPUT")" "$(dirname "$HEAD_FILE")"
  if [ "$current" = empty ]; then
    cat > "$OUTPUT" <<EOF
abi_version = $EXPECTED_ABI
generated_at = "$(date -u +%FT%TZ)"
generator = "release-index-state empty bootstrap"
EOF
  else
    live=$(asset_by_name index.toml)
    download_asset_id "$(jq -r .id <<<"$live")" "$OUTPUT"
    [ "$(sha256_file "$OUTPUT")" = "$current" ] || return 1
  fi
  printf '%s\n' "$current" > "$HEAD_FILE"
}

publish_index() {
  local current new_sha new_size live old_live_id old_live_size operation txid
  local generation pending_name retired_name wal_name pending wal_file wal
  initialize_and_recover
  current=$(head_sha "$MARKER_HEAD")
  if [ "$current" != "$EXPECTED_HEAD" ]; then
    echo "release-index-state: committed head changed: $current != $EXPECTED_HEAD" >&2
    return 1
  fi
  new_sha=$(sha256_file "$INDEX_PATH")
  new_size=$(file_size "$INDEX_PATH")
  if [ "$new_sha" = "$current" ]; then
    verify_live_head "$current"
    return 0
  fi
  ensure_generation "$new_sha" "$INDEX_PATH"
  failpoint after-generation-upload
  refresh_state
  live=$(asset_by_name index.toml)
  if [ "$current" = empty ]; then
    old_live_id=""
    old_live_size=0
    operation=bootstrap
  else
    [ -n "$live" ] || return 1
    old_live_id=$(jq -r .id <<<"$live")
    old_live_size=$(jq -r .size <<<"$live")
    operation=replace
  fi
  txid=$(sha256_text "v1:${REPOSITORY}:${RELEASE_ID}:${MARKER_ID}:${current}:${old_live_id:-empty}:${new_sha}")
  pending_name="${PENDING_PREFIX}${txid}.toml"
  retired_name="${RETIRED_PREFIX}${txid}.toml"
  wal_name="${WAL_PREFIX}${txid}.json"
  pending=$(upload_exact_asset "$pending_name" "$INDEX_PATH")
  failpoint after-pending-upload
  wal_file="$TMP_ROOT/$wal_name"
  jq -n \
    --arg repo "$REPOSITORY" --arg tag "$TARGET_TAG" --argjson release_id "$RELEASE_ID" \
    --argjson marker_id "$MARKER_ID" --argjson abi "$EXPECTED_ABI" \
    --arg operation "$operation" --arg old_head "$current" \
    --arg old_live_id "$old_live_id" --argjson old_live_size "$old_live_size" \
    --arg new_sha "$new_sha" --argjson new_size "$new_size" \
    --argjson new_asset_id "$(jq -r .id <<<"$pending")" \
    --arg pending_name "$pending_name" --arg retired_name "$retired_name" '
      {
        schema_version: 1, repository: $repo, target_tag: $tag,
        release_id: $release_id, marker_id: $marker_id, abi_version: $abi,
        operation: $operation, old_head: $old_head,
        old_live_id: (if $old_live_id == "" then null else ($old_live_id | tonumber) end),
        old_live_size: $old_live_size, new_sha: $new_sha, new_size: $new_size,
        new_asset_id: $new_asset_id, pending_name: $pending_name,
        retired_name: $retired_name
      }
    ' > "$wal_file"
  wal=$(upload_exact_asset "$wal_name" "$wal_file")
  [ -n "$wal" ]
  failpoint after-wal-upload
  refresh_state
  recover_transaction
  failpoint after-cleanup
}

case "$COMMAND" in
  read) read_current ;;
  snapshot) snapshot_current ;;
  recover) initialize_and_recover ;;
  publish) publish_index ;;
esac
