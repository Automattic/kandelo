#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PHP_SRC="${PHP_SOURCE_DIR:-}"

host="${PHP_TEST_HOST:-node}"
chunk_size="${PHP_TEST_CHUNK_SIZE:-500}"
jobs="${PHP_TEST_JOBS:-}"
timeout_ms="${PHP_TEST_TIMEOUT_MS:-600000}"
host_reset_interval="${PHP_TEST_HOST_RESET_INTERVAL:-25}"
run_uid="${PHP_TEST_RUN_UID:-}"
run_gid="${PHP_TEST_RUN_GID:-}"
start_offset=0
out_dir=""
force=0
summary_only=0
rebuild_vfs=0

die() {
  echo "run-php-upstream-node-chunks: $*" >&2
  exit 2
}

usage() {
  cat <<'USAGE'
Usage: scripts/run-php-upstream-node-chunks.sh [options]

Run the full php-src PHPT suite on a Kandelo host in restartable chunks.
Each chunk invokes scripts/run-php-upstream-tests.sh in a fresh Node.js process.
This prevents long monolithic Node-host runs from accumulating host/Wasm memory
and gives browser-host runs resumable checkpoints. Unsupported harness features
remain explicit in the summary but do not stop this inventory-oriented wrapper.

Options:
  --host <node|browser>        Kandelo host to run (default: PHP_TEST_HOST or node)
  --chunk-size <n>             Tests per chunk (default: PHP_TEST_CHUNK_SIZE or 500)
  --jobs <n>                   PHPT concurrency (default: PHP_TEST_JOBS, else Node 4 / browser 1)
  --timeout <ms>               Per PHPT section timeout (default: PHP_TEST_TIMEOUT_MS or 600000)
  --host-reset-interval <n>    Kernel reboot interval per worker (default: PHP_TEST_HOST_RESET_INTERVAL or 25)
  --run-uid <n>                Run guest PHP processes as uid n (default: PHP_TEST_RUN_UID)
  --run-gid <n>                Run guest PHP processes as gid n (default: PHP_TEST_RUN_GID)
  --start-offset <n>           Start at global sorted PHPT offset (default: 0)
  --out-dir <dir>              Output directory (default: /tmp/kandelo-php-<host>-chunks-<timestamp>)
  --force                      Re-run chunks even if their .done marker exists
  --summary-only               Aggregate an existing --out-dir without running chunks
  --rebuild-vfs                Rebuild the browser PHPT VFS image before running
  -h, --help                   Show this help

Environment:
  PHP_SOURCE_DIR               php-src checkout (default: package metadata/cache resolver)
  PHP_TEST_HOST                Host default for --host (node or browser)
  PHP_WASM                     PHP wasm binary (default resolved by downstream harness)
  PHP_OPCACHE_SO               opcache.so path when testing opcache (recommended)
  PHP_EXTENSION_DIR            Directory of PHP .so side modules to include in the browser VFS
  PHP_TEST_RUN_UID             Optional guest uid for PHP processes
  PHP_TEST_RUN_GID             Optional guest gid for PHP processes

Outputs:
  chunk-<offset>.jsonl         JSONL PHPT results for that chunk
  chunk-<offset>.stderr        Harness stderr for that chunk
  chunk-<offset>.exit          Harness exit status for that chunk
  chunk-<offset>.done          Marker written only after the chunk command succeeds
  summary.json                 Aggregated status counts and untested count
  summary.md                   Human-readable summary
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --host) [ "$#" -ge 2 ] || die "--host needs a value"; host="$2"; shift 2 ;;
    --chunk-size) [ "$#" -ge 2 ] || die "--chunk-size needs a value"; chunk_size="$2"; shift 2 ;;
    --jobs) [ "$#" -ge 2 ] || die "--jobs needs a value"; jobs="$2"; shift 2 ;;
    --timeout) [ "$#" -ge 2 ] || die "--timeout needs a value"; timeout_ms="$2"; shift 2 ;;
    --host-reset-interval) [ "$#" -ge 2 ] || die "--host-reset-interval needs a value"; host_reset_interval="$2"; shift 2 ;;
    --run-uid) [ "$#" -ge 2 ] || die "--run-uid needs a value"; run_uid="$2"; shift 2 ;;
    --run-gid) [ "$#" -ge 2 ] || die "--run-gid needs a value"; run_gid="$2"; shift 2 ;;
    --start-offset) [ "$#" -ge 2 ] || die "--start-offset needs a value"; start_offset="$2"; shift 2 ;;
    --out-dir) [ "$#" -ge 2 ] || die "--out-dir needs a value"; out_dir="$2"; shift 2 ;;
    --force) force=1; shift ;;
    --summary-only) summary_only=1; shift ;;
    --rebuild-vfs) rebuild_vfs=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

