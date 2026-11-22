#!/usr/bin/env bash
# Build Meson for Kandelo as meson.zip, mounted at /usr.
#
# Meson is pure Python. The archive holds the mesonbuild package (with its
# package data) in its own directory, lib/meson, and bin/meson, the console
# script setup.cfg declares, which puts that directory on sys.path and is
# run by /usr/bin/python3. Meson stays out of the guest Python's own tree
# (lib/python3.X), which other images copy as Python's; a lazy archive
# mounted inside it would leave deferred files in their copies. Upstream's
# setup.py also installs a polkit policy for `meson install` elevation;
# Kandelo has no polkit, so it is left out. meson.1 ships in meson-docs.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$HERE"
kandelo_package_prepare_build_roots "$HERE" wasm32
WORK="$KANDELO_PACKAGE_WORK_DIR"
SRC="$WORK/meson-src"
STAGE="$WORK/meson-stage"
ARCHIVE="$WORK/meson.zip"
# The interpreter bin/meson runs.
PYTHON_ZIP="${WASM_POSIX_DEP_PYTHON_BROWSER_BUNDLE_DIR:?python-browser-bundle dependency dir required}/python.zip"
[ -f "$PYTHON_ZIP" ] || { echo "ERROR: no $PYTHON_ZIP" >&2; exit 1; }

rm -rf "$SRC" "$STAGE" "$ARCHIVE"
kandelo_package_stage_primary_source meson "$SRC" "$WORK"
for patch in "$HERE"/patches/*.patch; do
    [ -f "$patch" ] || continue
    echo "==> Applying $(basename "$patch")"
    patch -p1 -d "$SRC" < "$patch"
done

[ -f "$SRC/mesonbuild/mesonmain.py" ] || { echo "ERROR: no mesonbuild/mesonmain.py" >&2; exit 1; }
SITE="$STAGE/lib/meson"
mkdir -p "$SITE" "$STAGE/bin"
# The sdist's mesonbuild tree is the installed package: every .py module
# and the package data setup.cfg names (cmake/data, dependencies/data,
# scripts/cmd_or_ps.ps1). Bytecode is left out, as for the standard
# library in python.zip.
(cd "$SRC" && find mesonbuild -name __pycache__ -prune -o -type f ! -name '*.pyc' -print) \
    | LC_ALL=C sort | while IFS= read -r file; do
        mkdir -p "$SITE/$(dirname "$file")"
        cp "$SRC/$file" "$SITE/$file"
    done
# The console script pip writes for `meson = mesonbuild.mesonmain:main`,
# with the package's directory put first on sys.path.
cat > "$STAGE/bin/meson" <<'PY'
#!/usr/bin/python3
# -*- coding: utf-8 -*-
import re
import sys
sys.path.insert(0, '/usr/lib/meson')
from mesonbuild.mesonmain import main
if __name__ == '__main__':
    sys.argv[0] = re.sub(r'(-script\.pyw|\.exe)?$', '', sys.argv[0])
    sys.exit(main())
PY
chmod 755 "$STAGE/bin/meson"
mkdir -p "$STAGE/share/licenses/meson"
cp "$SRC/COPYING" "$STAGE/share/licenses/meson/COPYING"

bash "$REPO_ROOT/images/vfs/scripts/create-deterministic-zip.sh" "$STAGE" "$ARCHIVE"
ls -lh "$ARCHIVE"

if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled
fi
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary meson "$ARCHIVE" meson.zip
