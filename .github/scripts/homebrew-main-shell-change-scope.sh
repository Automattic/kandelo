#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: homebrew-main-shell-change-scope.sh \
  --event <pull_request|push|workflow_dispatch> \
  [--base <commit>] [--head <commit>] [--output <path>]
EOF
}

EVENT_NAME=
BASE_REVISION=
HEAD_REVISION=
OUTPUT_PATH="${GITHUB_OUTPUT:-}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --event)
      EVENT_NAME="${2:-}"
      shift 2
      ;;
    --base)
      BASE_REVISION="${2:-}"
      shift 2
      ;;
    --head)
      HEAD_REVISION="${2:-}"
      shift 2
      ;;
    --output)
      OUTPUT_PATH="${2:-}"
      shift 2
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

[ -n "$EVENT_NAME" ] || {
  usage
  exit 2
}
[ -n "$OUTPUT_PATH" ] || {
  echo "homebrew-main-shell-change-scope: --output is required" >&2
  exit 2
}

emit_result() {
  local required="$1"
  local reason="$2"
  {
    printf 'required=%s\n' "$required"
    printf 'reason=%s\n' "$reason"
  } >>"$OUTPUT_PATH"
  printf 'Homebrew main-shell exact product gate: %s (%s)\n' \
    "$required" "$reason"
}

is_audited_publisher_only_path() {
  # WHY: this reviewed lock is consumed only while the native publisher
  # admits signed Homebrew API results. Exact shell composition and guest
  # boot consume already-published Kandelo bottles, so neither reads it.
  if [ "$1" = homebrew/homebrew-native-compatibility-lock.json ]; then
    return 0
  fi

  case "$1" in
    .github/scripts/require-repository-main-contains.sh | \
      .github/scripts/test-require-repository-main-contains.sh | \
      .github/workflows/homebrew-native-publisher-compatibility.yml | \
      .github/workflows/reusable-homebrew-bottle-maintenance.yml | \
      .github/workflows/reusable-homebrew-bottle-publish.yml | \
      .github/workflows/reusable-homebrew-repository-namespace-canary.yml | \
      docs/binary-releases.md | \
      docs/homebrew-publishing.md | \
      docs/plans/2026-07-29-homebrew-guest-prefix-cutover.md | \
      scripts/check-homebrew-publish-workflow-trust.rb | \
      scripts/homebrew-bottle-build.sh | \
      scripts/homebrew-bottle-runtime-evidence.py | \
      scripts/homebrew-compose-formula-bottle.rb | \
      scripts/homebrew-create-build-handoff.sh | \
      scripts/homebrew-dependency-provenance.py | \
      scripts/homebrew-dependency-taps.py | \
      scripts/homebrew-formula-runtime-closure.rb | \
      scripts/homebrew-generate-sidecars-from-env.sh | \
      scripts/homebrew-guest-layout.sh | \
      scripts/homebrew-ghcr-upload.sh | \
      scripts/homebrew-inspect-bottle.py | \
      scripts/homebrew-merge-bottle-json.sh | \
      scripts/homebrew-native-api-preflight.sh | \
      scripts/homebrew-native-command-diagnostic.rb | \
      scripts/homebrew-oci-layout.py | \
      scripts/homebrew-patched-launcher.sh | \
      scripts/homebrew-prefix-campaign-executor.py | \
      scripts/homebrew-prefix-campaign-publisher.py | \
      scripts/homebrew-prefix-campaign.py | \
      scripts/homebrew-publish-sidecars.sh | \
      scripts/homebrew-tap-recipe-runner.py | \
      scripts/homebrew-validate-build-handoff.sh | \
      scripts/homebrew-validate-formula-source-closure.sh | \
      scripts/homebrew-validate-publish-handoff.sh | \
      scripts/homebrew-validate-upload-receipt.sh | \
      scripts/homebrew-verify-poured-bottle.sh | \
      scripts/publish-immutable-github-release.sh | \
      scripts/test-homebrew-bottle-runtime-evidence.sh | \
      scripts/test-homebrew-formula-runtime-closure.sh | \
      scripts/test-homebrew-inspect-bottle.sh | \
      scripts/test-homebrew-native-api-contract.sh | \
      scripts/test-homebrew-native-ca-lifecycle.sh | \
      scripts/test-homebrew-oci-layout.sh | \
      scripts/test-homebrew-patched-launcher.sh | \
      scripts/test-homebrew-prefix-campaign-layout.sh | \
      scripts/test-homebrew-prefix-campaign-executor.py | \
      scripts/test-homebrew-prefix-campaign-publisher.py | \
      scripts/test-homebrew-prefix-campaign.py | \
      scripts/test-homebrew-publish-workflow.sh | \
      scripts/test-homebrew-sibling-bottle-policy.sh | \
      scripts/test-homebrew-tap-identity.sh | \
      scripts/test-homebrew-tap-native-sidecars.sh | \
      scripts/test-homebrew-tap-recipe-runner.py | \
      scripts/test-homebrew-vfs-release.sh | \
      scripts/test-publish-immutable-github-release.sh | \
      tools/xtask/src/homebrew_guest_layout.rs | \
      tools/xtask/src/homebrew_sidecars.rs | \
      tools/xtask/src/homebrew_validate.rs)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

