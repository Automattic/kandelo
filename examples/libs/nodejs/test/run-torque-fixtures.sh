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

# Fixture file list — each relative to ${HERE}.
FILTER="${1:-}"
FIXTURES=()
for tq in "${FIX_DIR}"/*.tq; do
  [ -f "${tq}" ] || continue
  name="$(basename "${tq}" .tq)"
  if [ -n "${FILTER}" ] && [ "${name}" != "${FILTER}" ]; then continue; fi
  FIXTURES+=("${tq}")
done
[ ${#FIXTURES[@]} -gt 0 ] || { echo "No fixtures matching '${FILTER}'"; exit 1; }

# Pre-create output parent dirs (torque doesn't mkdir -p).
for f in "${STOCK_TQ[@]}" "${FIXTURES[@]}"; do
  case "${f}" in
    /*) rel="${f#${NODE_SRC}/}" ;;
    *)  rel="${f}" ;;
  esac
  mkdir -p "${OUT_DIR}/$(dirname "${rel}")"
done

# Run torque over stock + fixtures.
"${TORQUE}" \
  -o "${OUT_DIR}" \
  -v8-root deps/v8 \
  "${STOCK_TQ[@]}" "${FIXTURES[@]}"

# Diff each fixture's -tq-ccbuiltins.cc against its golden.
RC=0
for tq in "${FIXTURES[@]}"; do
  name="$(basename "${tq}" .tq)"
  # The fixture path under OUT_DIR mirrors its path under NODE_SRC. Since
  # fixtures live outside NODE_SRC, torque's -v8-root=deps/v8 will produce
  # output under OUT_DIR using the absolute path of the fixture.
  actual="${OUT_DIR}${tq%.tq}-tq-ccbuiltins.cc"
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
