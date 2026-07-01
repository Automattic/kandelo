#!/usr/bin/env bash
set -euo pipefail

# Run a named SQLite official-test tier and emit durable outcome lists.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$REPO_ROOT/packages/registry/sqlite/test/official-tiers.toml"
EXPORTER="$REPO_ROOT/scripts/sqlite-official-outcomes.py"

TIER=""
HOST="node"
RESULTS_ROOT=""
JOBS="${SQLITE_OFFICIAL_JOBS:-1}"
TIMEOUT_MS=""
KEEP_WORKDIR=0
WORKDIR=""
EXPLAIN=0
SHARD=""

usage() {
  cat <<EOF
Usage: $0 --tier NAME [OPTIONS]

Options:
  --tier NAME              Tier name from packages/registry/sqlite/test/official-tiers.toml
  --host node|browser      Host to run on (default: node)
  --results-root DIR       Artifact directory for this tier run
  --jobs N                 testrunner.tcl --jobs value (default: 1)
  --timeout-ms N           Override tier timeout
  --workdir DIR            Preserve and use a testrunner working directory
  --keep-workdir           Preserve the generated testrunner working directory
  --manifest FILE          Override tier manifest path
  --shard N/TOTAL          Reserved for sharded tiers
  --explain                Ask testrunner.tcl to print the planned work
  --help                   Show this help

Example:
  bash scripts/dev-shell.sh bash scripts/run-sqlite-official-tier.sh \\
    --tier sqlite-official-smoke-v1 \\
    --host node \\
    --results-root test-runs/kd-1mr.2.4/sqlite-official-smoke-v1-node
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --tier)
      TIER="${2:-}"
      shift 2
      ;;
    --host)
      HOST="${2:-}"
      case "$HOST" in
        node|browser) ;;
        *) echo "ERROR: --host must be node or browser" >&2; exit 1 ;;
      esac
      shift 2
      ;;
    --results-root)
      RESULTS_ROOT="${2:-}"
      shift 2
      ;;
    --jobs)
      JOBS="${2:-}"
      shift 2
      ;;
    --timeout-ms)
      TIMEOUT_MS="${2:-}"
      shift 2
      ;;
    --workdir)
      WORKDIR="${2:-}"
      KEEP_WORKDIR=1
      shift 2
      ;;
    --keep-workdir)
      KEEP_WORKDIR=1
      shift
      ;;
    --manifest)
      MANIFEST="${2:-}"
      shift 2
      ;;
    --shard)
      SHARD="${2:-}"
      shift 2
      ;;
    --explain)
      EXPLAIN=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unexpected argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [ -z "$TIER" ]; then
  echo "ERROR: --tier is required" >&2
  usage >&2
  exit 1
fi

if [ -z "$RESULTS_ROOT" ]; then
  RESULTS_ROOT="$REPO_ROOT/test-runs/sqlite-official-tier/$TIER-$HOST-$(date +%Y%m%d-%H%M%S)"
fi
mkdir -p "$RESULTS_ROOT"

EXPAND_ARGS=(
  expand
  --manifest "$MANIFEST"
  --tier "$TIER"
  --host "$HOST"
  --results-root "$RESULTS_ROOT"
)
if [ -n "$TIMEOUT_MS" ]; then
  EXPAND_ARGS+=(--timeout-ms "$TIMEOUT_MS")
fi
if [ -n "$SHARD" ]; then
  EXPAND_ARGS+=(--shard "$SHARD")
fi

set +e
python3 "$EXPORTER" "${EXPAND_ARGS[@]}"
expand_status=$?
set -e
if [ "$expand_status" -ne 0 ]; then
  if [ -f "$RESULTS_ROOT/summary.md" ]; then
    echo "===== SQLite official tier summary ====="
    cat "$RESULTS_ROOT/summary.md"
  fi
  exit "$expand_status"
fi

if [ ! -f "$RESULTS_ROOT/tier-env.sh" ]; then
  echo "ERROR: tier expansion did not write $RESULTS_ROOT/tier-env.sh" >&2
  exit 1
fi

# shellcheck disable=SC1091
. "$RESULTS_ROOT/tier-env.sh"

RUNNER_PATTERNS=()
while IFS= read -r pattern; do
  if [ -n "$pattern" ]; then
    RUNNER_PATTERNS+=("$pattern")
  fi
done < "$SQLITE_OFFICIAL_RUNNER_PATTERNS"

RUNNER_ARGS=(
  --host "$HOST"
  --permutation "$SQLITE_OFFICIAL_PERMUTATION"
  --jobs "$JOBS"
  --timeout-ms "$SQLITE_OFFICIAL_TIMEOUT_MS"
  --results-dir "$RESULTS_ROOT"
)
if [ "$KEEP_WORKDIR" = "1" ]; then
  RUNNER_ARGS+=(--keep-workdir)
fi
if [ -n "$WORKDIR" ]; then
  RUNNER_ARGS+=(--workdir "$WORKDIR")
fi
if [ "$EXPLAIN" = "1" ]; then
  RUNNER_ARGS+=(--explain)
fi
RUNNER_ARGS+=("${RUNNER_PATTERNS[@]}")

RUNNER_LOG="$RESULTS_ROOT/runner.log"
echo "===== SQLite official tier on Kandelo $HOST host =====" | tee "$RUNNER_LOG"
echo "Tier: $TIER" | tee -a "$RUNNER_LOG"
echo "Permutation: $SQLITE_OFFICIAL_PERMUTATION | Jobs: $JOBS | Timeout: $SQLITE_OFFICIAL_TIMEOUT_MS ms" | tee -a "$RUNNER_LOG"
echo "Results root: $RESULTS_ROOT" | tee -a "$RUNNER_LOG"

set +e
bash "$REPO_ROOT/scripts/run-sqlite-official-tests.sh" "${RUNNER_ARGS[@]}" 2>&1 | tee -a "$RUNNER_LOG"
runner_status=${PIPESTATUS[0]}
set -e

set +e
python3 "$EXPORTER" export \
  --results-root "$RESULTS_ROOT" \
  --planned "$SQLITE_OFFICIAL_PLANNED_TESTS" \
  --metadata "$SQLITE_OFFICIAL_TIER_METADATA" \
  --runner-status "$runner_status" \
  --runner-log "$RUNNER_LOG"
export_status=$?
set -e

echo "===== SQLite official tier summary ====="
cat "$RESULTS_ROOT/summary.md"
exit "$export_status"
