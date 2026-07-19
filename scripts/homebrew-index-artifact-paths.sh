#!/usr/bin/env bash
# Normalize actions/download-artifact's pattern-download topology without
# merging artifacts that contain colliding layout/ and receipt.json paths.
set -euo pipefail
export LC_ALL=C

ROOT=""
KIND=""
FORMULA=""
RUN_ATTEMPT=""
OUT=""

usage() {
  cat >&2 <<'EOF'
usage: homebrew-index-artifact-paths.sh \
  --root DIR --kind child|publication --formula NAME \
  --run-attempt NUMBER --out FILE
EOF
  exit 2
}

fail() {
  echo "homebrew-index-artifact-paths.sh: $*" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --root) ROOT="${2:-}"; shift 2 ;;
    --kind) KIND="${2:-}"; shift 2 ;;
    --formula) FORMULA="${2:-}"; shift 2 ;;
    --run-attempt) RUN_ATTEMPT="${2:-}"; shift 2 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    -h|--help) usage ;;
    *) usage ;;
  esac
done

[ -n "$ROOT" ] && [ -n "$KIND" ] && [ -n "$FORMULA" ] && \
  [ -n "$RUN_ATTEMPT" ] && [ -n "$OUT" ] || usage
case "$KIND" in
  child) artifact_prefix="homebrew-oci-child" ;;
  publication) artifact_prefix="homebrew-upload-receipt" ;;
  *) usage ;;
esac
[[ "$FORMULA" =~ ^[a-z0-9][a-z0-9._-]*$ ]] || fail "invalid Formula name"
[[ "$RUN_ATTEMPT" =~ ^[1-9][0-9]*$ ]] || fail "invalid workflow run attempt"
[ -d "$ROOT" ] && [ ! -L "$ROOT" ] || fail "artifact root is not a regular directory"
[ ! -e "$OUT" ] && [ ! -L "$OUT" ] || fail "output path already exists"
[ -d "$(dirname "$OUT")" ] && [ ! -L "$(dirname "$OUT")" ] || \
  fail "output parent is not a regular directory"

declare -a top_entries=()
shopt -s nullglob dotglob
top_entries=("$ROOT"/*)
[ "${#top_entries[@]}" -gt 0 ] || fail "artifact download is empty"

flat=0
if [ -e "$ROOT/receipt.json" ] || [ -L "$ROOT/receipt.json" ]; then
  flat=1
fi

declare -a receipts=()
if [ "$flat" -eq 1 ]; then
  [ -f "$ROOT/receipt.json" ] && [ ! -L "$ROOT/receipt.json" ] || \
    fail "flattened receipt is not a regular file"
  if [ "$KIND" = "child" ]; then
    [ -d "$ROOT/layout" ] && [ ! -L "$ROOT/layout" ] || \
      fail "flattened child layout is not a regular directory"
    [ "${#top_entries[@]}" -eq 2 ] || \
      fail "flattened child artifact contains unexpected entries"
    for entry in "${top_entries[@]}"; do
      case "${entry##*/}" in
        layout|receipt.json) ;;
        *) fail "flattened child artifact contains an unexpected entry" ;;
      esac
    done
  else
    [ "${#top_entries[@]}" -eq 1 ] || \
      fail "flattened publication artifact contains unexpected entries"
  fi
  receipts+=("$ROOT/receipt.json")
else
  declare -A seen_arch=()
  for entry in "${top_entries[@]}"; do
    [ -d "$entry" ] && [ ! -L "$entry" ] || \
      fail "nested artifact entry is not a regular directory"
    matched_arch=""
    for arch in wasm32 wasm64; do
      if [ "${entry##*/}" = "${artifact_prefix}-${FORMULA}-${arch}-attempt-${RUN_ATTEMPT}" ]; then
        matched_arch="$arch"
        break
      fi
    done
    [ -n "$matched_arch" ] || fail "nested artifact directory has an unexpected name"
    [ -z "${seen_arch[$matched_arch]+x}" ] || fail "duplicate nested artifact architecture"
    seen_arch["$matched_arch"]=1
    [ -f "$entry/receipt.json" ] && [ ! -L "$entry/receipt.json" ] || \
      fail "nested receipt is not a regular file"
    declare -a nested_entries=()
    nested_entries=("$entry"/*)
    if [ "$KIND" = "child" ]; then
      [ -d "$entry/layout" ] && [ ! -L "$entry/layout" ] || \
        fail "nested child layout is not a regular directory"
      [ "${#nested_entries[@]}" -eq 2 ] || \
        fail "nested child artifact contains unexpected entries"
      for nested_entry in "${nested_entries[@]}"; do
        case "${nested_entry##*/}" in
          layout|receipt.json) ;;
          *) fail "nested child artifact contains an unexpected entry" ;;
        esac
      done
    else
      [ "${#nested_entries[@]}" -eq 1 ] || \
        fail "nested publication artifact contains unexpected entries"
    fi
    receipts+=("$entry/receipt.json")
  done
  [ "${#receipts[@]}" -eq 2 ] || \
    fail "nested artifact download must contain multiple artifacts"
fi

[ "${#receipts[@]}" -gt 0 ] && [ "${#receipts[@]}" -le 2 ] || \
  fail "artifact download has an invalid receipt count"
umask 077
: >"$OUT"
for receipt in "${receipts[@]}"; do
  printf '%s\0' "$receipt" >>"$OUT"
done