if [ -z "$jobs" ]; then
  case "$host" in
    browser) jobs=1 ;;
    *) jobs=4 ;;
  esac
fi

for numeric in chunk_size jobs timeout_ms host_reset_interval start_offset; do
  value="${!numeric}"
  case "$value" in
    ''|*[!0-9]*) die "$numeric must be a non-negative integer, got: $value" ;;
  esac
done
for optional_numeric in run_uid run_gid; do
  value="${!optional_numeric}"
  case "$value" in
    ''|*[!0-9]*) [ -z "$value" ] || die "$optional_numeric must be a non-negative integer, got: $value" ;;
  esac
done
[ "$chunk_size" -gt 0 ] || die "chunk_size must be > 0"
[ "$jobs" -gt 0 ] || die "jobs must be > 0"
case "$host" in
  node|browser) ;;
  *) die "--host must be node or browser, got: $host" ;;
esac
if [ -z "$PHP_SRC" ]; then
  PHP_SRC="$(
    cd "$REPO_ROOT"
    npx tsx scripts/run-php-upstream-tests.ts --print-source-dir | tail -n 1
  )"
fi
[ -d "$PHP_SRC" ] || die "PHP_SOURCE_DIR not found: $PHP_SRC"
export PHP_SOURCE_DIR="$PHP_SRC"

if [ -z "$out_dir" ]; then
  out_dir="/tmp/kandelo-php-$host-chunks-$(date -u +%Y%m%d%H%M%S)"
fi
mkdir -p "$out_dir"

