#!/usr/bin/env bash
set -euo pipefail
wlroots=${1:?pinned wlroots source root}
wayland=${2:?pinned wayland source root}
archive=${3:?packaged bibata-cursor-theme.zip}
work=${4:?fresh owned control directory}
tests=$(cd "$(dirname "$0")" && pwd)
mkdir "$work"
# Only Xcursor's filesystem parser is compiled, not a target/native package.
# wlroots' generated config affects optional directory-entry optimizations;
# the parser's file/format semantics do not depend on target platform macros.
printf '\n' > "$work/config.h"
clang -std=gnu11 -O2 -DCONTROL_WLROOTS -I"$work" -I"$wlroots/include" \
  "$wlroots/xcursor/xcursor.c" "$tests/load-theme.c" -o "$work/wlroots-loader"
clang -std=gnu11 -O2 -I"$wayland/cursor" \
  "$wayland/cursor/xcursor.c" "$tests/load-theme.c" -o "$work/wayland-loader"
python3 "$tests/verify-theme-loaders.py" "$archive" "$work"
