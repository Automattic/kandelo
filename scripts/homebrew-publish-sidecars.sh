#!/usr/bin/env bash
# Commit generated Kandelo sidecars to a tap, or record a failed attempt
# without overwriting last-green metadata.
set -euo pipefail

KANDELO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=/dev/null
. "$KANDELO_ROOT/scripts/homebrew-publication-limits.sh"
TAP_ROOT=""
SIDECAR_ROOT=""
PUBLICATION_HANDOFF=""
FORMULA=""
ARCH=""
RELEASE_TAG=""
STATUS=""
ERROR_TEXT=""
KANDELO_COMMIT=""
TAP_COMMIT=""
REASON_TEXT=""
ROLLBACK_REF=""
DELETED_PACKAGE_URL=""
DELETION_REASON=""
REPAIR_ONLY=0
DRY_RUN=0
NO_LOCK=0
PUBLISH_BRANCH=""
COMPOSE_PARENT=""
COMPOSE_ROOT=""

usage() {
  cat >&2 <<'EOF'
usage: scripts/homebrew-publish-sidecars.sh --tap-root <tap-root> --formula <name> --arch <wasm32|wasm64> --release-tag <tag> --status <success|failed|rollback> [--kandelo-commit <sha>] [--tap-commit <sha>] [--publication-handoff <dir>] [--sidecar-root <dir>] [--error <text>] [--reason <text>] [--rollback-ref <ref>] [--deleted-package-url <url> --deletion-reason <text>] [--repair-only] [--dry-run] [--no-lock]

Success either composes a validated package-scoped --publication-handoff
against refreshed tap state or publishes a generated --sidecar-root payload,
then validates it with xtask homebrew-validate. Failed and rollback attempts
either publish a validated non-success sidecar payload or, when --sidecar-root
is absent, write an attempt report under Kandelo/reports while leaving
metadata.json untouched so last-green metadata is preserved. Package deletion is
exceptional and must include both --deleted-package-url and --deletion-reason.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --kandelo-root) KANDELO_ROOT="${2:-}"; shift 2 ;;
    --tap-root) TAP_ROOT="${2:-}"; shift 2 ;;
    --sidecar-root) SIDECAR_ROOT="${2:-}"; shift 2 ;;
    --publication-handoff) PUBLICATION_HANDOFF="${2:-}"; shift 2 ;;
    --formula) FORMULA="${2:-}"; shift 2 ;;
    --arch) ARCH="${2:-}"; shift 2 ;;
    --release-tag) RELEASE_TAG="${2:-}"; shift 2 ;;
    --status) STATUS="${2:-}"; shift 2 ;;
    --error) ERROR_TEXT="${2:-}"; shift 2 ;;
    --kandelo-commit) KANDELO_COMMIT="${2:-}"; shift 2 ;;
    --tap-commit) TAP_COMMIT="${2:-}"; shift 2 ;;
    --reason) REASON_TEXT="${2:-}"; shift 2 ;;
    --rollback-ref) ROLLBACK_REF="${2:-}"; shift 2 ;;
    --deleted-package-url) DELETED_PACKAGE_URL="${2:-}"; shift 2 ;;
    --deletion-reason) DELETION_REASON="${2:-}"; shift 2 ;;
    --repair-only) REPAIR_ONLY=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --no-lock) NO_LOCK=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "homebrew-publish-sidecars.sh: unknown flag $1" >&2; usage; exit 2 ;;
  esac
done

require() {
  local name="$1" value="$2"
  if [ -z "$value" ]; then
    echo "homebrew-publish-sidecars.sh: --$name is required" >&2
    exit 2
  fi
}

require tap-root "$TAP_ROOT"
require formula "$FORMULA"
require arch "$ARCH"
require release-tag "$RELEASE_TAG"
require status "$STATUS"

if ! [[ "$FORMULA" =~ ^[a-z0-9][a-z0-9._-]*$ ]]; then
  echo "homebrew-publish-sidecars.sh: invalid formula name: $FORMULA" >&2
  exit 2
