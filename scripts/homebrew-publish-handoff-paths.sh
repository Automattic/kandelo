#!/usr/bin/env bash
# Normalize actions/download-artifact's flat and named-directory topologies
# into one inert, NUL-delimited publication-handoff path manifest.
set -euo pipefail
export LC_ALL=C

ROOT=""
PLANNED_MATRIX=""
RUN_ATTEMPT=""
OUT=""

usage() {
  cat >&2 <<'EOF'
usage: homebrew-publish-handoff-paths.sh \
  --root DIR --planned-matrix JSON --run-attempt NUMBER --out FILE
EOF
  exit 2
}

fail() {
  echo "homebrew-publish-handoff-paths.sh: $*" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --root) ROOT="${2:-}"; shift 2 ;;
    --planned-matrix) PLANNED_MATRIX="${2:-}"; shift 2 ;;
    --run-attempt) RUN_ATTEMPT="${2:-}"; shift 2 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    -h|--help) usage ;;
    *) usage ;;
  esac
done

[ -n "$ROOT" ] && [ -n "$PLANNED_MATRIX" ] && \
  [ -n "$RUN_ATTEMPT" ] && [ -n "$OUT" ] || usage
[[ "$RUN_ATTEMPT" =~ ^[1-9][0-9]*$ ]] || fail "invalid workflow run attempt"
[ -d "$ROOT" ] && [ ! -L "$ROOT" ] || fail "artifact root is not a regular directory"
[ ! -e "$OUT" ] && [ ! -L "$OUT" ] || fail "output path already exists"
[ -d "$(dirname "$OUT")" ] && [ ! -L "$(dirname "$OUT")" ] || \
  fail "output parent is not a regular directory"
root_physical="$(cd "$ROOT" && pwd -P)"
out_name="$(basename "$OUT")"
out_parent_physical="$(cd "$(dirname "$OUT")" && pwd -P)"
[ "$out_name" != "." ] && [ "$out_name" != ".." ] || fail "invalid output filename"
OUT="$out_parent_physical/$out_name"
case "$OUT" in
  "$root_physical"|"$root_physical"/*) \
    fail "output path must be outside the artifact download" ;;
esac

declare -a formulae=() arches=() expected_names=()
matrix_tsv="$(mktemp)"
unsafe_entries="$(mktemp)"
cleanup() {
  rm -f "$matrix_tsv" "$unsafe_entries"
}
trap cleanup EXIT

if ! jq -er '
  if type != "array" or length == 0 then
    error("planned matrix must be a nonempty array")
  elif any(.[];
    type != "object" or keys != ["arch", "formula"] or
    (.formula | type != "string" or test("^[a-z0-9][a-z0-9._-]*$") | not) or
    (.arch != "wasm32" and .arch != "wasm64")) then
    error("planned matrix contains an invalid entry")
  elif ([.[] | "\(.formula)/\(.arch)"] | length) !=
       ([.[] | "\(.formula)/\(.arch)"] | unique | length) then
    error("planned matrix contains a duplicate publication")
  else
    .[] | [.formula, .arch] | @tsv
  end
' <<<"$PLANNED_MATRIX" >"$matrix_tsv"; then
  fail "planned matrix is invalid"
fi

while IFS=$'\t' read -r formula arch; do
  formulae+=("$formula")
  arches+=("$arch")
  expected_names+=("homebrew-publish-handoff-${formula}-${arch}-attempt-${RUN_ATTEMPT}")
done <"$matrix_tsv"
[ "${#formulae[@]}" -gt 0 ] || fail "planned matrix is empty"

declare -a top_entries=()
shopt -s nullglob dotglob
top_entries=("$ROOT"/*)
[ "${#top_entries[@]}" -gt 0 ] || fail "artifact download is empty"

# Artifact extraction must produce only real directories and regular files.
# The package-scoped validator checks the exact payload grammar afterward; this
# early pass prevents topology decisions from following symlinks or devices.
if ! find "$ROOT" -mindepth 1 \
  \( -type l -o \( ! -type d -a ! -type f \) \) -print0 >"$unsafe_entries"; then
  fail "could not inspect the complete artifact download"
fi
[ ! -s "$unsafe_entries" ] || \
  fail "artifact download contains a symlink or special file"

for entry in "${top_entries[@]}"; do
  entry_name="${entry##*/}"
  [[ "$entry_name" =~ ^[A-Za-z0-9._-]+$ ]] || \
    fail "artifact download contains an unsafe top-level name"
done

declare -a handoffs=()
flat=0
for flat_name in build composition receipt.json; do
  if [ -e "$ROOT/$flat_name" ] || [ -L "$ROOT/$flat_name" ]; then
    flat=1
    break
  fi
done

if [ "$flat" -eq 1 ]; then
  [ "${#expected_names[@]}" -eq 1 ] || \
    fail "flattened handoff is only valid for one planned publication"
  [ "${#top_entries[@]}" -eq 3 ] || \
    fail "flattened handoff contains unexpected entries"
  [ -d "$ROOT/build" ] && [ ! -L "$ROOT/build" ] || \
    fail "flattened build payload is not a regular directory"
  [ -d "$ROOT/composition" ] && [ ! -L "$ROOT/composition" ] || \
    fail "flattened composition payload is not a regular directory"
  [ -f "$ROOT/receipt.json" ] && [ ! -L "$ROOT/receipt.json" ] || \
    fail "flattened receipt is not a regular file"
  for entry in "${top_entries[@]}"; do
    case "${entry##*/}" in
      build|composition|receipt.json) ;;
      *) fail "flattened handoff contains an unexpected entry" ;;
    esac
  done
  handoffs+=("$ROOT")
else
  [ "${#top_entries[@]}" -eq "${#expected_names[@]}" ] || \
    fail "nested handoffs differ from the exact planned matrix"
  declare -A expected=()
  for expected_name in "${expected_names[@]}"; do
    expected["$expected_name"]=1
  done
  for entry in "${top_entries[@]}"; do
    entry_name="${entry##*/}"
    [ -d "$entry" ] && [ ! -L "$entry" ] || \
      fail "nested handoff entry is not a regular directory"
    [ -n "${expected[$entry_name]+x}" ] || \
      fail "nested handoff directory is not in the exact planned matrix"
  done
  for expected_name in "${expected_names[@]}"; do
    expected_path="$ROOT/$expected_name"
    [ -d "$expected_path" ] && [ ! -L "$expected_path" ] || \
      fail "nested handoff from the planned matrix is missing"
    handoffs+=("$expected_path")
  done
fi

[ "${#handoffs[@]}" -eq "${#formulae[@]}" ] || \
  fail "normalized handoff count differs from the planned matrix"
umask 077
: >"$OUT"
for ((index = 0; index < ${#handoffs[@]}; index++)); do
  printf '%s\0%s\0%s\0' \
    "${formulae[$index]}" "${arches[$index]}" "${handoffs[$index]}" >>"$OUT"
done
