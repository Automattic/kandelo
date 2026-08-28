#!/usr/bin/env bash
#
# Build python.zip for the browser shell demo: a root-relative archive of
# bin/python3 (the interpreter) + bin/python (symlink) + lib/python3.13
# (the standard library). The shell overlay mounts it at /usr/, so entries
# become /usr/bin/python3 and /usr/lib/python3.13/... On first exec the
# whole archive is fetched and unpacked in one go.
#
#   build-python-zip.sh <cpython-dependency-dir> <output.zip>
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

[ "$#" -eq 2 ] || { echo "usage: $0 <cpython-dependency-dir> <output.zip>" >&2; exit 2; }
CPYTHON_DIR="$1"
OUTPUT_FILE="$2"

# The cpython package exposes both its declared output (python.wasm) and its
# runtime_files closure (python-runtime.zip) directly in the dependency dir.
PYTHON_WASM="$CPYTHON_DIR/python.wasm"
RUNTIME_ZIP="$CPYTHON_DIR/python-runtime.zip"
[ -f "$PYTHON_WASM" ] || { echo "python.wasm not found under $CPYTHON_DIR" >&2; exit 1; }
[ -f "$RUNTIME_ZIP" ] || { echo "python-runtime.zip not found under $CPYTHON_DIR" >&2; exit 1; }

if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ]; then
    STAGING="$(mktemp -d "$WASM_POSIX_DEP_WORK_DIR/python-zip.XXXXXX")"
    EXTRACT="$(mktemp -d "$WASM_POSIX_DEP_WORK_DIR/python-extract.XXXXXX")"
else
    STAGING="$(mktemp -d)"; EXTRACT="$(mktemp -d)"
fi
trap 'rm -rf "$STAGING" "$EXTRACT"' EXIT

echo "==> Extracting python-runtime.zip..."
unzip -q "$RUNTIME_ZIP" -d "$EXTRACT"
# runtime zip is rooted at lib/python3.13 (no usr/ prefix) with the license
# tree under share/licenses/cpython.
[ -d "$EXTRACT/lib/python3.13" ] || { echo "runtime zip missing lib/python3.13" >&2; exit 1; }
[ -f "$EXTRACT/lib/python3.13/os.py" ] || { echo "runtime zip missing lib/python3.13/os.py" >&2; exit 1; }

echo "==> Staging python.zip tree..."
mkdir -p "$STAGING/bin" "$STAGING/lib"
# Standard library tree (lib/python3.13/...).
cp -R "$EXTRACT/lib/python3.13" "$STAGING/lib/python3.13"
# The interpreter as bin/python3 (no .wasm extension), plus the conventional
# python alias as a symlink.
cp "$PYTHON_WASM" "$STAGING/bin/python3"
chmod 755 "$STAGING/bin/python3"
ln -s python3 "$STAGING/bin/python"
# Carry the license tree if the runtime shipped one.
if [ -f "$EXTRACT/share/licenses/cpython/LICENSE" ]; then
    mkdir -p "$STAGING/share/licenses/cpython"
    cp "$EXTRACT/share/licenses/cpython/LICENSE" "$STAGING/share/licenses/cpython/LICENSE"
fi

# Exactly one regular executable named bin/python3 is required by the loader.
[ -f "$STAGING/bin/python3" ] || { echo "bin/python3 missing" >&2; exit 1; }

OUTPUT_DIR="$(dirname "$OUTPUT_FILE")"; mkdir -p "$OUTPUT_DIR"; rm -f "$OUTPUT_FILE"
bash "$SCRIPT_DIR/create-deterministic-zip.sh" "$STAGING" "$OUTPUT_FILE"
echo "    $(find "$STAGING" -type f | wc -l | tr -d ' ') files"
ls -lh "$OUTPUT_FILE"
