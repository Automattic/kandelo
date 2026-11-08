#!/usr/bin/env bash
# Run inside scripts/dev-shell.sh after preparing the Rust package projection.
# SDK inputs are explicit so this lane cannot silently select an older bundle.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
mode="${1:-}"
sdk="${2:-}"
native="${3:-}"
case "$mode" in node|browser) ;; *) echo "usage: $0 <node|browser> SDK.zip NATIVE-FIXTURES.zip" >&2; exit 2 ;; esac
for artifact in "$sdk" "$native"; do
    if [ ! -f "$artifact" ]; then
        echo "Rust development checks require an existing artifact: $artifact" >&2
        exit 1
    fi
done
# Resolve paths before changing into test directories.
sdk="$(cd "$(dirname "$sdk")" && pwd)/$(basename "$sdk")"
native="$(cd "$(dirname "$native")" && pwd)/$(basename "$native")"
export KANDELO_GUEST_RUST_SDK_BUNDLE="$sdk"
export KANDELO_GUEST_RUST_NATIVE_FIXTURES="$native"
export KANDELO_REQUIRE_GUEST_CARGO=1 KANDELO_REQUIRE_GUEST_RUSTC=1
export WASM_POSIX_RESOLUTION_POLICY=source-only-v1
export WASM_POSIX_SOURCE_ONLY_BINARY_ROOT="${WASM_POSIX_SOURCE_ONLY_BINARY_ROOT:-$repo/local-binaries/source-only-v1}"
export KANDELO_TEST_REPORT_DIR="${KANDELO_TEST_REPORT_DIR:-$repo/.context/rust-development-reports}"
python3 - "$sdk" "$native" "$KANDELO_TEST_REPORT_DIR" <<'PY'
import hashlib, json, sys, zipfile
from pathlib import Path
sdk, native, output = map(Path, sys.argv[1:])
required = {
    'bin/cargo', 'bin/rustfmt', 'bin/cargo-fmt', 'bin/cargo-clippy',
    'bin/llvm-cov', 'bin/llvm-profdata', 'libexec/rustc', 'libexec/rustdoc',
    'libexec/clippy-driver',
    'lib/rustlib/wasm32-unknown-kandelo-std/lib/libprofiler_builtins.rlib',
}
with zipfile.ZipFile(sdk) as archive:
    names = set(archive.namelist())
    missing = sorted(required - names)
    if missing:
        raise SystemExit('Rust development SDK is incomplete: ' + ', '.join(missing))
    if not any(name.startswith('lib/rustlib/wasm32-unknown-kandelo-std/lib/libtest-')
               and name.endswith('.rlib') for name in names):
        raise SystemExit('Rust development SDK lacks matching libtest')
output.mkdir(parents=True, exist_ok=True)
identity = {name: {'path': str(path), 'bytes': path.stat().st_size,
                   'sha256': hashlib.file_digest(path.open('rb'), 'sha256').hexdigest()}
            for name, path in [('sdk', sdk), ('native_fixtures', native)]}
(output / 'inputs.json').write_text(json.dumps(identity, indent=2) + '\n')
PY
case "$mode" in
    node)
        cd "$repo/host"
        bash "$repo/scripts/record-test-report.sh" vitest npx vitest run --maxWorkers=1 \
            test/rustc-in-guest.test.ts \
            test/cargo-in-guest.test.ts \
            test/rust-devtools-in-guest.test.ts \
            test/rust-compatibility-in-guest.test.ts \
            test/rust-native-dependencies-in-guest.test.ts \
            test/rust-backtrace.test.ts \
            test/rust-debugger.test.ts \
            test/rust-coverage-in-guest.test.ts
        ;;
    browser)
        cd "$repo/apps/browser-demos"
        bash "$repo/scripts/record-test-report.sh" playwright npx playwright test --workers=1 \
            test/rustc-in-guest.spec.ts \
            test/cargo-in-guest.spec.ts \
            test/rust-devtools-in-guest.spec.ts \
            test/rust-compatibility-in-guest.spec.ts \
            test/rust-native-dependencies-in-guest.spec.ts \
            test/rust-backtrace.spec.ts \
            test/rust-coverage-in-guest.spec.ts \
            --project=chromium --project=firefox --project=webkit
        # The interactive browser command is specifically a Chromium CDP
        # capability. Select its supported project rather than recording six
        # expected skips in the Firefox/WebKit matrix.
        bash "$repo/scripts/record-test-report.sh" playwright npx playwright test \
            test/rust-debugger-command.spec.ts --project=chromium --workers=1
        ;;
esac
