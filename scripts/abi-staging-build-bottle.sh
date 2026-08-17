#!/usr/bin/env bash
# Run one exact ABI-staging bottle build without credentials or publication.
set -euo pipefail

REQUEST=""
TAP_PLAN=""
FORMULA_PLAN=""
DEPENDENCY_ROOT=""
RUN=""
RETRY_ORDINAL=""
HANDOFF=""

usage() {
  cat >&2 <<'EOF'
usage: scripts/abi-staging-build-bottle.sh --request request.json --tap-plan tap-plan.json --formula-plan formula-plan.json --dependency-root dependency-inputs --run run.json --retry-ordinal number --handoff handoff

Run from the exact tap checkout. The dependency root is content addressed:
contracts/sha256-<contract>.json contains the exact bottle contract and
layers/sha256-<layer>.tar.gz contains only contract-declared dependency
layers. The command never publishes and strips credential-bearing variables
before invoking the normal Kandelo Homebrew bottle builder.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --request) REQUEST="${2:-}"; shift 2 ;;
    --tap-plan) TAP_PLAN="${2:-}"; shift 2 ;;
    --formula-plan) FORMULA_PLAN="${2:-}"; shift 2 ;;
    --dependency-root) DEPENDENCY_ROOT="${2:-}"; shift 2 ;;
    --run) RUN="${2:-}"; shift 2 ;;
    --retry-ordinal) RETRY_ORDINAL="${2:-}"; shift 2 ;;
    --handoff) HANDOFF="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "abi-staging-build-bottle.sh: unknown flag: $1" >&2
      usage
      exit 2
      ;;
  esac
done

for requirement in \
  "request:$REQUEST" \
  "tap-plan:$TAP_PLAN" \
  "formula-plan:$FORMULA_PLAN" \
  "dependency-root:$DEPENDENCY_ROOT" \
  "run:$RUN" \
  "retry-ordinal:$RETRY_ORDINAL" \
  "handoff:$HANDOFF"; do
  if [ -z "${requirement#*:}" ]; then
    echo "abi-staging-build-bottle.sh: --${requirement%%:*} is required" >&2
    exit 2
  fi
done

KANDELO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
TAP_ROOT="$(pwd -P)"
if [ ! -d "$TAP_ROOT/scripts/abi_staging" ] || [ -L "$TAP_ROOT/scripts/abi_staging" ]; then
  echo "abi-staging-build-bottle.sh: run from the exact tap checkout" >&2
  exit 2
fi
if [ ! -d "$KANDELO_ROOT/sdk" ] || [ -L "$KANDELO_ROOT/sdk" ]; then
  echo "abi-staging-build-bottle.sh: worktree-local SDK is unavailable" >&2
  exit 2
fi
if [ -e "$HANDOFF" ] || [ -L "$HANDOFF" ]; then
  if [ -L "$HANDOFF" ] || [ ! -d "$HANDOFF" ] || find "$HANDOFF" -mindepth 1 -print -quit | grep -q .; then
    echo "abi-staging-build-bottle.sh: handoff must be a new or empty real directory" >&2
    exit 2
  fi
fi

TESTING="${KANDELO_ABI_STAGING_TESTING:-0}"
PROTECTED_NORMAL_BUILDER="${KANDELO_ABI_STAGING_PROTECTED_NORMAL_BUILDER:-0}"
NORMAL_BUILDER="$KANDELO_ROOT/scripts/homebrew-bottle-build.sh"
if [ -n "${KANDELO_ABI_STAGING_NORMAL_BUILDER:-}" ]; then
  case "$TESTING:$PROTECTED_NORMAL_BUILDER:${GITHUB_ACTIONS:-}" in
    1:0:) ;;
    0:1:true) ;;
    *)
      echo "abi-staging-build-bottle.sh: normal-builder replacement lacks one exact execution authority" >&2
      exit 2
      ;;
  esac
  NORMAL_BUILDER="$KANDELO_ABI_STAGING_NORMAL_BUILDER"
fi
if [ ! -f "$NORMAL_BUILDER" ] || [ -L "$NORMAL_BUILDER" ] || [ ! -x "$NORMAL_BUILDER" ]; then
  echo "abi-staging-build-bottle.sh: normal Homebrew bottle builder is unavailable" >&2
  exit 2
fi
TIMEOUT_BIN="$(command -v timeout || true)"
if [ -z "$TIMEOUT_BIN" ] || [ ! -x "$TIMEOUT_BIN" ]; then
  echo "abi-staging-build-bottle.sh: repository dev shell does not provide timeout" >&2
  exit 2