if [ "$EVENT_NAME" != pull_request ]; then
  case "$EVENT_NAME" in
    push | workflow_dispatch)
      emit_result true "$EVENT_NAME always validates the exact product"
      exit 0
      ;;
    *)
      emit_result true "unknown event $EVENT_NAME fails closed"
      exit 0
      ;;
  esac
fi

if [ -z "$BASE_REVISION" ] || [ -z "$HEAD_REVISION" ]; then
  emit_result true "pull-request revision input is missing"
  exit 0
fi

if [[ ! "$BASE_REVISION" =~ ^[0-9a-f]{40}$ ]] ||
   [[ ! "$HEAD_REVISION" =~ ^[0-9a-f]{40}$ ]]; then
  emit_result true "pull-request revision is not an exact commit identity"
  exit 0
fi

if ! git cat-file -e "${BASE_REVISION}^{commit}" 2>/dev/null ||
   ! git cat-file -e "${HEAD_REVISION}^{commit}" 2>/dev/null; then
  emit_result true "pull-request revision cannot be resolved"
  exit 0
fi

DIFF_FILE="$(mktemp)"
trap 'rm -f "$DIFF_FILE"' EXIT
if ! git diff --name-status -z --find-renames \
  "${BASE_REVISION}...${HEAD_REVISION}" >"$DIFF_FILE"; then
  emit_result true "pull-request diff cannot be computed"
  exit 0
fi

if [ ! -s "$DIFF_FILE" ]; then
  emit_result true "empty pull-request diff fails closed"
  exit 0
fi

changed_paths=()
while IFS= read -r -d '' status; do
  case "$status" in
    R[0-9]* | C[0-9]*)
      if ! IFS= read -r -d '' old_path ||
         ! IFS= read -r -d '' new_path; then
        emit_result true "rename or copy record is incomplete"
        exit 0
      fi
      changed_paths+=("$old_path" "$new_path")
      ;;
    A | D | M | T | U | X | B)
      if ! IFS= read -r -d '' path; then
        emit_result true "change record is incomplete"
        exit 0
      fi
      changed_paths+=("$path")
      ;;
    *)
      emit_result true "unknown Git change status fails closed"
      exit 0
      ;;
  esac
done <"$DIFF_FILE"

if [ "${#changed_paths[@]}" -eq 0 ]; then
  emit_result true "empty parsed pull-request diff fails closed"
  exit 0
fi

for path in "${changed_paths[@]}"; do
  if [[ "$path" == *$'\n'* ]] || [[ "$path" == *$'\r'* ]]; then
    emit_result true "changed path cannot be represented in workflow output"
    exit 0
  fi
  if ! is_audited_publisher_only_path "$path"; then
    emit_result true "non-publisher-only path requires proof: $path"
    exit 0
  fi
done

# WHY: bottle publication and bottle consumption are separate contracts.
# These files can change how a future bottle is produced or admitted, but the
# exact shell workflow never invokes them while composing and booting already
# published bytes. Any unknown or mixed path above still runs the product gate.
emit_result false \
  "diff is limited to audited publisher-only implementation and tests"
