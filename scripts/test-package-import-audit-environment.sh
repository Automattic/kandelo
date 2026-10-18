#!/usr/bin/env bash
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT
mkdir "$test_root/bin"
cat > "$test_root/bin/rustc" <<'SH'
#!/usr/bin/env bash
printf 'host: fixture-host\n'
SH
cat > "$test_root/bin/cargo" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
for variable in CC CXX AR RANLIB AS LD NM ARFLAGS CFLAGS CXXFLAGS CPPFLAGS LDFLAGS \
    TARGET_CC TARGET_CXX TARGET_AR TARGET_CFLAGS TARGET_CXXFLAGS \
    RUSTFLAGS CARGO_ENCODED_RUSTFLAGS; do
    if printenv "$variable" >/dev/null; then
        echo "cross environment leaked into native audit: $variable" >&2
        exit 1
    fi
done
[ "$CARGO_TARGET_DIR" = "$KANDELO_AUDIT_FIXTURE_ROOT/target" ]
[ "$WASM_POSIX_DEP_WORK_DIR" = "$KANDELO_AUDIT_FIXTURE_ROOT/work" ]
[ "$*" = 'run -p xtask --target fixture-host --quiet -- check-package-imports --require-startup fixture.wasm' ]
printf 'native boundary accepted\n' > "$KANDELO_AUDIT_FIXTURE_ROOT/marker"
SH
chmod 0755 "$test_root/bin/rustc" "$test_root/bin/cargo"
env PATH="$test_root/bin:$PATH" KANDELO_AUDIT_FIXTURE_ROOT="$test_root" \
    CARGO_TARGET_DIR="$test_root/target" WASM_POSIX_DEP_WORK_DIR="$test_root/work" \
    CC=wasm32posix-cc CXX=wasm32posix-c++ AR=wasm32posix-ar RANLIB=wasm32posix-ranlib \
    AS=cross-as LD=cross-ld NM=cross-nm ARFLAGS=cross-ar-flags \
    CFLAGS=-matomics CXXFLAGS=-matomics CPPFLAGS=-matomics LDFLAGS=-matomics \
    TARGET_CC=wasm32posix-cc TARGET_CXX=wasm32posix-c++ TARGET_AR=wasm32posix-ar \
    TARGET_CFLAGS=-matomics TARGET_CXXFLAGS=-matomics \
    RUSTFLAGS=cross-rust-flags CARGO_ENCODED_RUSTFLAGS=cross-rust-flags \
    bash "$REPO_ROOT/scripts/check-package-imports.sh" --require-startup fixture.wasm
[ -f "$test_root/marker" ]
echo 'test-package-import-audit-environment: ok'