fi

BUILD_ROOT="$(mktemp -d)"
cleanup() {
  rm -rf "$BUILD_ROOT"
}
trap cleanup EXIT
chmod 0700 "$BUILD_ROOT"
CONTEXT="$BUILD_ROOT/build-context.json"
RAW_OUTPUT="$BUILD_ROOT/raw-output"
SELECTED_DEPENDENCIES="$BUILD_ROOT/declared-dependencies"
PREPARED_TAP="$BUILD_ROOT/prepared-tap"
PREPARED_RESOLVED_TAPS="$BUILD_ROOT/prepared-resolved-taps.json"
SOURCE_CUSTODY="$BUILD_ROOT/source-custody"
mkdir -p "$RAW_OUTPUT/diagnostics"

PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$TAP_ROOT" \
  python3 -m scripts.abi_staging.handoff prepare-build \
    --kandelo-root "$KANDELO_ROOT" \
    --tap-root "$TAP_ROOT" \
    --request "$REQUEST" \
    --tap-plan "$TAP_PLAN" \
    --formula-plan "$FORMULA_PLAN" \
    --dependency-root "$DEPENDENCY_ROOT" \
    --run "$RUN" \
    --retry-ordinal "$RETRY_ORDINAL" \
    --out "$CONTEXT"
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$TAP_ROOT" \
  python3 -m scripts.abi_staging.handoff materialize-dependencies \
    --context "$CONTEXT" \
    --out "$SELECTED_DEPENDENCIES"
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$TAP_ROOT" \
  python3 -m scripts.abi_staging.handoff prepare-dependency-tap \
    --context "$CONTEXT" \
    --tap-root "$TAP_ROOT" \
    --out "$PREPARED_TAP"
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$TAP_ROOT" \
  python3 -m scripts.abi_staging.handoff create-custody \
    --context "$CONTEXT" \
    --kandelo-root "$KANDELO_ROOT" \
    --tap-root "$TAP_ROOT" \
    --out "$SOURCE_CUSTODY"

FORMULA="$(jq -er '.formula' "$CONTEXT")"
ARCHITECTURE="$(jq -er '.architecture' "$CONTEXT")"
TAP_REPOSITORY="$(jq -er '.tap_source.repository' "$CONTEXT")"
BOTTLE_ROOT_URL="$(jq -er '.bottle_root_url' "$CONTEXT")"
TARGET_ABI="$(jq -er '.target_abi' "$CONTEXT")"
TAP_SOURCE_COMMIT="$(jq -er '.tap_source.commit' "$CONTEXT")"
PREPARED_TAP_COMMIT="$(git -C "$PREPARED_TAP" rev-parse HEAD)"
TAP_NAME="${TAP_REPOSITORY%%/*}/${TAP_REPOSITORY#*/homebrew-}"

resolved_tap_args=()
if [ -n "${KANDELO_HOMEBREW_RESOLVED_TAPS_FILE:-}" ]; then
  while IFS=$'\t' read -r dependency_tap dependency_root; do
    [ -n "$dependency_tap" ] && [ -n "$dependency_root" ] || {
      echo "abi-staging-build-bottle.sh: resolved dependency tap is incomplete" >&2
      exit 2
    }
    resolved_tap_args+=(--dependency-root "$dependency_tap=$dependency_root")
  done < <(jq -er '.dependencies[] | [.tap_name, .root] | @tsv' \
    "$KANDELO_HOMEBREW_RESOLVED_TAPS_FILE")
fi
python3 "$KANDELO_ROOT/scripts/homebrew-dependency-taps.py" resolve \
  --tap-root "$PREPARED_TAP" \
  --tap-name "$TAP_NAME" \
  --tap-repository "$TAP_REPOSITORY" \
  --tap-commit "$TAP_SOURCE_COMMIT" \
  --checkout-commit "$PREPARED_TAP_COMMIT" \
  "${resolved_tap_args[@]}" \
  --out "$PREPARED_RESOLVED_TAPS"

# Preserve only non-secret build configuration. Candidate execution has no
# write authority, but stripping credentials prevents accidental disclosure in
# Formula subprocesses or diagnostics that the protected publisher later reads.
while IFS='=' read -r name _; do
  case "$name" in
    GITHUB_*|GH_*|GHCR_*|HOMEBREW_GITHUB_API_TOKEN|HOMEBREW_GITHUB_PACKAGES_TOKEN|\
    NPM_TOKEN|NODE_AUTH_TOKEN|SSH_AUTH_SOCK|SSH_AGENT_PID|AWS_*|AZURE_*|\
    GOOGLE_*|GCP_*|CLOUDSDK_AUTH_*|ACTIONS_ID_TOKEN_*|CI_JOB_JWT*)
      unset "$name"
      ;;
  esac
