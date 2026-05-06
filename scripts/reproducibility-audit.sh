#!/usr/bin/env bash
# Builds each given package twice in clean dirs (separate cache
# roots) with PINNED provenance (timestamp + host) and diffs the
# resulting .tar.zst archives byte-for-byte.
#
# Usage:
#   bash scripts/reproducibility-audit.sh <pkg> [<pkg> ...]
#
# Bypasses scripts/stage-release.sh (which doesn't forward
# --cache-root) and calls xtask directly with pinned provenance
# (--build-timestamp + --build-host) so manifest.toml's
# [compatibility] block doesn't drift between runs.
#
# Exits 0 if all match; nonzero if any differ. Per-run output to
# /tmp/repro-audit-pilot.log.

set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <pkg> [<pkg> ...]" >&2
  exit 2
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
LOG=/tmp/repro-audit-pilot.log
: > "$LOG"

# Pin provenance to fixed values so manifest.toml [compatibility]
# block matches across both runs. This mirrors what CI will do.
PINNED_TS="2026-01-01T00:00:00Z"
PINNED_HOST="audit-pilot"

# .cargo/config.toml's [build].target defaults to wasm64-unknown-unknown
# for the kernel; xtask is a host tool and needs an explicit host target.
HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"

# Use the shared default cache (~/.cache/wasm-posix-kernel/) for deps.
# Force-rebuilding ALL deps with a per-run isolated cache turned a
# 30-60 min audit into a multi-hour rebuild of the entire registry —
# tested 2026-05-06. Per-run isolation matters for the TARGET packages
# (force-rebuild), not for transitive deps. Deps come from cache; only
# the listed target packages source-rebuild on each run.
force_args=()
for pkg in "$@"; do
  force_args+=(--force-rebuild "$pkg")
done

for run in 1 2; do
  staging="/tmp/repro-audit-staging-run$run"
  rm -rf "$staging"
  mkdir -p "$staging"

  echo "=== run $run ===" | tee -a "$LOG"
  nix develop --accept-flake-config --command \
    cargo run --release -p xtask --target "$HOST_TARGET" --quiet -- stage-release \
      --staging "$staging" \
      --tag "pr-99999-staging" \
      --arch wasm32 \
      --build-timestamp "$PINNED_TS" \
      --build-host "$PINNED_HOST" \
      "${force_args[@]}" 2>&1 | tee -a "$LOG"
done

echo "=== diff ===" | tee -a "$LOG"
all_pass=true
for pkg in "$@"; do
  a1=$(find /tmp/repro-audit-staging-run1 -name "${pkg}-*.tar.zst" 2>/dev/null | head -1)
  a2=$(find /tmp/repro-audit-staging-run2 -name "${pkg}-*.tar.zst" 2>/dev/null | head -1)

  if [ -z "$a1" ] || [ -z "$a2" ]; then
    echo "FAIL: $pkg — archive(s) missing (a1=$a1 a2=$a2)" | tee -a "$LOG"
    all_pass=false
    continue
  fi

  name1=$(basename "$a1")
  name2=$(basename "$a2")

  if [ "$name1" != "$name2" ]; then
    echo "FAIL: $pkg — filenames differ (sha differs)" | tee -a "$LOG"
    echo "  run 1: $name1" | tee -a "$LOG"
    echo "  run 2: $name2" | tee -a "$LOG"
    all_pass=false
    continue
  fi

  if cmp -s "$a1" "$a2"; then
    echo "PASS: $pkg ($name1)" | tee -a "$LOG"
  else
    echo "FAIL: $pkg — same filename but bytes differ" | tee -a "$LOG"
    # Help diagnose: extract and tree-diff.
    mkdir -p "/tmp/repro-audit-$pkg-x1" "/tmp/repro-audit-$pkg-x2"
    (cd "/tmp/repro-audit-$pkg-x1" && zstd -dc "$a1" | tar -x)
    (cd "/tmp/repro-audit-$pkg-x2" && zstd -dc "$a2" | tar -x)
    diff -r --brief "/tmp/repro-audit-$pkg-x1" "/tmp/repro-audit-$pkg-x2" 2>&1 | tee -a "$LOG"
    all_pass=false
  fi
done

$all_pass
