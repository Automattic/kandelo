#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$SCRIPT_DIR"
source "$REPO_ROOT/sdk/activate.sh"
ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" "$ARCH"
WORK_DIR="$(kandelo_package_make_work_dir libevent)"
trap 'rm -rf "$WORK_DIR"' EXIT
SRC_DIR="$WORK_DIR/source"
OUT_DIR="${WASM_POSIX_DEP_OUT_DIR:?resolve libevent through build-deps}"
kandelo_package_stage_primary_source libevent "$SRC_DIR" "$WORK_DIR"
source "$SCRIPT_DIR/configure-libevent.sh"
kandelo_libevent_configure "$SRC_DIR" "$ARCH"
make -j4 libevent.la libevent_core.la libevent_extra.la libevent_pthreads.la
# Stage only declared artifacts. pkg-config files use a relocatable prefix.
python3 - "$SCRIPT_DIR/package.toml" "$SRC_DIR" "$OUT_DIR" <<'PYTHON'
import pathlib, re, shutil, sys, tomllib
manifest, source, output = map(pathlib.Path, sys.argv[1:])
outputs = tomllib.loads(manifest.read_text())["outputs"]
for group, paths in outputs.items():
    for name in paths:
        target = output / name
        target.parent.mkdir(parents=True, exist_ok=True)
        if group == "libs": origin = source / ".libs" / target.name
        elif group == "pkgconfig": origin = source / target.name
        elif group == "files": origin = source / "LICENSE"
        else: origin = source / name
        if group == "pkgconfig":
            target.write_text(re.sub(r"(?m)^prefix=.*$", "prefix=${pcfiledir}/../..", origin.read_text()))
        else: shutil.copyfile(origin, target)
PYTHON
