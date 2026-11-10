#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$root/.scratch"
out="$(mktemp -d "$root/.scratch/wayland-logs.XXXXXX")"
trap 'rm -rf "$out"' EXIT
archive="${1:?provide resolver-owned pinned source archive}"
shift
leaf_source="${KANDELO_WAYLAND_LEAF_SOURCE:-$root/libc/glue/wayland-client-retirement.inc}"
python3 - "$root/packages/registry/libwayland/package.toml" "$archive" "$out" <<'PY'
import hashlib,pathlib,sys,tarfile,tomllib
m=tomllib.loads(pathlib.Path(sys.argv[1]).read_text());p=pathlib.Path(sys.argv[2])
assert p.is_file() and not p.is_symlink() and hashlib.sha256(p.read_bytes()).hexdigest()==m['source']['sha256']
with tarfile.open(p) as archive:archive.extractall(sys.argv[3],filter='data')
PY
src="$out/wayland-1.24.0"
mkdir -p "$out/include"
printf '#define PACKAGE_VERSION "1.24.0"\n' > "$src/config.h"
wayland-scanner client-header "$src/protocol/wayland.xml" "$out/include/wayland-client-protocol.h"
wayland-scanner server-header "$src/protocol/wayland.xml" "$out/include/wayland-server-protocol.h"
wayland-scanner public-code "$src/protocol/wayland.xml" "$out/protocol.c"
sed -e 's/@WAYLAND_VERSION_MAJOR@/1/g' -e 's/@WAYLAND_VERSION_MINOR@/24/g' \
 -e 's/@WAYLAND_VERSION_MICRO@/0/g' -e 's/@WAYLAND_VERSION@/1.24.0/g' \
 "$src/src/wayland-version.h.in" > "$out/include/wayland-version.h"
# Full server TU requires Linux eventfd on this native host. Compile its exact
# unchanged public setter definition; unrelated server I/O is outside scope.
python3 - "$src/src/wayland-server.c" "$out/server-setter.c" <<'PYSETTER'
import pathlib,sys
s=pathlib.Path(sys.argv[1]).read_text();start=s.index('WL_EXPORT void\nwl_log_set_handler_server(');end=s.index('\n}',start)+2
body=s[start:end]
assert body=='WL_EXPORT void\nwl_log_set_handler_server(wl_log_func_t handler)\n{\n\twl_log_handler = handler;\n}'
pathlib.Path(sys.argv[2]).write_text('#include "wayland-private.h"\n'+body+'\n')
PYSETTER
read -r -a ffi_flags <<< "$(pkg-config --cflags --libs libffi)"
link_gc='-Wl,--gc-sections';if [ "$(uname -s)" = Darwin ];then link_gc='-Wl,-dead_strip';fi
clang -g -O1 -pthread -std=gnu11 -fsanitize=undefined -fno-sanitize-recover=all \
 -include "$root/tests/graphics/libc/wayland-native-allocation-double.h" \
 -DKANDELO_WAYLAND_NATIVE_EPOCH_DOUBLE -fno-omit-frame-pointer -ffunction-sections -fdata-sections -DHAVE_CONFIG_H \
 "-DWPK_WAYLAND_CLIENT_SOURCE=\"$src/src/wayland-client.c\"" \
 "-DWPK_WAYLAND_LEAF_SOURCE=\"$leaf_source\"" \
 "-DWPK_WAYLAND_UTIL_SOURCE=\"$src/src/wayland-util.c\"" \
 -I"$out/include" -I"$src/src" -I"$src" -I"$root/libc/glue" \
 "$root/tests/graphics/libc/wayland-log-retirement.c" "$root/tests/graphics/libc/wayland-log-util.c" \
 "$src/src/connection.c" "$out/server-setter.c" "$out/protocol.c" \
 "$root/tests/graphics/libc/wayland-raw-inactive.c" \
 "${ffi_flags[@]}" "$link_gc" -o "$out/control"
python3 - "$out/control" "$@" <<'PY'
import json,os,pathlib,signal,subprocess,sys
rows=[]
for mode in (sys.argv[2:] or ['defer-fifo','resolver','plain','nested','nested-capture','defer','defer-live-peer','defer-origin-exit','defer-callback-exit','self-fork','exit','cancel','handler-identity','foreign-seal','proxy-plain','proxy-local','proxy-error','proxy-exit','oom','fatal']):
 r=subprocess.run([sys.argv[1],mode],capture_output=True,text=True,timeout=20)
 output=r.stdout+r.stderr;print(output,end='',flush=True)
 expected=-signal.SIGABRT if mode in ['oom','fatal'] else 0
 if mode=='oom':assert 'durable teardown log capture failed' in output
 if mode=='fatal':assert 'IMMEDIATE FATAL: fatal capture 3' in output
 rows.append({'control':mode,'returncode':r.returncode,'expected':expected,'output':output})
 if os.environ.get('KANDELO_WAYLAND_LOG_EXPECT_FAILURE')=='1':assert r.returncode!=0,rows[-1]
 else:assert r.returncode==expected,rows[-1]
if os.environ.get('KANDELO_WAYLAND_LOG_RESULTS'):
 pathlib.Path(os.environ['KANDELO_WAYLAND_LOG_RESULTS']).write_text(json.dumps(rows,indent=2)+'\n')
PY
