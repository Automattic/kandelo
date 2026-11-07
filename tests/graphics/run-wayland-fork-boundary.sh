#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
out="$(mktemp -d "$root/.context/wayland-fork-boundary.XXXXXX")"
trap 'rm -rf "$out"' EXIT
clang -std=gnu11 -O1 -g -pthread -fsanitize=undefined -fno-sanitize-recover=all \
 -I"$root/libc/glue" "$root/tests/graphics/libc/wayland-fork-boundary.c" -o "$out/control"
"$out/control"