done < <(env)
unset KANDELO_ABI_STAGING_NORMAL_BUILDER KANDELO_ABI_STAGING_TESTING \
  KANDELO_ABI_STAGING_PROTECTED_NORMAL_BUILDER
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_TERMINAL_PROMPT=0
export GCM_INTERACTIVE=never
export WASM_POSIX_SDK_ROOT="$KANDELO_ROOT/sdk"
export KANDELO_HOMEBREW_LOCAL_DEPENDENCY_CACHE="$SELECTED_DEPENDENCIES"
export KANDELO_HOMEBREW_TAP_SOURCE_COMMIT="$TAP_SOURCE_COMMIT"
export KANDELO_HOMEBREW_PREPARED_TAP_COMMIT="$PREPARED_TAP_COMMIT"
export KANDELO_HOMEBREW_RESOLVED_TAPS_FILE="$PREPARED_RESOLVED_TAPS"
umask 077

set +e
"$TIMEOUT_BIN" 21600s "$NORMAL_BUILDER" \
  --tap-root "$PREPARED_TAP" \
  --tap-repository "$TAP_REPOSITORY" \
  --formula "$FORMULA" \
  --arch "$ARCHITECTURE" \
  --out "$RAW_OUTPUT" \
  --bottle-root-url "$BOTTLE_ROOT_URL" \
  --staging-candidate-abi "$TARGET_ABI" \
  >"$RAW_OUTPUT/diagnostics/summary.txt" 2>&1
BUILD_STATUS="$?"
set -e
if [ ! -s "$RAW_OUTPUT/diagnostics/summary.txt" ]; then
  printf 'normal builder exited with status %s\n' "$BUILD_STATUS" \
    >"$RAW_OUTPUT/diagnostics/summary.txt"
fi

if [ "$BUILD_STATUS" -eq 0 ]; then
  mapfile -t composition_bottles < <(
    find "$RAW_OUTPUT/bottles" -maxdepth 1 -type f -name '*.tar.gz' -print | sort
  )
  mapfile -t composition_metadata < <(
    find "$RAW_OUTPUT/bottles" -maxdepth 1 -type f -name '*.bottle.json' -print | sort
  )
  if [ "${#composition_bottles[@]}" -ne 1 ] || \
     [ "${#composition_metadata[@]}" -ne 1 ]; then
    printf '%s\n' \
      'ABI staging composition requires one exact bottle and metadata file' \
      >>"$RAW_OUTPUT/diagnostics/summary.txt"
    BUILD_STATUS=1
  else
    COMPOSITION_INPUT="$BUILD_ROOT/composition-input.json"
    COMPOSITION_DESCRIPTOR="$RAW_OUTPUT/bottles/${FORMULA}.vfs-composition.json"
    set +e
    {
      PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$TAP_ROOT" \
        python3 -m scripts.abi_staging.handoff prepare-composition \
          --context "$CONTEXT" \
          --bottle "${composition_bottles[0]}" \
          --metadata "${composition_metadata[0]}" \
          --guest-layout "$KANDELO_ROOT/homebrew/kandelo-guest-layout.json" \
          --out "$COMPOSITION_INPUT" &&
      node "$KANDELO_ROOT/node_modules/tsx/dist/cli.mjs" \
        "$KANDELO_ROOT/scripts/abi-staging-homebrew-composition-descriptor.ts" \
        --input "$COMPOSITION_INPUT" \
        --bottle "${composition_bottles[0]}" \
        --out "$COMPOSITION_DESCRIPTOR"
    } >>"$RAW_OUTPUT/diagnostics/summary.txt" 2>&1
    COMPOSITION_STATUS="$?"
    set -e
    if [ "$COMPOSITION_STATUS" -ne 0 ]; then
      BUILD_STATUS="$COMPOSITION_STATUS"
    fi
  fi
fi

PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$TAP_ROOT" \
  python3 -m scripts.abi_staging.handoff assemble \
    --context "$CONTEXT" \
    --raw-output "$RAW_OUTPUT" \
    --source-custody "$SOURCE_CUSTODY" \
    --handoff "$HANDOFF" \
    --exit-code "$BUILD_STATUS"

if [ "$BUILD_STATUS" -ne 0 ]; then
  exit "$BUILD_STATUS"
fi
