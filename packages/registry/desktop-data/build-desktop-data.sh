#!/usr/bin/env bash
# Runtime data for Cage/Foot and Sway; no compositor or guest tool compilation.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$HERE" wasm32
kandelo_package_select_source_root "$REPO_ROOT"
python3 - "$KANDELO_PACKAGE_SOURCE_ROOT" "$WASM_POSIX_DEP_OUT_DIR/kandelo-desktop-data.zip" <<'ARCHIVE'
from pathlib import Path
import sys,zipfile
root=Path(sys.argv[1]);data=root/'packages/registry/wayland-demo/desktops/data'
entries=[(str(p.relative_to(data)),p) for d in ['sway','foot'] for p in (data/d).rglob('*') if p.is_file()]
entries.append(('fonts/fonts.conf',data/'fonts/fonts.conf'))
entries.append(('fonts/Inconsolata-Regular.ttf',root/'third_party/Inconsolata-Regular.ttf'))
with zipfile.ZipFile(sys.argv[2],'w',zipfile.ZIP_DEFLATED) as z:
 for name,p in sorted(entries):
  if p.is_symlink():raise RuntimeError('Desktop input must be a regular file: '+str(p))
  info=zipfile.ZipInfo(name,date_time=(1980,1,1,0,0,0));info.external_attr=0o644<<16;info.compress_type=zipfile.ZIP_DEFLATED;z.writestr(info,p.read_bytes())
ARCHIVE
install -m 0644 "${WASM_POSIX_DEP_LIBINPUT_DIR:?}/share/libinput-quirks.zip" "$WASM_POSIX_DEP_OUT_DIR/libinput-quirks.zip"
install -m 0644 "${WASM_POSIX_DEP_XKEYBOARD_CONFIG_DIR:?}/share/xkeyboard-config.zip" "$WASM_POSIX_DEP_OUT_DIR/xkeyboard-config.zip"
