#!/usr/bin/env bash
# Run inside scripts/dev-shell.sh; no target SDK or products are used.
set -euo pipefail
: "${KANDELO_DEV_SHELL_TOOL_PATH:?run through scripts/dev-shell.sh}"
test_root="$(cd "$(dirname "$0")" && pwd)"
package_root="$(cd "$test_root/.." && pwd)"
archive="${1:?provide the verified sfwbar source archive}"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/sfwbar-window-lifecycle.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT

python3 - "$package_root/package.toml" "$archive" "$scratch" <<'PY'
import hashlib,pathlib,shutil,sys,tarfile,tomllib
manifest=tomllib.loads(pathlib.Path(sys.argv[1]).read_text())
archive=pathlib.Path(sys.argv[2])
assert archive.is_file() and not archive.is_symlink(), 'regular source archive required'
assert hashlib.sha256(archive.read_bytes()).hexdigest()==manifest['source']['sha256'], 'source checksum mismatch'
root=pathlib.Path(sys.argv[3])
with tarfile.open(archive) as payload:payload.extractall(root/'unpack',filter='data')
source=root/'unpack'/(manifest['name']+'-'+manifest['version'])
shutil.move(source,root/'before')
shutil.copytree(root/'before',root/'after')
# A partial control proves that fixing only the datum still leaves signal and
# live-list ownership defects. Compile the actual remaining production file.
shutil.copytree(root/'before',root/'data-only')
p=root/'data-only/src/window.c';s=p.read_text()
a=s.index('void window_ref_free');b=s.index('\nvoid window_ref (',a)
s=s[:a]+'''static void window_ref_free(gpointer data) {
  GList **refs=data;
  g_list_free(*refs);
  g_free(refs);
}
'''+s[b:]
s=s.replace('(GDestroyNotify)window_ref_free','window_ref_free')
p.write_text(s)
PY
for change in "$package_root"/patches/*.patch; do
    patch --fuzz=0 -p1 -d "$scratch/after" < "$change"
done
pkg-config --modversion gobject-2.0
read -r -a cflags <<< "$(pkg-config --cflags gobject-2.0)"
read -r -a libs <<< "$(pkg-config --libs gobject-2.0)"
for variant in before data-only after; do
    clang -g -O1 -fno-omit-frame-pointer -fsanitize=undefined \
        -fno-sanitize-recover=all -DLIFECYCLE_BOUNDARY_CHECK \
        -I"$test_root/include" -I"$scratch/$variant/src" "${cflags[@]}" \
        "$scratch/$variant/src/window.c" "$test_root/window-lifecycle.c" \
        "${libs[@]}" -o "$scratch/$variant/fixture"
done
python3 "$test_root/run-window-lifecycle.py" "$scratch" \
    "${2:-${KANDELO_SFWBAR_LIFECYCLE_LOG_DIR:-$scratch/results}}"
