#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
output_dir="$(mktemp -d "$repo_root/.context/graphics-wayland-client.XXXXXX")"
trap 'rm -rf "$output_dir"' EXIT
# Input is the normal resolver's immutable verified source payload. Recheck
# against the manifest before private extraction; never fetch or publish here.
archive="${1:?provide the resolver-owned Wayland source archive}"
python3 - "$repo_root/packages/registry/libwayland/package.toml" "$archive" "$output_dir" <<'PY'
import hashlib,pathlib,sys,tarfile,tomllib
manifest=tomllib.loads(pathlib.Path(sys.argv[1]).read_text())
payload=pathlib.Path(sys.argv[2])
assert payload.is_file() and not payload.is_symlink()
assert hashlib.sha256(payload.read_bytes()).hexdigest()==manifest['source']['sha256']
with tarfile.open(payload) as archive:archive.extractall(sys.argv[3],filter='data')
PY
source_root="$output_dir/wayland-1.24.0"
mkdir -p "$output_dir/include"
printf '#define PACKAGE_VERSION "1.24.0"\n' > "$source_root/config.h"
wayland-scanner client-header "$source_root/protocol/wayland.xml" "$output_dir/include/wayland-client-protocol.h"
wayland-scanner public-code "$source_root/protocol/wayland.xml" "$output_dir/protocol.c"
sed -e 's/@WAYLAND_VERSION_MAJOR@/1/g' -e 's/@WAYLAND_VERSION_MINOR@/24/g' \
    -e 's/@WAYLAND_VERSION_MICRO@/0/g' -e 's/@WAYLAND_VERSION@/1.24.0/g' \
    "$source_root/src/wayland-version.h.in" > "$output_dir/include/wayland-version.h"
read -r -a ffi_flags <<< "$(pkg-config --cflags --libs libffi)"
clang -g -O1 -pthread -fsanitize="${KANDELO_GRAPHICS_SANITIZERS:-undefined}" \
    -fno-sanitize-recover=all -fno-omit-frame-pointer -DHAVE_CONFIG_H \
    "-DWPK_WAYLAND_CLIENT_SOURCE=\"$source_root/src/wayland-client.c\"" \
    -I"$output_dir/include" -I"$source_root/src" -I"$source_root" -I"$repo_root/libc/glue" \
    "$repo_root/tests/graphics/libc/wayland-connection.c" \
    "$source_root/src/wayland-util.c" "$source_root/src/connection.c" "$output_dir/protocol.c" \
    "${ffi_flags[@]}" -o "$output_dir/connection"
python3 - "$output_dir/connection" <<'PYTHON'
import subprocess,sys
try:
    result=subprocess.run(sys.argv[1:],timeout=30)
except subprocess.TimeoutExpired:
    raise SystemExit("FAIL: native Wayland connection case timed out")
sys.exit(result.returncode if result.returncode>=0 else 128-result.returncode)
PYTHON
