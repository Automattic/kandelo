#!/usr/bin/env bash
set -euo pipefail

PLAN_FILE=""
ACTIVATED_RECEIPTS_FILE=""
PR_NUMBER=""
CANDIDATE_TAG=""
MAX_PAGES=50
PER_PAGE=100
MAX_ASSET_PAGES=50
ASSET_PER_PAGE=100
MAX_CANDIDATES=20
TARGET_REF="${RECONCILE_TARGET_REF:-HEAD}"
TARGET_BRANCH="${GITHUB_DEFAULT_BRANCH:-}"
RETRY_DELAY_SECONDS="${RECONCILE_RETRY_DELAY_SECONDS:-2}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --plan-file) PLAN_FILE="$2"; shift 2 ;;
    --activated-receipts-file) ACTIVATED_RECEIPTS_FILE="$2"; shift 2 ;;
    --pr-number) PR_NUMBER="$2"; shift 2 ;;
    --candidate-tag) CANDIDATE_TAG="$2"; shift 2 ;;
    --max-pages) MAX_PAGES="$2"; shift 2 ;;
    --per-page) PER_PAGE="$2"; shift 2 ;;
    --max-asset-pages) MAX_ASSET_PAGES="$2"; shift 2 ;;
    --asset-per-page) ASSET_PER_PAGE="$2"; shift 2 ;;
    --max-candidates) MAX_CANDIDATES="$2"; shift 2 ;;
    --target-ref) TARGET_REF="$2"; shift 2 ;;
    --target-branch) TARGET_BRANCH="$2"; shift 2 ;;
    *) echo "reconcile-merge-candidates: unknown flag $1" >&2; exit 2 ;;
  esac
done

if [ -z "$PLAN_FILE" ]; then
  echo "reconcile-merge-candidates: --plan-file is required" >&2
  exit 2
fi
if [ -n "$ACTIVATED_RECEIPTS_FILE" ] &&
   [ "$ACTIVATED_RECEIPTS_FILE" = "$PLAN_FILE" ]; then
  echo "reconcile-merge-candidates: activated receipts and activation plan require distinct files" >&2
  exit 2
fi
if [ -n "$PR_NUMBER" ] && { ! [[ "$PR_NUMBER" =~ ^[0-9]+$ ]] || [ "$PR_NUMBER" = "0" ]; }; then
  echo "reconcile-merge-candidates: --pr-number must be a positive integer" >&2
  exit 2
fi
if ! [[ "$MAX_PAGES" =~ ^[0-9]+$ ]] || [ "$MAX_PAGES" = "0" ]; then
  echo "reconcile-merge-candidates: --max-pages must be a positive integer" >&2
  exit 2
fi
if ! [[ "$PER_PAGE" =~ ^[0-9]+$ ]] || [ "$PER_PAGE" = "0" ] || [ "$PER_PAGE" -gt 100 ]; then
  echo "reconcile-merge-candidates: --per-page must be between 1 and 100" >&2
  exit 2
fi
if ! [[ "$MAX_ASSET_PAGES" =~ ^[0-9]+$ ]] || [ "$MAX_ASSET_PAGES" = "0" ]; then
  echo "reconcile-merge-candidates: --max-asset-pages must be a positive integer" >&2
  exit 2
fi
if ! [[ "$ASSET_PER_PAGE" =~ ^[0-9]+$ ]] || [ "$ASSET_PER_PAGE" = "0" ] || [ "$ASSET_PER_PAGE" -gt 100 ]; then
  echo "reconcile-merge-candidates: --asset-per-page must be between 1 and 100" >&2
  exit 2
fi
if ! [[ "$MAX_CANDIDATES" =~ ^[0-9]+$ ]] || [ "$MAX_CANDIDATES" = "0" ]; then
  echo "reconcile-merge-candidates: --max-candidates must be a positive integer" >&2
  exit 2
