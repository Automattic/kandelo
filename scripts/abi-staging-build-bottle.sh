#!/usr/bin/env bash
# Run one exact ABI-staging bottle build without credentials or publication.
set -euo pipefail

REQUEST=""
TAP_PLAN=""
FORMULA_PLAN=""
DEPENDENCY_ROOT=""
HANDOFF=""

usage() {
  cat >&2 <<'EOF'
usage: scripts/abi-staging-build-bottle.sh --request request.json --tap-plan tap-plan.json --formula-plan formula-plan.json --dependency-root dependency-inputs --handoff handoff

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
NORMAL_BUILDER="$KANDELO_ROOT/scripts/homebrew-bottle-build.sh"
if [ -n "${KANDELO_ABI_STAGING_NORMAL_BUILDER:-}" ]; then
  if [ "$TESTING" != "1" ] || [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    echo "abi-staging-build-bottle.sh: normal-builder replacement is local-test-only" >&2
    exit 2
  fi
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
mkdir -p "$RAW_OUTPUT/diagnostics"

PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$TAP_ROOT" \
  python3 -m scripts.abi_staging.handoff prepare-build \
    --kandelo-root "$KANDELO_ROOT" \
    --tap-root "$TAP_ROOT" \
    --request "$REQUEST" \
    --tap-plan "$TAP_PLAN" \
    --formula-plan "$FORMULA_PLAN" \
    --dependency-root "$DEPENDENCY_ROOT" \
    --out "$CONTEXT"
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$TAP_ROOT" \
  python3 -m scripts.abi_staging.handoff materialize-dependencies \
    --context "$CONTEXT" \
    --out "$SELECTED_DEPENDENCIES"

FORMULA="$(jq -er '.formula' "$CONTEXT")"
ARCHITECTURE="$(jq -er '.architecture' "$CONTEXT")"
TAP_REPOSITORY="$(jq -er '.tap_source.repository' "$CONTEXT")"
BOTTLE_ROOT_URL="$(jq -er '.bottle_root_url' "$CONTEXT")"

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
unset KANDELO_ABI_STAGING_NORMAL_BUILDER KANDELO_ABI_STAGING_TESTING
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_TERMINAL_PROMPT=0
export GCM_INTERACTIVE=never
export WASM_POSIX_SDK_ROOT="$KANDELO_ROOT/sdk"
export KANDELO_ABI_STAGING_DEPENDENCY_ROOT="$SELECTED_DEPENDENCIES"
umask 077

set +e
"$TIMEOUT_BIN" 21600s "$NORMAL_BUILDER" \
  --tap-root "$TAP_ROOT" \
  --tap-repository "$TAP_REPOSITORY" \
  --formula "$FORMULA" \
  --arch "$ARCHITECTURE" \
  --out "$RAW_OUTPUT" \
  --bottle-root-url "$BOTTLE_ROOT_URL" \
  >"$RAW_OUTPUT/diagnostics/summary.txt" 2>&1
BUILD_STATUS="$?"
set -e
if [ ! -s "$RAW_OUTPUT/diagnostics/summary.txt" ]; then
  printf 'normal builder exited with status %s\n' "$BUILD_STATUS" \
    >"$RAW_OUTPUT/diagnostics/summary.txt"
fi

PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$TAP_ROOT" \
  python3 -m scripts.abi_staging.handoff assemble \
    --context "$CONTEXT" \
    --raw-output "$RAW_OUTPUT" \
    --handoff "$HANDOFF" \
    --exit-code "$BUILD_STATUS"

if [ "$BUILD_STATUS" -ne 0 ]; then
  exit "$BUILD_STATUS"
fi
