#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$repo_root/.scratch"
output_dir="$(mktemp -d "$repo_root/.scratch/graphics-wayland-client.XXXXXX")"
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
python3 "$repo_root/libc/glue/check-wayland-client-layout.py" "$source_root/src"
mkdir -p "$output_dir/include"
printf '#define PACKAGE_VERSION "1.24.0"\n' > "$source_root/config.h"
wayland-scanner client-header "$source_root/protocol/wayland.xml" "$output_dir/include/wayland-client-protocol.h"
wayland-scanner public-code "$source_root/protocol/wayland.xml" "$output_dir/protocol.c"
sed -e 's/@WAYLAND_VERSION_MAJOR@/1/g' -e 's/@WAYLAND_VERSION_MINOR@/24/g' \
    -e 's/@WAYLAND_VERSION_MICRO@/0/g' -e 's/@WAYLAND_VERSION@/1.24.0/g' \
    "$source_root/src/wayland-version.h.in" > "$output_dir/include/wayland-version.h"
owned_log_source="${KANDELO_WAYLAND_OWNED_LOG_SOURCE:-$repo_root/libc/glue/wayland-owned-log.inc}"
lifetime_source="${KANDELO_WAYLAND_LIFETIME_SOURCE:-$repo_root/libc/glue/wayland-client-lifetime.inc}"
cat > "$output_dir/util-owned.c" <<EOF
#define wl_log _wpk_upstream_wl_log
#include "$source_root/src/wayland-util.c"
#include "$owned_log_source"
EOF
if [ "${KANDELO_WAYLAND_RAW_BEFORE:-0}" = 1 ];then
 cat > "$output_dir/client-native-allocated.c" <<EOF
#include "$source_root/src/wayland-client.c"
EOF
else
 cat > "$output_dir/client-native-allocated.c" <<EOF
#include "$repo_root/libc/glue/wayland-client-raw-prelude.inc"
#include "$source_root/src/wayland-client.c"
#include "$repo_root/libc/glue/wayland-client-raw-undef.inc"
#include "$repo_root/libc/glue/wayland-client-raw-entry.inc"
EOF
fi
connection_source="$output_dir/connection-owned.c"
if [ "${KANDELO_WAYLAND_RAW_BEFORE:-0}" = 1 ];then
 connection_source="$source_root/src/connection.c"
else
 cat > "$connection_source" <<EOF
#include "$repo_root/libc/glue/wayland-connection-callback-prelude.inc"
#include "$source_root/src/connection.c"
EOF
fi
read -r -a ffi_flags <<< "$(pkg-config --cflags --libs libffi)"
clang -g -O1 -pthread -include "$repo_root/tests/graphics/libc/wayland-native-allocation-double.h" -fsanitize="${KANDELO_GRAPHICS_SANITIZERS:-undefined}" \
    -fno-sanitize-recover=all -fno-omit-frame-pointer -DHAVE_CONFIG_H -DKANDELO_WAYLAND_NATIVE_EPOCH_DOUBLE \
    "-DWPK_WAYLAND_CLIENT_SOURCE=\"$output_dir/client-native-allocated.c\"" \
    "-DWPK_WAYLAND_LIFETIME_SOURCE=\"$lifetime_source\"" \
    -I"$output_dir/include" -I"$source_root/src" -I"$source_root" -I"$repo_root/libc/glue" \
    "$repo_root/tests/graphics/libc/wayland-raw-log.c" \
    "$output_dir/util-owned.c" "$connection_source" "$output_dir/protocol.c" \
    "${ffi_flags[@]}" -o "$output_dir/connection"
python3 - "$output_dir/connection" "${@:2}" <<'PYTHON'
import json,os,pathlib,subprocess,sys
rows=[]
for mode in (sys.argv[2:] or ['queue-exit','marshal-exit','constructor-exit','protocol-error-exit','proxy-constructor-exit']):
 r=subprocess.run([sys.argv[1],mode],capture_output=True,text=True,timeout=20)
 print(r.stdout+r.stderr,end='',flush=True)
 expected=42 if os.environ.get('KANDELO_WAYLAND_RAW_BEFORE')=='1' else 0
 rows.append(dict(mode=mode,returncode=r.returncode,expected=expected,output=r.stdout+r.stderr))
 assert r.returncode==expected,rows[-1]
if os.environ.get('KANDELO_WAYLAND_RAW_RESULTS'):
 pathlib.Path(os.environ['KANDELO_WAYLAND_RAW_RESULTS']).write_text(json.dumps(rows,indent=2)+'\n')
PYTHON