fi
if ! [[ "$RETRY_DELAY_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "reconcile-merge-candidates: RECONCILE_RETRY_DELAY_SECONDS must be a non-negative integer" >&2
  exit 2
fi
if [ -z "$TARGET_REF" ] || [ -z "$TARGET_BRANCH" ]; then
  echo "reconcile-merge-candidates: --target-ref and --target-branch are required" >&2
  exit 2
fi
if ! git rev-parse --verify "${TARGET_REF}^{commit}" >/dev/null 2>&1; then
  echo "reconcile-merge-candidates: target ref is not a commit: $TARGET_REF" >&2
  exit 2
fi

REPOSITORY="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY required}"
SERVER_URL="${GITHUB_SERVER_URL:-https://github.com}"
SERVER_URL="${SERVER_URL%/}"
TMP_ROOT="$(mktemp -d)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STATUS_SCRIPT="${STATUS_SCRIPT:-$SCRIPT_DIR/latest-merge-gate-status.sh}"
FIND_RELEASE_SCRIPT="${FIND_RELEASE_SCRIPT:-$SCRIPT_DIR/find-release-by-tag.sh}"
UNSORTED_PLAN="$TMP_ROOT/plan.tsv"
trap 'rm -rf "$TMP_ROOT"' EXIT
: > "$UNSORTED_PLAN"
mkdir -p "$(dirname "$PLAN_FILE")"
: > "$PLAN_FILE"
if [ -n "$ACTIVATED_RECEIPTS_FILE" ]; then
  mkdir -p "$(dirname "$ACTIVATED_RECEIPTS_FILE")"
  : > "$ACTIVATED_RECEIPTS_FILE"
fi

gh_retry() {
  local attempt=1
  local delay="$RETRY_DELAY_SECONDS"
  while true; do
    if "$@"; then
      return 0
    fi
    if [ "$attempt" -ge 4 ]; then
      return 1
    fi
    echo "reconcile-merge-candidates: GitHub command failed; retrying in ${delay}s: $*" >&2
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
}

candidate_pr() {
  local tag="$1"
  if ! [[ "$tag" =~ ^merge-candidate-abi-v[0-9]+-pr-([0-9]+)-run-[0-9]+-attempt-[0-9]+$ ]]; then
    return 1
  fi
  printf '%s\n' "${BASH_REMATCH[1]}"
}

latest_gate_target() {
  MERGE_GATE_STATUS_RETRY_DELAY_SECONDS="$RETRY_DELAY_SECONDS" \
    bash "$STATUS_SCRIPT" --head-sha "$1" --max-pages 50 --per-page 100
}

merge_distance() {
  local merge_sha="$1"
  # Consume the complete rev-list stream. With pipefail, grep -q exits at the
  # first match and can make git report SIGPIPE (141), falsely rejecting a
  # recent commit when the remaining first-parent history fills the pipe.
  if ! git rev-list --first-parent "$TARGET_REF" | grep -Fx "$merge_sha" >/dev/null; then
    echo "reconcile-merge-candidates: merge commit $merge_sha is not on the first-parent history of $TARGET_REF" >&2
    return 1
  fi
  git rev-list --first-parent --count "${merge_sha}..${TARGET_REF}"
}

list_candidate_assets() {
  local release_id="$1"
  local output="$2"
  local page assets count duplicate reached_end=false

  : > "$output"
  for ((page = 1; page <= MAX_ASSET_PAGES; page++)); do
    assets=$(gh_retry gh api "/repos/${REPOSITORY}/releases/${release_id}/assets?per_page=${ASSET_PER_PAGE}&page=${page}")
    if ! jq -e '
        type == "array" and
        all(.[];
          type == "object" and
          (.id | type == "number" and . > 0 and floor == .) and
          (.name | type == "string" and length > 0 and
            (test("[[:cntrl:]]") | not)) and
          (.size | type == "number" and . >= 0 and floor == .))
      ' \
        <<<"$assets" >/dev/null
    then
      echo "reconcile-merge-candidates: release $release_id asset page $page is malformed" >&2
      return 1
    fi
    count=$(jq 'length' <<<"$assets")
    jq -r '.[] | [.id, .name, .size] | @tsv' <<<"$assets" >> "$output"
    if [ "$count" -lt "$ASSET_PER_PAGE" ]; then
      reached_end=true
      break
    fi
  done
  if [ "$reached_end" != "true" ]; then
    echo "reconcile-merge-candidates: release $release_id asset scan reached the ${MAX_ASSET_PAGES}-page safety bound" >&2
    return 1
  fi
  duplicate=$(cut -f1 "$output" | LC_ALL=C sort | uniq -d | sed -n '1p')
  if [ -n "$duplicate" ]; then
    echo "reconcile-merge-candidates: release $release_id contains duplicate asset ID $duplicate" >&2
    return 1
  fi
  duplicate=$(cut -f2 "$output" | LC_ALL=C sort | uniq -d | sed -n '1p')
  if [ -n "$duplicate" ]; then
    echo "reconcile-merge-candidates: release $release_id contains duplicate asset name $duplicate" >&2
    return 1
  fi
}

download_terminal_asset() {
  local asset_id="$1"
  local output="$2"
  local attempt=1 delay="$RETRY_DELAY_SECONDS"
  local attempt_file="$output.attempt"

  while true; do
    : > "$attempt_file"
    if gh api "/repos/${REPOSITORY}/releases/assets/${asset_id}" \
        -H 'Accept: application/octet-stream' > "$attempt_file"
    then
      mv "$attempt_file" "$output"
      return 0
    fi
    if [ "$attempt" -ge 4 ]; then
      rm -f "$attempt_file"
      return 1
    fi
    echo "reconcile-merge-candidates: GitHub command failed; retrying in ${delay}s: release asset $asset_id" >&2
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
}

validate_terminal_marker() {
  local tag="$1"
  local pr="$2"
  local release_id="$3"
  local inventory="$4"
  local marker_name="$5"
  local row asset_id declared_size marker actual_size
  local ready_row ready_asset_id ready_declared_size ready actual_ready_size

  row=$(awk -F '\t' -v name="$marker_name" '$2 == name { print; exit }' \
    "$inventory")
  IFS=$'\t' read -r asset_id _ declared_size <<< "$row"
  if ! [[ "$asset_id" =~ ^[1-9][0-9]*$ ]] ||
     ! [[ "$declared_size" =~ ^[0-9]+$ ]]
  then
    echo "reconcile-merge-candidates: release $tag has malformed terminal asset identity" >&2
    return 1
  fi
  if [ "$declared_size" -gt 1048576 ]; then
    echo "reconcile-merge-candidates: release $tag terminal marker is too large" >&2
    return 1
  fi

  marker="$TMP_ROOT/terminal-$release_id-$marker_name"
  if ! download_terminal_asset "$asset_id" "$marker"; then
    echo "reconcile-merge-candidates: failed to download terminal marker for $tag" >&2
    return 1
  fi
  actual_size=$(wc -c < "$marker" | tr -d '[:space:]')
  if [ "$actual_size" != "$declared_size" ]; then
    echo "reconcile-merge-candidates: release $tag terminal marker size differs from its asset inventory" >&2
    return 1
  fi

  case "$marker_name" in
    rejected.json)
      if ! jq -e \
          --arg repository "$REPOSITORY" \
          --arg tag "$tag" \
          --argjson pr "$pr" '
          type == "object" and
          .disposition_schema_version == 1 and
          .disposition == "rejected" and
          .repository == $repository and
          .candidate_tag == $tag and
          .pr_number == $pr and
          (.rejection_reason | type == "string" and
            test("^[a-z0-9-]+$")) and
          (.merge_commit_sha == null or
            (.merge_commit_sha | type == "string" and
              test("^[0-9a-f]{40}$"))) and
          (.rejected_at | type == "string" and length > 0) and
          (.activation_run | type == "string" and length > 0)
        ' "$marker" >/dev/null
      then
        echo "reconcile-merge-candidates: release $tag terminal rejection marker is malformed" >&2
        return 1
      fi
      ;;
    activated.json)
      if ! jq -e \
          --arg repository "$REPOSITORY" \
          --arg tag "$tag" \
          --argjson pr "$pr" '
          type == "object" and
          .schema_version == 1 and
          .repository == $repository and
          .candidate_tag == $tag and
          .pr_number == $pr and
          (.candidate_index_sha256 | type == "string" and
            test("^[0-9a-f]{64}$")) and
          (.ready_at | type == "string" and length > 0) and
          (.merge_commit_sha | type == "string" and
            test("^[0-9a-f]{40}$")) and
          (.canonical_index_sha256 | type == "string" and
            test("^[0-9a-f]{64}$")) and
          (.activated_at | type == "string" and length > 0) and
          (.activation_run | type == "string" and length > 0)
        ' "$marker" >/dev/null
      then
        echo "reconcile-merge-candidates: release $tag terminal activation marker is malformed" >&2
        return 1
      fi
      ready_row=$(awk -F '\t' '$2 == "ready.json" { print; exit }' \
        "$inventory")
      IFS=$'\t' read -r ready_asset_id _ ready_declared_size \
        <<< "$ready_row"
      if ! [[ "$ready_asset_id" =~ ^[1-9][0-9]*$ ]] ||
         ! [[ "$ready_declared_size" =~ ^[0-9]+$ ]]
      then
        echo "reconcile-merge-candidates: release $tag has no valid ready marker identity" >&2
        return 1
      fi
      if [ "$ready_declared_size" -gt 1048576 ]; then
        echo "reconcile-merge-candidates: release $tag ready marker is too large" >&2
        return 1
      fi
      ready="$TMP_ROOT/ready-$release_id.json"
      if ! download_terminal_asset "$ready_asset_id" "$ready"; then
        echo "reconcile-merge-candidates: failed to download ready marker for $tag" >&2
        return 1
      fi
      actual_ready_size=$(wc -c < "$ready" | tr -d '[:space:]')
      if [ "$actual_ready_size" != "$ready_declared_size" ]; then
        echo "reconcile-merge-candidates: release $tag ready marker size differs from its asset inventory" >&2
        return 1
      fi
      jq -S \
        'del(.merge_commit_sha, .canonical_index_sha256, .activated_at, .activation_run)' \
        "$marker" > "$TMP_ROOT/activated-identity-$release_id.json"
      jq -S . "$ready" > "$TMP_ROOT/ready-identity-$release_id.json"
      if ! cmp "$TMP_ROOT/activated-identity-$release_id.json" \
          "$TMP_ROOT/ready-identity-$release_id.json" >/dev/null
      then
        echo "reconcile-merge-candidates: release $tag activation marker conflicts with ready marker" >&2
        return 1
      fi
      ;;
    *)
      echo "reconcile-merge-candidates: unsupported terminal marker $marker_name" >&2
      return 1
      ;;
  esac
}