fi
case "$ARCH" in
  wasm32|wasm64) ;;
  *) echo "homebrew-publish-sidecars.sh: invalid arch: $ARCH" >&2; exit 2 ;;
esac
case "$STATUS" in
  success|failed|rollback) ;;
  *) echo "homebrew-publish-sidecars.sh: --status must be success, failed, or rollback" >&2; exit 2 ;;
esac
if [ "$REPAIR_ONLY" = "1" ] && [ "$STATUS" != "success" ]; then
  echo "homebrew-publish-sidecars.sh: --repair-only is only valid with --status success" >&2
  exit 2
fi
if [ "$STATUS" = "rollback" ] && [ -z "$REASON_TEXT" ]; then
  echo "homebrew-publish-sidecars.sh: --reason is required for rollback" >&2
  exit 2
fi
if [ -n "$DELETED_PACKAGE_URL" ] && [ -z "$DELETION_REASON" ]; then
  echo "homebrew-publish-sidecars.sh: --deletion-reason is required when --deleted-package-url is set" >&2
  exit 2
fi
if [ -n "$DELETION_REASON" ] && [ -z "$DELETED_PACKAGE_URL" ]; then
  echo "homebrew-publish-sidecars.sh: --deleted-package-url is required when --deletion-reason is set" >&2
  exit 2
fi
if [ ! -d "$TAP_ROOT/.git" ]; then
  echo "homebrew-publish-sidecars.sh: tap root must be a git checkout: $TAP_ROOT" >&2
  exit 2
fi
if [ -z "$KANDELO_COMMIT" ]; then
  KANDELO_COMMIT="$(git -C "$KANDELO_ROOT" rev-parse HEAD)"
fi
if [ -z "$TAP_COMMIT" ]; then
  TAP_COMMIT="$(git -C "$TAP_ROOT" rev-parse HEAD)"