metadata="$out_dir/metadata.env"
{
  echo "REPO_ROOT=$REPO_ROOT"
  echo "PHP_SOURCE_DIR=$PHP_SRC"
  echo "HOST=$host"
  echo "CHUNK_SIZE=$chunk_size"
  echo "JOBS=$jobs"
  echo "TIMEOUT_MS=$timeout_ms"
  echo "HOST_RESET_INTERVAL=$host_reset_interval"
  echo "RUN_UID=$run_uid"
  echo "RUN_GID=$run_gid"
  echo "START_OFFSET=$start_offset"
  echo "STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$metadata"

total=$(find "$PHP_SRC" -path '*/.git' -prune -o -path '*/.deps' -prune -o -path '*/.libs' -prune -o -name '*.phpt' -type f -print | wc -l | tr -d ' ')
echo "$total" > "$out_dir/total-tests.txt"

echo "PHP source: $PHP_SRC"
echo "Host: $host"
echo "Total discovered PHPTs: $total"
echo "Output directory: $out_dir"

if [ "$summary_only" -eq 0 ] && [ "$host" = browser ] && [ "$rebuild_vfs" -eq 1 ]; then
  echo "Rebuilding browser PHPT VFS image..."
  npx tsx "$REPO_ROOT/images/vfs/scripts/build-php-test-vfs-image.ts"
fi

aggregate() {
  python3 - "$out_dir" "$total" <<'PY'
import json
import sys
from collections import Counter
from pathlib import Path

out_dir = Path(sys.argv[1])
total = int(sys.argv[2])
counts = Counter({
    "pass": 0,
    "fail": 0,
    "bork": 0,
    "warn": 0,
    "skip": 0,
    "xfail": 0,
    "xpass": 0,
    "unsupported": 0,
    "time": 0,
})
results = {}
parse_errors = []
for path in sorted(out_dir.glob("chunk-*.jsonl")):
    with path.open("r", encoding="utf-8", errors="replace") as f:
        for lineno, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                item = json.loads(line)
            except json.JSONDecodeError as exc:
                parse_errors.append(f"{path.name}:{lineno}: {exc}")
                continue
            test = item.get("test")
            status = item.get("status")
            if not test or not status:
                parse_errors.append(f"{path.name}:{lineno}: missing test/status")
                continue
            previous = results.get(test)
            if previous:
                counts[previous.get("status", "")] -= 1
            results[test] = item
            counts[status] += 1

run_total = len(results)
summary = {
    "total_discovered": total,
    "run_total": run_total,
    "untested": max(total - run_total, 0),
    "counts": dict(counts),
    "parse_errors": parse_errors,
}
(out_dir / "summary.json").write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
nonpassing = [r for r in results.values() if r.get("status") not in {"pass", "xfail"}]
nonpassing.sort(key=lambda r: (r.get("status", ""), r.get("test", "")))
lines = [
    "# PHP PHPT Chunked Run Summary",
    "",
    f"Output directory: `{out_dir}`",
    f"Total discovered: {total}",
    f"Run total: {run_total}",
    f"Untested: {summary['untested']}",
    "",
    "| Status | Count |",
    "|---|---:|",
]
for key in ["pass", "fail", "bork", "warn", "skip", "xfail", "xpass", "unsupported", "time"]:
    lines.append(f"| {key} | {counts[key]} |")
lines.extend(["", "## Non-passing/non-xfail results", ""])
for r in nonpassing:
    detail = r.get("reason") or r.get("detail") or ""
    lines.append(f"- {r.get('status')} `{r.get('test')}`" + (f": {detail}" if detail else ""))
if parse_errors:
    lines.extend(["", "## Parse errors", ""])
    lines.extend(f"- {e}" for e in parse_errors)
(out_dir / "summary.md").write_text("\n".join(lines) + "\n")
print(json.dumps(summary, sort_keys=True))
PY
}

if [ "$summary_only" -eq 1 ]; then
  aggregate
  exit 0
fi

offset="$start_offset"
while [ "$offset" -lt "$total" ]; do
  tag=$(printf "%05d" "$offset")
  jsonl="$out_dir/chunk-$tag.jsonl"
  stderr="$out_dir/chunk-$tag.stderr"
  exit_file="$out_dir/chunk-$tag.exit"
  done_file="$out_dir/chunk-$tag.done"
  if [ "$force" -eq 0 ] && [ -f "$done_file" ]; then
    echo "[$(date -u +%H:%M:%S)] chunk offset $offset already done; skipping"
    offset=$((offset + chunk_size))
    continue
  fi
  rm -f "$jsonl" "$stderr" "$exit_file" "$done_file"
  echo "[$(date -u +%H:%M:%S)] running host=$host chunk offset=$offset limit=$chunk_size jobs=$jobs timeout=$timeout_ms reset=$host_reset_interval"
  extra_args=()
  if [ -n "$run_uid" ]; then
    extra_args+=(--run-uid "$run_uid")
  fi
  if [ -n "$run_gid" ]; then
    extra_args+=(--run-gid "$run_gid")
  fi
  set +e
  "$REPO_ROOT/scripts/run-php-upstream-tests.sh" \
    --host "$host" \
    --all \
    --offset "$offset" \
    --limit "$chunk_size" \
    --jobs "$jobs" \
    --timeout "$timeout_ms" \
    --host-reset-interval "$host_reset_interval" \
    --allow-unsupported \
    "${extra_args[@]}" \
    --json \
    > "$jsonl" 2> "$stderr"
  status=$?
  set -e
  echo "$status" > "$exit_file"
  if [ "$status" -eq 0 ]; then
    date -u +%Y-%m-%dT%H:%M:%SZ > "$done_file"
    aggregate || true
    offset=$((offset + chunk_size))
  else
    echo "chunk offset $offset failed with status $status; see $stderr" >&2
    aggregate || true
    exit "$status"
  fi
done

{
  echo "FINISHED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} >> "$metadata"
aggregate