plan_candidate() {
  local tag="$1"
  local targeted="$2"
  local discovered_release_id="${3:-}"
  local pr release_json release_id asset_inventory pr_json state merged_at head_sha target_url expected_url
  local merge_sha base_ref distance release_file marker_name
  local activated_count rejected_count find_rc=0

  if ! pr=$(candidate_pr "$tag"); then
    if [ "$targeted" = "true" ]; then
      echo "reconcile-merge-candidates: invalid candidate tag: $tag" >&2
      return 1
    fi
    echo "reconcile-merge-candidates: ignoring malformed candidate-like tag $tag" >&2
    return 0
  fi
  if [ -n "$PR_NUMBER" ] && [ "$pr" != "$PR_NUMBER" ]; then
    if [ "$targeted" = "true" ]; then
      echo "reconcile-merge-candidates: candidate $tag does not belong to PR #$PR_NUMBER" >&2
      return 1
    fi
    return 0
  fi

  if [ -n "$discovered_release_id" ]; then
    if ! [[ "$discovered_release_id" =~ ^[1-9][0-9]*$ ]]; then
      echo "reconcile-merge-candidates: malformed discovered release ID for $tag" >&2
      return 1
    fi
    release_json=$(gh_retry gh api \
      "/repos/${REPOSITORY}/releases/${discovered_release_id}")
  else
    release_file="$TMP_ROOT/release-by-tag.json"
    # WHY: ready candidates remain drafts until activation records a terminal
    # receipt. GitHub returns 404 for those releases by tag, so targeted
    # recovery must use the authenticated list and bind the one exact match.
    FIND_RELEASE_MAX_PAGES="$MAX_PAGES" \
      FIND_RELEASE_PER_PAGE="$PER_PAGE" \
      FIND_RELEASE_RETRY_DELAY_SECONDS="$RETRY_DELAY_SECONDS" \
      bash "$FIND_RELEASE_SCRIPT" \
        --tag "$tag" \
        --output-file "$release_file" || find_rc=$?
    if [ "$find_rc" -eq 44 ]; then
      echo "reconcile-merge-candidates: candidate release $tag was not found" >&2
      return 1
    fi
    [ "$find_rc" -eq 0 ] || return "$find_rc"
    release_json="$(cat "$release_file")"
  fi
  if ! jq -e \
      --arg tag "$tag" \
      --arg discovered_release_id "$discovered_release_id" \
      '(.tag_name == $tag) and (.prerelease == true) and
       (.id | (type == "number" and . > 0 and floor == .)) and
       ($discovered_release_id == "" or
        .id == ($discovered_release_id | tonumber)) and
       (.draft | type == "boolean") and
       (.immutable | type == "boolean")' \
      <<<"$release_json" >/dev/null
  then
    echo "reconcile-merge-candidates: release $tag does not satisfy the candidate release contract" >&2
    return 1
  fi
  release_id=$(jq -r .id <<<"$release_json")
  asset_inventory="$TMP_ROOT/assets-$release_id"
  list_candidate_assets "$release_id" "$asset_inventory"

  activated_count=$(awk -F '\t' '$2 == "activated.json" { count++ }
    END { print count + 0 }' "$asset_inventory")
  rejected_count=$(awk -F '\t' '$2 == "rejected.json" { count++ }
    END { print count + 0 }' "$asset_inventory")
  if [ "$activated_count" -gt 0 ] && [ "$rejected_count" -gt 0 ]; then
    echo "reconcile-merge-candidates: release $tag contains both terminal markers" >&2
    return 1
  fi
  if [ "$activated_count" -gt 0 ] || [ "$rejected_count" -gt 0 ]; then
    if [ "$activated_count" -gt 0 ]; then
      marker_name=activated.json
    else
      marker_name=rejected.json
    fi
    validate_terminal_marker \
      "$tag" "$pr" "$release_id" "$asset_inventory" "$marker_name"
  fi
  if [ "$activated_count" -gt 0 ]; then
    if [ -n "$ACTIVATED_RECEIPTS_FILE" ]; then
      jq -c . "$TMP_ROOT/terminal-$release_id-activated.json" \
        >> "$ACTIVATED_RECEIPTS_FILE"
    fi
    if jq -e '.draft == true and .immutable == false' \
        <<<"$release_json" >/dev/null
    then
      # WHY: activation uploads its authenticated receipt before sealing the
      # candidate. A crash in that interval must reach the activation
      # transaction's finalize-only idempotent path on the next sweep.
      echo "reconcile-merge-candidates: recovering activated draft $tag"
    elif jq -e '
        .draft == false and
        (.immutable == true or .immutable == false)
      ' <<<"$release_json" >/dev/null
    then
      # immutable=true is the current terminal lifecycle. false/false is the
      # historical published-mutable lifecycle and is accepted only after the
      # exact ready/activated identity check above.
      echo "reconcile-merge-candidates: skipping activated candidate $tag"
      return 0
    else
      echo "reconcile-merge-candidates: release $tag has an invalid activated lifecycle" >&2
      return 1
    fi
  fi
  if [ "$rejected_count" -gt 0 ]; then
    if ! jq -e '
        .draft == false and
        (.immutable == true or .immutable == false)
      ' <<<"$release_json" >/dev/null
    then
      echo "reconcile-merge-candidates: release $tag has an unfinished rejected lifecycle" >&2
      return 1
    fi
    echo "reconcile-merge-candidates: skipping terminally rejected candidate $tag"
    return 0
  fi

  if ! jq -e '
      (.draft == true and .immutable == false) or
      (.draft == false and .immutable == true)
    ' <<<"$release_json" >/dev/null
  then
    echo "reconcile-merge-candidates: release $tag does not satisfy the candidate release contract" >&2
    return 1
  fi
  if ! awk -F '\t' '$2 == "ready.json" { found = 1 }
      END { exit(found ? 0 : 1) }' "$asset_inventory"
  then
    echo "reconcile-merge-candidates: skipping unready candidate $tag"
    return 0
  fi

  pr_json=$(gh_retry gh api "/repos/${REPOSITORY}/pulls/${pr}")
  if ! jq -e \
      '(.state == "open" or .state == "closed") and
       (.merged_at == null or
        (.merged_at | type == "string" and
         test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))) and
       (.head.sha | type == "string" and test("^[0-9a-f]{40}$")) and
       (.merge_commit_sha == null or
        (.merge_commit_sha | type == "string" and test("^[0-9a-f]{40}$"))) and
       (.base.ref | type == "string" and length > 0)' \
      <<<"$pr_json" >/dev/null
  then
    echo "reconcile-merge-candidates: PR #$pr response is malformed" >&2
    return 1
  fi
  state=$(jq -r .state <<<"$pr_json")
  merged_at=$(jq -r '.merged_at // ""' <<<"$pr_json")
  if [ "$state" = "open" ]; then
    echo "reconcile-merge-candidates: skipping $tag while PR #$pr is open"
    return 0
  fi
  if [ -z "$merged_at" ]; then
    echo "reconcile-merge-candidates: skipping abandoned candidate $tag (PR #$pr closed without merging)"
    return 0
  fi
  base_ref=$(jq -r .base.ref <<<"$pr_json")
  if [ "$base_ref" != "$TARGET_BRANCH" ]; then
    echo "reconcile-merge-candidates: merged PR #$pr targets $base_ref, not reconciled branch $TARGET_BRANCH" >&2
    return 1
  fi
  merge_sha=$(jq -r .merge_commit_sha <<<"$pr_json")
  if [ "$merge_sha" = null ] || ! distance=$(merge_distance "$merge_sha"); then
    echo "reconcile-merge-candidates: cannot prove branch order for PR #$pr" >&2
    return 1
  fi
  if [ "$activated_count" -gt 0 ] &&
     [ "$(jq -r .merge_commit_sha \
        "$TMP_ROOT/terminal-$release_id-activated.json")" != "$merge_sha" ]
  then
    echo "reconcile-merge-candidates: release $tag activation marker conflicts with merged PR commit" >&2
    return 1
  fi

  head_sha=$(jq -r .head.sha <<<"$pr_json")
  target_url=$(latest_gate_target "$head_sha")
  expected_url="${SERVER_URL}/${REPOSITORY}/releases/tag/${tag}"
  if [ "$target_url" != "$expected_url" ]; then
    if [ "$targeted" = "true" ]; then
      echo "reconcile-merge-candidates: latest successful merge-gate for PR #$pr does not select $tag" >&2
      return 1
    fi
    echo "reconcile-merge-candidates: skipping non-authoritative candidate $tag"
    return 0
  fi

  printf '%012d\t%s\t%s\t%s\n' "$distance" "$merged_at" "$pr" "$tag" >> "$UNSORTED_PLAN"
}

resolve_pr_candidate() {
  local pr="$1"
  local pr_json head_sha target_url prefix tag

  pr_json=$(gh_retry gh api "/repos/${REPOSITORY}/pulls/${pr}")
  if ! jq -e '(.head.sha | type == "string" and test("^[0-9a-f]{40}$"))' \
      <<<"$pr_json" >/dev/null
  then
    echo "reconcile-merge-candidates: PR #$pr response has no valid head SHA" >&2
    return 1
  fi
  head_sha=$(jq -r .head.sha <<<"$pr_json")
  target_url=$(latest_gate_target "$head_sha")
  prefix="${SERVER_URL}/${REPOSITORY}/releases/tag/"
  case "$target_url" in
    "$prefix"*) tag="${target_url#"$prefix"}" ;;
    "")
      echo "reconcile-merge-candidates: PR #$pr has no successful package merge-gate candidate"
      return 0
      ;;
    *)
      echo "reconcile-merge-candidates: PR #$pr merge-gate target is not a candidate in $REPOSITORY" >&2
      return 1
      ;;
  esac
  plan_candidate "$tag" true
}

