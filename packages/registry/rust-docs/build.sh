#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
source "$repo/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$here" wasm32
work="$KANDELO_PACKAGE_WORK_DIR"
stage="$work/stage"
# Both tools must match the guest packages. Reading a system installation's
# unrelated pages would silently publish documentation for another release.
test "$(rustc -vV | sed -n 's/^commit-hash: //p')" = ca9a134e0985765ded9cfdde4030a5df4db7e2bd
test "$(cargo -vV | sed -n 's/^commit-hash: //p')" = eb9b60f1f6604b5e022c56be31692c215b8ba11d
python3 - "$(rustc --print sysroot)/share/man/man1" "$stage/share/man/man1" <<'PY'
import gzip, sys
from pathlib import Path
source, output = map(Path, sys.argv[1:])
pages = sorted(source.glob('*.1.gz'))
names = {page.name.removesuffix('.gz') for page in pages}
if not {'rustc.1', 'rustdoc.1', 'cargo.1', 'cargo-test.1', 'cargo-build.1'} <= names:
    raise SystemExit('pinned toolchain lacks the upstream Rust/Cargo man pages')
if len(pages) > 128:
    raise SystemExit('unexpected pinned manual-page inventory')
output.mkdir(parents=True)
for page in pages:
    if not (page.name.startswith('cargo') or page.name in ('rustc.1.gz', 'rustdoc.1.gz')):
        raise SystemExit(f'unexpected manual page in pinned Rust component: {page.name}')
    content = gzip.decompress(page.read_bytes())
    if not content or len(content) > 2 * 1024 * 1024:
        raise SystemExit(f'invalid manual-page size: {page.name}')
    (output / page.name.removesuffix('.gz')).write_bytes(content)
print(f'Packaged {len(pages)} matching upstream manual pages')
PY
mkdir -p "$stage/share/licenses/rust-docs"
cp "$repo/sdk/guest-rust/licenses/"* "$stage/share/licenses/rust-docs/"
bash "$repo/images/vfs/scripts/create-deterministic-zip.sh" "$stage" "$work/rust-docs.zip"
export WASM_POSIX_INSTALL_LOCAL_MIRROR=0 WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled
source "$repo/scripts/install-local-binary.sh"
install_local_binary rust-docs "$work/rust-docs.zip" rust-docs.zip
