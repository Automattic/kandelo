#!/bin/sh
set -eu
if [ -n "${FAKE_OPT_ARGS:-}" ]; then printf '%s\n' "$@" > "$FAKE_OPT_ARGS"; fi
source=$1
output=
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then shift; output=$1; break; fi
  shift
done
case "$FAKE_OPT_MODE" in
  copy) cp "$source" "$output" ;;
  invalid) printf 'invalid wasm' > "$output" ;;
  oversize) head -c 65536 /dev/zero > "$output" ;;
  fail) printf 'partial output' > "$output"; exit 23 ;;
esac