if [ -n "$CANDIDATE_TAG" ]; then
  plan_candidate "$CANDIDATE_TAG" true
elif [ -n "$PR_NUMBER" ]; then
  resolve_pr_candidate "$PR_NUMBER"
else
  releases_file="$TMP_ROOT/candidate-releases.tsv"
  : > "$releases_file"
  reached_end=false
  for ((page = 1; page <= MAX_PAGES; page++)); do
    releases=$(gh_retry gh api "/repos/${REPOSITORY}/releases?per_page=${PER_PAGE}&page=${page}")
    if ! jq -e '
        type == "array" and
        all(.[];
          type == "object" and
          (.id | (type == "number" and . > 0 and floor == .)) and
          (.tag_name | (type == "string" and length > 0 and
            (test("[[:cntrl:]]") | not))) and
          (.draft | type == "boolean") and
          (.prerelease | type == "boolean") and
          (.immutable | type == "boolean") and
          ((.draft and .immutable) | not))
      ' <<<"$releases" >/dev/null
    then
      echo "reconcile-merge-candidates: release page $page is malformed" >&2
      exit 1
    fi
    count=$(jq 'length' <<<"$releases")
    jq -r '
      .[] |
      select(.tag_name | startswith("merge-candidate-abi-v")) |
      [.id, .tag_name] | @tsv
    ' <<<"$releases" >> "$releases_file"
    if [ "$count" -lt "$PER_PAGE" ]; then
      reached_end=true
      break
    fi
  done
  if [ "$reached_end" != "true" ]; then
    echo "reconcile-merge-candidates: release scan reached the ${MAX_PAGES}-page safety bound; use a targeted manual run" >&2
    exit 1
  fi

  if [ -n "$(cut -f1 "$releases_file" | LC_ALL=C sort | uniq -d)" ]; then
    echo "reconcile-merge-candidates: release scan contains duplicate candidate IDs" >&2
    exit 1
  fi
  if [ -n "$(cut -f2 "$releases_file" | LC_ALL=C sort | uniq -d)" ]; then
    echo "reconcile-merge-candidates: multiple releases claim one candidate tag" >&2
    exit 1
  fi
  LC_ALL=C sort -t $'\t' -k2,2 "$releases_file" -o "$releases_file"
  while IFS=$'\t' read -r release_id tag; do
    [ -n "$tag" ] || continue
    plan_candidate "$tag" false "$release_id"
  done < "$releases_file"
fi

if [ -s "$UNSORTED_PLAN" ]; then
  # First-parent distance is the branch order. Timestamps have only second
  # precision and PR numbers do not encode merge order.
  sorted_plan="$TMP_ROOT/sorted-plan.tsv"
  LC_ALL=C sort -u -t $'\t' -k1,1n -k3,3n -k4,4 "$UNSORTED_PLAN" \
    | cut -f2- > "$sorted_plan"
  planned_count=$(wc -l < "$sorted_plan" | tr -d '[:space:]')
  if [ "$planned_count" -gt "$MAX_CANDIDATES" ]; then
    echo "reconcile-merge-candidates: limiting this run to $MAX_CANDIDATES of $planned_count candidates; later schedules will drain the backlog" >&2
    sed -n "1,${MAX_CANDIDATES}p" "$sorted_plan" > "$PLAN_FILE"
  else
    cp "$sorted_plan" "$PLAN_FILE"
  fi
fi

candidate_count=$(wc -l < "$PLAN_FILE" | tr -d '[:space:]')
echo "reconcile-merge-candidates: planned $candidate_count candidate(s), newest merge first"