fi
if ! [[ "$KANDELO_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  echo "homebrew-publish-sidecars.sh: invalid Kandelo commit: $KANDELO_COMMIT" >&2
  exit 2
fi
if ! [[ "$TAP_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  echo "homebrew-publish-sidecars.sh: invalid tap commit: $TAP_COMMIT" >&2
  exit 2
fi

STATE_LOCK_SCRIPT="$KANDELO_ROOT/.github/scripts/state-lock.sh"
LOCK_SUBJECT="homebrew-tap-publish"
LOCK_HELD=0

acquire_lock() {
  if [ "$NO_LOCK" = "1" ] || [ "$DRY_RUN" = "1" ]; then
    return 0
  fi
  (cd "$TAP_ROOT" && bash "$STATE_LOCK_SCRIPT" acquire "$LOCK_SUBJECT")
  LOCK_HELD=1
}

release_lock() {
  if [ "$LOCK_HELD" = "1" ]; then
    (cd "$TAP_ROOT" && bash "$STATE_LOCK_SCRIPT" release) || true
  fi
}

refresh_tap() {
  local branch head remote_head
  if [ -n "$(git -C "$TAP_ROOT" status --short)" ]; then
    echo "homebrew-publish-sidecars.sh: tap checkout must be clean before publication" >&2
    exit 1
  fi
  if [ "$DRY_RUN" = "1" ]; then
    return 0
  fi
  branch="$(git -C "$TAP_ROOT" symbolic-ref --quiet --short HEAD || true)"
  if [ -z "$branch" ]; then
    echo "homebrew-publish-sidecars.sh: write publication requires an attached tap branch" >&2
    exit 1
  fi
  if [ "$branch" != "main" ]; then
    echo "homebrew-publish-sidecars.sh: write publication requires tap main, got $branch" >&2
    exit 1
  fi
  git -C "$TAP_ROOT" fetch origin "+refs/heads/$branch:refs/remotes/origin/$branch"
  git -C "$TAP_ROOT" merge --ff-only "origin/$branch"
  head="$(git -C "$TAP_ROOT" rev-parse HEAD)"
  remote_head="$(git -C "$TAP_ROOT" rev-parse "origin/$branch")"
  if [ "$head" != "$remote_head" ]; then
    echo "homebrew-publish-sidecars.sh: tap checkout must match origin/$branch after refresh" >&2
    exit 1
  fi
  PUBLISH_BRANCH="$branch"
}

tap_status() {
  git -C "$TAP_ROOT" status --short
}

commit_and_push() {
  local message="$1"
  if [ -z "$(tap_status)" ]; then
    echo "homebrew-publish-sidecars.sh: tap already up to date"
    return 0
  fi
  if ! git -C "$TAP_ROOT" config user.name >/dev/null; then
    git -C "$TAP_ROOT" config user.name "github-actions[bot]"
  fi
  if ! git -C "$TAP_ROOT" config user.email >/dev/null; then
    git -C "$TAP_ROOT" config user.email "41898282+github-actions[bot]@users.noreply.github.com"
  fi
  git -C "$TAP_ROOT" add Formula Kandelo
  git -C "$TAP_ROOT" commit -m "$message"
  if [ "$DRY_RUN" = "1" ]; then
    echo "homebrew-publish-sidecars.sh: dry-run, not pushing tap commit"
  else
    if [ -z "$PUBLISH_BRANCH" ] ||
       [ "$(git -C "$TAP_ROOT" symbolic-ref --quiet --short HEAD || true)" != "$PUBLISH_BRANCH" ]; then
      echo "homebrew-publish-sidecars.sh: tap publication branch changed after refresh" >&2
      exit 1
    fi
    git -C "$TAP_ROOT" push origin "HEAD:refs/heads/$PUBLISH_BRANCH"
  fi
}

run_validator() {
  local root="${1:-$TAP_ROOT}" host
  host="$(rustc -vV | awk '/^host/ {print $2}')"
  (
    cd "$KANDELO_ROOT"
    cargo run --release -p xtask --target "$host" --quiet -- \
      homebrew-validate --tap-root "$root"
  )
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

require_max_size() {
  local label="$1" path="$2" maximum="$3" bytes
  if [ ! -f "$path" ] || [ -L "$path" ]; then
    echo "homebrew-publish-sidecars.sh: $label must be a regular non-symlink file: $path" >&2
    exit 1
  fi
  bytes="$(wc -c <"$path" | tr -d '[:space:]')"
  if [ "$bytes" -gt "$maximum" ]; then
    echo "homebrew-publish-sidecars.sh: $label exceeds $maximum bytes: $path" >&2
    exit 1
  fi
}

assert_sidecar_size_bounds() {
  local root="$1" path
  require_max_size "metadata.json" "$root/Kandelo/metadata.json" "$HOMEBREW_MAX_SIDECAR_JSON_BYTES"
  for directory in "$root/Formula" "$root/Kandelo/formula" "$root/Kandelo/link" "$root/Kandelo/reports"; do
    [ -d "$directory" ] || continue
    while IFS= read -r -d '' path; do
      case "$path" in
        "$root/Formula/"*) require_max_size "Formula" "$path" "$HOMEBREW_MAX_FORMULA_BYTES" ;;
        "$root/Kandelo/formula/"*) require_max_size "formula JSON" "$path" "$HOMEBREW_MAX_SIDECAR_JSON_BYTES" ;;
        "$root/Kandelo/link/"*) require_max_size "link JSON" "$path" "$HOMEBREW_MAX_SIDECAR_JSON_BYTES" ;;
        "$root/Kandelo/reports/"*) require_max_size "report JSON" "$path" "$HOMEBREW_MAX_PROVENANCE_BYTES" ;;
      esac
    done < <(find "$directory" -type f -print0)
  done
}

assert_static_tap_tree() {
  local root="$1" label="$2" path bad bad_mode
  for path in "$root/Formula" "$root/Kandelo"; do
    if [ -L "$path" ] || { [ -e "$path" ] && [ ! -d "$path" ]; }; then
      echo "homebrew-publish-sidecars.sh: $label contains a non-directory ${path#"$root/"} root" >&2
      exit 1
    fi
    [ -d "$path" ] || continue
    bad="$(find "$path" -mindepth 1 \( -type l -o \( ! -type f -a ! -type d \) \) -print -quit)"
    if [ -n "$bad" ]; then
      echo "homebrew-publish-sidecars.sh: $label contains a symlink or special file: ${bad#"$root/"}" >&2
      exit 1
    fi
  done

  if git -C "$root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    bad_mode="$(git -C "$root" ls-files -s -- Formula Kandelo |
      awk '$1 != "100644" && $1 != "100755" { print; exit }')"
    if [ -n "$bad_mode" ]; then
      echo "homebrew-publish-sidecars.sh: $label contains an unsafe tracked object: $bad_mode" >&2
      exit 1
    fi
  fi
}

sibling_bottle_policy() {
  local metadata="$1" name="$2" version="$3" formula_revision="$4" rebuild="$5" abi="$6"
  if [ ! -e "$metadata" ]; then
    printf '%s\n' discard
    return 0
  fi
  if [ ! -f "$metadata" ] || [ -L "$metadata" ]; then
    echo "homebrew-publish-sidecars.sh: refreshed metadata is not a regular file" >&2
    return 1
  fi

  jq -er \
    --arg name "$name" \
    --arg version "$version" \
    --argjson formula_revision "$formula_revision" \
    --argjson rebuild "$rebuild" \
    --argjson abi "$abi" '
      if type != "object" or (.packages | type) != "array" then
        error("refreshed metadata lacks a packages array")
      else
        [.packages[] | select(.name == $name)] as $matches |
        if ($matches | length) > 1 then
          error("refreshed metadata contains duplicate package identities")
        elif .kandelo_abi == $abi and ($matches | length) == 1 and
             $matches[0].version == $version and
             $matches[0].formula_revision == $formula_revision and
             $matches[0].bottle_rebuild == $rebuild then
          "preserve"
        else
          "discard"
        end
      end
    ' "$metadata"
}

compose_publication_handoff() {
  local handoff input manifest receipt bottle formula_path formula_sha
  local input_tap_commit input_kandelo_commit bottle_sha bottle_url bottle_bytes
  local bottle_root relocation_cellar rebuild tag planned_formula composed_formula
  local planned_digest refreshed_digest host previous_metadata version formula_revision
  local kandelo_abi sibling_policy formula_stage publish_stage kandelo_stage kandelo_previous
  local -a sidecar_args

  if [ -z "$PUBLICATION_HANDOFF" ] || [ ! -d "$PUBLICATION_HANDOFF" ] || [ -L "$PUBLICATION_HANDOFF" ]; then
    echo "homebrew-publish-sidecars.sh: --publication-handoff must name a validated data directory" >&2
    exit 2
  fi
  handoff="$(cd "$PUBLICATION_HANDOFF" && pwd -P)"
  input="$handoff/composition/sidecars-input.json"
  manifest="$handoff/build/manifest.json"
  receipt="$handoff/receipt.json"
  bottle="$handoff/build/bottle.tar.gz"
  for file in "$input" "$manifest" "$receipt" "$bottle"; do
    if [ ! -f "$file" ] || [ -L "$file" ]; then
      echo "homebrew-publish-sidecars.sh: publication handoff lacks regular file ${file#"$handoff"/}" >&2
      exit 1
    fi
  done

  formula_path="$(jq -er '.packages[0].formula_path' "$input")"
  formula_sha="$(jq -er '.packages[0].formula_source_sha256' "$input")"
  input_tap_commit="$(jq -er '.tap_commit' "$input")"
  input_kandelo_commit="$(jq -er '.kandelo_commit' "$input")"
  version="$(jq -er '.packages[0].version | select(type == "string")' "$input")"
  formula_revision="$(jq -er '.packages[0].formula_revision | select(type == "number" and . >= 0 and floor == .)' "$input")"
  rebuild="$(jq -er '.packages[0].bottle_rebuild | select(type == "number" and . >= 0 and floor == .)' "$input")"
  kandelo_abi="$(jq -er '.kandelo_abi | select(type == "number" and . >= 0 and floor == .)' "$input")"
  tag="${ARCH}_kandelo"
  bottle_sha="$(jq -er '.bottle.sha256' "$receipt")"
  bottle_url="$(jq -er '.bottle.url' "$receipt")"
  bottle_bytes="$(jq -er '.bottle.bytes' "$receipt")"
  bottle_root="$(jq -er '.bottle_root_url' "$manifest")"
  relocation_cellar="$(jq -er '.bottle.cellar' "$manifest")"

  jq -e \
    --arg formula "$FORMULA" --arg arch "$ARCH" --arg tag "$tag" \
    --arg release_tag "$RELEASE_TAG" --arg tap_commit "$TAP_COMMIT" \
    --arg kandelo_commit "$KANDELO_COMMIT" --arg sha "$bottle_sha" \
    --arg url "$bottle_url" '
      .schema == 1 and .release_tag == $release_tag and
      .tap_repository == "Automattic/kandelo-homebrew" and
      .tap_commit == $tap_commit and .kandelo_commit == $kandelo_commit and
      (.packages | length) == 1 and
      .packages[0].name == $formula and
      .packages[0].formula_path == ("Formula/" + $formula + ".rb") and
      (.packages[0].formula_source_sha256 | test("^[0-9a-f]{64}$")) and
      (.packages[0].bottles | length) == 1 and
      .packages[0].bottles[0].arch == $arch and
      .packages[0].bottles[0].bottle_tag == $tag and
      .packages[0].bottles[0].status == "success" and
      .packages[0].bottles[0].bottle_file == "../build/bottle.tar.gz" and
      .packages[0].bottles[0].cache_key_sha == $sha and
      .packages[0].bottles[0].url == $url
    ' "$input" >/dev/null || {
      echo "homebrew-publish-sidecars.sh: publication composition input does not match the planned bottle" >&2
      exit 1
    }
  [ "$input_tap_commit" = "$TAP_COMMIT" ] && [ "$input_kandelo_commit" = "$KANDELO_COMMIT" ] || {
    echo "homebrew-publish-sidecars.sh: publication input source commits differ from the plan" >&2
    exit 1
  }
  [ "$(sha256_file "$bottle")" = "$bottle_sha" ] || {
    echo "homebrew-publish-sidecars.sh: publication bottle sha256 differs from its receipt" >&2
    exit 1
  }
  [ "$(wc -c <"$bottle" | tr -d '[:space:]')" = "$bottle_bytes" ] || {
    echo "homebrew-publish-sidecars.sh: publication bottle byte count differs from its receipt" >&2
    exit 1
  }

  COMPOSE_PARENT="$(mktemp -d)"
  COMPOSE_ROOT="$COMPOSE_PARENT/tap"
  git -C "$TAP_ROOT" worktree add --detach "$COMPOSE_ROOT" HEAD >/dev/null
  assert_static_tap_tree "$COMPOSE_ROOT" "refreshed composition tap"
  if ! git -C "$COMPOSE_ROOT" cat-file -e "${input_tap_commit}^{commit}" 2>/dev/null ||
     ! git -C "$COMPOSE_ROOT" merge-base --is-ancestor "$input_tap_commit" HEAD; then
    echo "homebrew-publish-sidecars.sh: planned tap commit is not an ancestor of refreshed tap main" >&2
    exit 1
  fi

  planned_formula="$COMPOSE_PARENT/planned-formula.rb"
  composed_formula="$COMPOSE_PARENT/composed-formula.rb"
  git -C "$COMPOSE_ROOT" show "$input_tap_commit:$formula_path" >"$planned_formula"
  [ "$(sha256_file "$planned_formula")" = "$formula_sha" ] || {
    echo "homebrew-publish-sidecars.sh: planned Formula bytes differ from archived bottle provenance" >&2
    exit 1
  }
  planned_digest="$(ruby "$KANDELO_ROOT/scripts/homebrew-formula-source-digest.rb" "$planned_formula")"
  refreshed_digest="$(ruby "$KANDELO_ROOT/scripts/homebrew-formula-source-digest.rb" "$COMPOSE_ROOT/$formula_path")"
  [ "$planned_digest" = "$refreshed_digest" ] || {
    echo "homebrew-publish-sidecars.sh: Formula source changed after the bottle build" >&2
    exit 1
  }

  previous_metadata="$COMPOSE_ROOT/Kandelo/metadata.json"
  sibling_policy="$(sibling_bottle_policy \
    "$previous_metadata" "$FORMULA" "$version" "$formula_revision" "$rebuild" "$kandelo_abi")"

  ruby "$KANDELO_ROOT/scripts/homebrew-compose-formula-bottle.rb" \
    "$COMPOSE_ROOT/$formula_path" \
    "$planned_formula" \
    "$bottle_root" \
    "$rebuild" \
    "$tag" \
    "$relocation_cellar" \
    "$bottle_sha" \
    "$sibling_policy" \
    "$composed_formula"
  mv "$composed_formula" "$COMPOSE_ROOT/$formula_path"

  host="$(rustc -vV | awk '/^host/ {print $2}')"
  sidecar_args=(
    cargo run --release -p xtask --target "$host" --quiet --
    homebrew-sidecars
    --tap-root "$COMPOSE_ROOT"
    --input "$input"
  )
  if [ -f "$previous_metadata" ]; then
    sidecar_args+=(--previous-metadata "$previous_metadata")
  fi
  (cd "$KANDELO_ROOT" && "${sidecar_args[@]}")
  assert_static_tap_tree "$COMPOSE_ROOT" "composed tap"
  assert_sidecar_size_bounds "$COMPOSE_ROOT"
  run_validator "$COMPOSE_ROOT"

  assert_static_tap_tree "$TAP_ROOT" "refreshed publication tap"
  formula_stage="$(mktemp "$TAP_ROOT/Formula/.${FORMULA}.publish.XXXXXX")"
  publish_stage="$(mktemp -d "$TAP_ROOT/.homebrew-publish.XXXXXX")"
  kandelo_stage="$publish_stage/Kandelo"
  kandelo_previous="$TAP_ROOT/.Kandelo.previous.$$"
  cp "$COMPOSE_ROOT/$formula_path" "$formula_stage"
  cp -a "$COMPOSE_ROOT/Kandelo" "$kandelo_stage"
  assert_static_tap_tree "$publish_stage" "staged publication tap"

  if [ -e "$TAP_ROOT/Kandelo" ]; then
    mv "$TAP_ROOT/Kandelo" "$kandelo_previous"
  fi
  if ! mv "$kandelo_stage" "$TAP_ROOT/Kandelo"; then
    [ ! -e "$kandelo_previous" ] || mv "$kandelo_previous" "$TAP_ROOT/Kandelo"
    exit 1
  fi
  mv "$formula_stage" "$TAP_ROOT/$formula_path"
  rm -rf "$kandelo_previous"
  rmdir "$publish_stage"
  assert_static_tap_tree "$TAP_ROOT" "published tap"
}

