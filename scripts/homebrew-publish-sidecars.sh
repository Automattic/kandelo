#!/usr/bin/env bash
# Commit generated Kandelo sidecars to a tap, or record a failed attempt
# without overwriting last-green metadata.
set -euo pipefail

KANDELO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAP_ROOT=""
SIDECAR_ROOT=""
FORMULA=""
ARCH=""
RELEASE_TAG=""
STATUS=""
ERROR_TEXT=""
REASON_TEXT=""
ROLLBACK_REF=""
DELETED_PACKAGE_URL=""
DELETION_REASON=""
REPAIR_ONLY=0
DRY_RUN=0
NO_LOCK=0

usage() {
  cat >&2 <<'EOF'
usage: scripts/homebrew-publish-sidecars.sh --tap-root <tap-root> --formula <name> --arch <wasm32|wasm64> --release-tag <tag> --status <success|failed|rollback> [--sidecar-root <dir>] [--error <text>] [--reason <text>] [--rollback-ref <ref>] [--deleted-package-url <url> --deletion-reason <text>] [--repair-only] [--dry-run] [--no-lock]

Success publishes a generated sidecar payload from --sidecar-root into the tap
and validates it with xtask homebrew-validate. Failed and rollback attempts
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
    --formula) FORMULA="${2:-}"; shift 2 ;;
    --arch) ARCH="${2:-}"; shift 2 ;;
    --release-tag) RELEASE_TAG="${2:-}"; shift 2 ;;
    --status) STATUS="${2:-}"; shift 2 ;;
    --error) ERROR_TEXT="${2:-}"; shift 2 ;;
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

STATE_LOCK_SCRIPT="$KANDELO_ROOT/.github/scripts/state-lock.sh"
LOCK_SUBJECT="homebrew-${RELEASE_TAG}"
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
  local branch
  if [ "$DRY_RUN" = "1" ]; then
    return 0
  fi
  branch="$(git -C "$TAP_ROOT" symbolic-ref --quiet --short HEAD || true)"
  if [ -z "$branch" ]; then
    echo "homebrew-publish-sidecars.sh: tap checkout is detached; skipping pre-publish refresh" >&2
    return 0
  fi
  git -C "$TAP_ROOT" fetch origin "$branch"
  git -C "$TAP_ROOT" merge --ff-only "origin/$branch"
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
    git -C "$TAP_ROOT" push origin HEAD
  fi
}

run_validator() {
  local host
  host="$(rustc -vV | awk '/^host/ {print $2}')"
  (
    cd "$KANDELO_ROOT"
    cargo run --release -p xtask --target "$host" --quiet -- \
      homebrew-validate --tap-root "$TAP_ROOT"
  )
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
  mkdir -p "$TAP_ROOT/Kandelo"
  rsync -a "$SIDECAR_ROOT/Kandelo/" "$TAP_ROOT/Kandelo/"
  if [ -d "$SIDECAR_ROOT/Formula" ]; then
    mkdir -p "$TAP_ROOT/Formula"
    rsync -a "$SIDECAR_ROOT/Formula/" "$TAP_ROOT/Formula/"
  fi
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
  local now run_url report_dir report_path safe_error
  now="$(date -u +%FT%TZ)"
  run_url="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-unknown/repository}/actions/runs/${GITHUB_RUN_ID:-local}"
  report_dir="$TAP_ROOT/Kandelo/reports/failures"
  report_path="$report_dir/${now//[:]/-}-${FORMULA}-${ARCH}.json"
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
    --arg kandelo_commit "${GITHUB_SHA:-unknown}" \
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
      error: $error
    }' >"$report_path"
  echo "homebrew-publish-sidecars.sh: wrote failure report $report_path"
}

write_rollback_report() {
  local now run_url report_dir report_path
  now="$(date -u +%FT%TZ)"
  run_url="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-unknown/repository}/actions/runs/${GITHUB_RUN_ID:-local}"
  report_dir="$TAP_ROOT/Kandelo/reports/rollbacks"
  report_path="$report_dir/${now//[:]/-}-${FORMULA}-${ARCH}.json"
  mkdir -p "$report_dir"
  jq -n \
    --arg schema "1" \
    --arg formula "$FORMULA" \
    --arg arch "$ARCH" \
    --arg release_tag "$RELEASE_TAG" \
    --arg status "rollback" \
    --arg attempted_at "$now" \
    --arg attempted_by "$run_url" \
    --arg kandelo_commit "${GITHUB_SHA:-unknown}" \
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

acquire_lock
trap release_lock EXIT
refresh_tap

case "$STATUS" in
  success)
    copy_payload
    run_validator
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
