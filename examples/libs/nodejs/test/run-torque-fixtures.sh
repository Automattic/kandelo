#!/usr/bin/env bash
# Runs torque over the stock V8 fileset + Phase-2 fixtures, then
# diffs each fixture's generated -tq-ccbuiltins.cc against its golden.
#
# Usage:
#   bash examples/libs/nodejs/test/run-torque-fixtures.sh            # all
#   bash examples/libs/nodejs/test/run-torque-fixtures.sh return     # one
#   UPDATE_GOLDEN=1 bash examples/libs/nodejs/test/run-torque-fixtures.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_SRC="${HERE}/../build/node"
TORQUE="${NODE_SRC}/out/Release.baseline/torque"
FIX_DIR="${HERE}/torque-fixtures"
GOLD_DIR="${FIX_DIR}/golden"
OUT_DIR="$(mktemp -d)"
trap 'rm -rf "${OUT_DIR}"' EXIT

[ -d "${NODE_SRC}/deps/v8" ] || {
  echo "Missing ${NODE_SRC}/deps/v8 — run examples/libs/nodejs/build-nodejs.sh first" >&2
  exit 1
}
[ -x "${TORQUE}" ] || { echo "Missing ${TORQUE}" >&2; exit 1; }

# Full stock fileset — correct grep pattern includes src/, test/, and
# third_party/ paths (Phase 1's plan used a narrower pattern that missed
# test/torque/test-torque.tq and third_party/v8/builtins/array-sort.tq).
# cd is permanent for the rest of the script — torque needs cwd=NODE_SRC
# so that -v8-root=deps/v8 resolves input paths correctly.
cd "${NODE_SRC}"
STOCK_TQ=()
while IFS= read -r tq; do
  STOCK_TQ+=("${tq}")
done < <(grep -oE '"(src|test|third_party)/[^"]*\.tq"' deps/v8/BUILD.gn \
           | tr -d '"' | sort -u)

# Fixture staging — torque embeds its source-position path (as a file://
# URI for non-v8-root inputs) into the generated `// Source:` comment.
# To keep goldens portable across machines/CI, we stage each fixture as
# a symlink under $NODE_SRC/deps/v8/test/phase2-fixtures/ and pass the
# v8-root-relative path (test/phase2-fixtures/<name>.tq). Torque then
# sees the fixture as if it lived in the V8 tree; the -v8-root=deps/v8
# prefix resolves reads, and output lands at
# $OUT_DIR/test/phase2-fixtures/<name>-tq-ccbuiltins.cc with a stable,
# host-independent `// Source:` comment.
STAGE_REL="test/phase2-fixtures"
STAGE_ABS="${NODE_SRC}/deps/v8/${STAGE_REL}"
# Clean up any stale symlinks from a prior run; recreate empty.
rm -rf "${STAGE_ABS}"
mkdir -p "${STAGE_ABS}"
trap 'rm -rf "${OUT_DIR}" "${STAGE_ABS}"' EXIT

# Fixture file list — each fixture is symlinked into STAGE_DIR and the
# v8-root-relative path is what we pass to torque.
FILTER="${1:-}"
FIXTURES=()        # absolute source paths (worktree)
FIXTURE_RELS=()    # v8-root-relative paths (for torque CLI + output path)
for tq in "${FIX_DIR}"/*.tq; do
  [ -f "${tq}" ] || continue
  name="$(basename "${tq}" .tq)"
  if [ -n "${FILTER}" ] && [ "${name}" != "${FILTER}" ]; then continue; fi
  FIXTURES+=("${tq}")
  rel="${STAGE_REL}/${name}.tq"
  FIXTURE_RELS+=("${rel}")
  ln -sf "${tq}" "${STAGE_ABS}/${name}.tq"
done
[ ${#FIXTURES[@]} -gt 0 ] || { echo "No fixtures matching '${FILTER}'"; exit 1; }

# Pre-create output parent dirs (torque doesn't mkdir -p).
for f in "${STOCK_TQ[@]}" "${FIXTURE_RELS[@]}"; do
  mkdir -p "${OUT_DIR}/$(dirname "${f}")"
done

# Build whitelist CSV by scanning fixtures for any TorqueCcTest_<Name>
# token. This is intentionally liberal: multi-line declarations like
# `builtin\n    TorqueCcTest_Foo(...)` would be missed by a stricter
# `builtin TorqueCcTest_...` match. Over-including a name that isn't
# actually a builtin is harmless — torque ignores unmatched whitelist
# entries. Fixtures MAY define helper builtins (e.g. a CallBuiltin test
# needs both the caller and the callee on the whitelist); all
# TorqueCcTest_* identifiers in a fixture get included automatically.
WHITELIST=()
for tq in "${FIXTURES[@]}"; do
  while IFS= read -r entry; do
    WHITELIST+=("${entry}")
  done < <(grep -oE 'TorqueCcTest_[A-Za-z0-9_]+' "${tq}" | sort -u)
done
OLD_IFS="${IFS}"
IFS=,
WHITELIST_CSV="${WHITELIST[*]}"
IFS="${OLD_IFS}"

# Run torque over stock + staged fixtures.
"${TORQUE}" \
  --cc-builtins-whitelist="${WHITELIST_CSV}" \
  -o "${OUT_DIR}" \
  -v8-root deps/v8 \
  "${STOCK_TQ[@]}" "${FIXTURE_RELS[@]}"

# Diff each fixture's -tq-ccbuiltins.cc against its golden.
RC=0
for i in "${!FIXTURES[@]}"; do
  tq="${FIXTURES[$i]}"
  rel="${FIXTURE_RELS[$i]}"
  name="$(basename "${tq}" .tq)"
  actual="${OUT_DIR}/${rel%.tq}-tq-ccbuiltins.cc"
  golden="${GOLD_DIR}/${name}-tq-ccbuiltins.cc"
  if [ ! -f "${actual}" ]; then
    echo "MISSING: ${actual}"
    RC=1
    continue
  fi
  if [ "${UPDATE_GOLDEN:-0}" = "1" ]; then
    cp "${actual}" "${golden}"
    echo "UPDATED: ${golden}"
    continue
  fi
  if ! diff -u "${golden}" "${actual}"; then
    echo "DIFF:    ${name}"
    RC=1
  else
    echo "OK:      ${name}"
  fi
done
exit ${RC}