copy_payload() {
  if [ -z "$SIDECAR_ROOT" ]; then
    echo "homebrew-publish-sidecars.sh: --sidecar-root is required for success" >&2
    exit 2
  fi
  if [ ! -f "$SIDECAR_ROOT/Kandelo/metadata.json" ]; then
    echo "homebrew-publish-sidecars.sh: sidecar payload lacks Kandelo/metadata.json" >&2
    exit 2
  fi
  assert_static_tap_tree "$SIDECAR_ROOT" "sidecar payload"
  assert_sidecar_size_bounds "$SIDECAR_ROOT"
  mkdir -p "$TAP_ROOT/Kandelo"
  rsync -a "$SIDECAR_ROOT/Kandelo/" "$TAP_ROOT/Kandelo/"
  if [ -d "$SIDECAR_ROOT/Formula" ]; then
    mkdir -p "$TAP_ROOT/Formula"
    rsync -a "$SIDECAR_ROOT/Formula/" "$TAP_ROOT/Formula/"
  fi
  assert_static_tap_tree "$TAP_ROOT" "merged publication tap"
  assert_sidecar_size_bounds "$TAP_ROOT"
}

guard_non_success_payload_preserves_last_green() {
  local current="$TAP_ROOT/Kandelo/metadata.json"
  local incoming="$SIDECAR_ROOT/Kandelo/metadata.json"
  [ -f "$current" ] || return 0
  [ -f "$incoming" ] || return 0

  jq -e --arg formula "$FORMULA" --arg arch "$ARCH" '
    def bottle($doc):
      ($doc.packages // [])
      | map(select(.name == $formula))
      | .[0].bottles // []
      | map(select(.arch == $arch))
      | .[0] // {};
    . as $pair
    | (bottle($pair[0])) as $current
    | (bottle($pair[1])) as $incoming
    | if (($incoming.status // "") == "" or ($incoming.status // "") == "success") then
        false
      elif (($current.status // "") == "success") then
        (($incoming.fallback_url // "") == ($current.url // "")) and
        (($incoming.fallback_sha256 // "") == ($current.sha256 // "")) and
        (($incoming.fallback_bytes // 0) == ($current.bytes // -1)) and
        (($incoming.fallback_cache_key_sha // "") == ($current.cache_key_sha // "")) and
        (($incoming.fallback_link_manifest // "") == ($current.link_manifest // ""))
      else
        true
      end
  ' <(jq -s '.' "$current" "$incoming") >/dev/null || {
    echo "homebrew-publish-sidecars.sh: non-success payload is missing a non-success status or would drop last-green metadata for $FORMULA/$ARCH" >&2
    exit 1
  }
}

write_failure_report() {
  local now run_url run_id run_attempt report_dir report_path safe_error
  now="$(date -u +%FT%TZ)"
  run_id="${GITHUB_RUN_ID:-local}"
  run_attempt="${GITHUB_RUN_ATTEMPT:-1}"
  [[ "$run_id" =~ ^([0-9]+|local)$ ]] || {
    echo "homebrew-publish-sidecars.sh: invalid GITHUB_RUN_ID for report path" >&2; exit 2;
  }
  [[ "$run_attempt" =~ ^[1-9][0-9]*$ ]] || {
    echo "homebrew-publish-sidecars.sh: invalid GITHUB_RUN_ATTEMPT for report path" >&2; exit 2;
  }
  run_url="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-unknown/repository}/actions/runs/${run_id}"
  report_dir="$TAP_ROOT/Kandelo/reports/failures"
  report_path="$report_dir/${now//[:]/-}-run-${run_id}-attempt-${run_attempt}-${FORMULA}-${ARCH}.json"
  mkdir -p "$report_dir"
  safe_error="${ERROR_TEXT:-homebrew bottle publish failed before sidecar payload was produced}"
  jq -n \
    --arg schema "1" \
    --arg formula "$FORMULA" \
    --arg arch "$ARCH" \
    --arg release_tag "$RELEASE_TAG" \
    --arg status "failed" \
    --arg attempted_at "$now" \
    --arg attempted_by "$run_url" \
    --arg kandelo_commit "$KANDELO_COMMIT" \
    --arg tap_commit "$TAP_COMMIT" \
    --arg error "$safe_error" \
    '{
      schema: ($schema | tonumber),
      formula: $formula,
      arch: $arch,
      release_tag: $release_tag,
      status: $status,
      attempted_at: $attempted_at,
      attempted_by: $attempted_by,
      kandelo_commit: $kandelo_commit,
      tap_commit: $tap_commit,
      error: $error
    }' >"$report_path"
  echo "homebrew-publish-sidecars.sh: wrote failure report $report_path"
}

write_rollback_report() {
  local now run_url run_id run_attempt report_dir report_path
  now="$(date -u +%FT%TZ)"
  run_id="${GITHUB_RUN_ID:-local}"
  run_attempt="${GITHUB_RUN_ATTEMPT:-1}"
  [[ "$run_id" =~ ^([0-9]+|local)$ ]] || {
    echo "homebrew-publish-sidecars.sh: invalid GITHUB_RUN_ID for report path" >&2; exit 2;
  }
  [[ "$run_attempt" =~ ^[1-9][0-9]*$ ]] || {
    echo "homebrew-publish-sidecars.sh: invalid GITHUB_RUN_ATTEMPT for report path" >&2; exit 2;
  }
  run_url="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-unknown/repository}/actions/runs/${run_id}"
  report_dir="$TAP_ROOT/Kandelo/reports/rollbacks"
  report_path="$report_dir/${now//[:]/-}-run-${run_id}-attempt-${run_attempt}-${FORMULA}-${ARCH}.json"
  mkdir -p "$report_dir"
  jq -n \
    --arg schema "1" \
    --arg formula "$FORMULA" \
    --arg arch "$ARCH" \
    --arg release_tag "$RELEASE_TAG" \
    --arg status "rollback" \
    --arg attempted_at "$now" \
    --arg attempted_by "$run_url" \
    --arg kandelo_commit "$KANDELO_COMMIT" \
    --arg tap_commit "$TAP_COMMIT" \
    --arg reason "$REASON_TEXT" \
    --arg rollback_ref "$ROLLBACK_REF" \
    --arg deleted_package_url "$DELETED_PACKAGE_URL" \
    --arg deletion_reason "$DELETION_REASON" \
    '{
      schema: ($schema | tonumber),
      formula: $formula,
      arch: $arch,
      release_tag: $release_tag,
      status: $status,
      attempted_at: $attempted_at,
      attempted_by: $attempted_by,
      kandelo_commit: $kandelo_commit,
      tap_commit: $tap_commit,
      reason: $reason,
      rollback_ref: (if $rollback_ref == "" then null else $rollback_ref end),
      package_deletion: {
        performed: ($deleted_package_url != ""),
        policy: "exceptional; only for legal, security, or package-retention emergencies",
        url: (if $deleted_package_url == "" then null else $deleted_package_url end),
        reason: (if $deletion_reason == "" then null else $deletion_reason end)
      }
    }' >"$report_path"
  echo "homebrew-publish-sidecars.sh: wrote rollback report $report_path"
}

cleanup() {
  if [ -n "$COMPOSE_ROOT" ] && [ -d "$COMPOSE_ROOT" ]; then
    git -C "$TAP_ROOT" worktree remove --force "$COMPOSE_ROOT" >/dev/null 2>&1 || true
  fi
  if [ -n "$COMPOSE_PARENT" ]; then
    rm -rf "$COMPOSE_PARENT"
  fi
  release_lock
}

acquire_lock
trap cleanup EXIT
refresh_tap
assert_static_tap_tree "$TAP_ROOT" "refreshed publication tap"

case "$STATUS" in
  success)
    if [ -n "$PUBLICATION_HANDOFF" ]; then
      compose_publication_handoff
    else
      copy_payload
      run_validator
    fi
    if [ "$REPAIR_ONLY" = "1" ]; then
      commit_and_push "homebrew: repair ${FORMULA} ${ARCH} bottle sidecars"
    else
      commit_and_push "homebrew: publish ${FORMULA} ${ARCH} bottle sidecars"
    fi
    ;;
  failed)
    if [ -n "$SIDECAR_ROOT" ] && [ -f "$SIDECAR_ROOT/Kandelo/metadata.json" ]; then
      guard_non_success_payload_preserves_last_green
      copy_payload
      run_validator
      commit_and_push "homebrew: record ${FORMULA} ${ARCH} bottle failure"
    else
      write_failure_report
      commit_and_push "homebrew: record ${FORMULA} ${ARCH} bottle failure"
    fi
    ;;
  rollback)
    if [ -n "$SIDECAR_ROOT" ] && [ -f "$SIDECAR_ROOT/Kandelo/metadata.json" ]; then
      guard_non_success_payload_preserves_last_green
      copy_payload
      run_validator
      commit_and_push "homebrew: rollback ${FORMULA} ${ARCH} bottle metadata"
    else
      write_rollback_report
      commit_and_push "homebrew: record ${FORMULA} ${ARCH} bottle rollback"
    fi
    ;;
esac
