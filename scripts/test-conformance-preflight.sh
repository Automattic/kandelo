#!/usr/bin/env bash
# Exercise the real wrappers in disposable checkouts with stubbed build and
# runtime commands. No compiler, package cache, guest or browser is needed.
set -euo pipefail

SOURCE_ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

check_runner() {
    local suite="$1" missing="$2" runner="$3"
    shift 3
    local root="$tmpdir/repo" log="$tmpdir/output" rc=0 expected remedy source
    rm -rf "$root"
    mkdir -p "$root"/{scripts,bin,sdk/bin,examples,sysroot/lib,local-binaries,host/wasm}
    for source in "$SOURCE_ROOT"/scripts/{run-*tests.sh,ci-run-test-suite.sh,browser-runner-accounting.sh,sortix-*.sh,xfail-reasons.sh,check-vitest-evidence-classes.sh,activate-ci-test-workspace.sh,conformance-*.sh}; do
        cp "$source" "$root/scripts/"
    done
    mkdir -p "$root/tests/libc/libc-test/src/"{common,functional,regression,math}
    touch "$root/tests/libc/libc-test/src/common/"{test.h,print.c,rand.c,path.c,setrlim.c,fdfill.c,memfill.c,vmfill.c,mtest.c}
    touch "$root/tests/libc/libc-test/src/functional/snprintf.c"
    touch "$root/tests/libc/libc-test/src/regression/fixture.c"
    touch "$root/tests/libc/libc-test/src/math/fixture.c"
    mkdir -p "$root/tests/posix/open-posix-testsuite/conformance/interfaces/sigpending"
    touch "$root/tests/posix/open-posix-testsuite/conformance/interfaces/sigpending/1-1.c"
    mkdir -p "$root/tests/posix/open-posix-testsuite/include"
    touch "$root/tests/posix/open-posix-testsuite/include/posixtest.h"
    mkdir -p "$root/tests/sortix/os-test/"{include,malloc}
    touch "$root/tests/sortix/os-test/"{Makefile,include/fixture.c,malloc/malloc-0.c}
    mkdir -p "$root/tests/sortix/os-test-local/malloc"
    touch "$root/tests/sortix/os-test-local/malloc/local.c"
    touch "$root/sysroot/lib/libc.a" "$root/local-binaries/kandelo_image_module32.wasm"
    touch "$root/host/wasm/"{kernel.wasm,rootfs.vfs.zst}
    touch "$root/examples/echo.c"
    mkdir -p "$root/target/fixture/release" "$root/sysroot64/lib"
    touch "$root/sysroot64/lib/libc.a"
    printf '#!/bin/sh\nexit 0\n' > "$root/target/fixture/release/xtask"
    chmod +x "$root/target/fixture/release/xtask"

    cat > "$root/scripts/resolve-binary.sh" <<'SH'
#!/usr/bin/env bash
case "$1" in
    --check-candidates) shift; location="host/wasm/${1##*/}" ;;
    --browser-rootfs) location="host/wasm/rootfs.vfs.zst" ;;
    *) location="host/wasm/$1" ;;
esac
root="$(cd "$(dirname "$0")/.." && pwd)"
if [[ "$location" == *rootfs.vfs.zst || "$location" == *kernel.wasm || "$location" == *ruby.wasm || "$location" == *exec-child.wasm ]]; then
    [ -f "$root/$location" ] || exit 1
fi
printf '%s\n' "$root/$location"
SH
    cat > "$root/scripts/abi-contract-stamp.sh" <<'SH'
abi_contract_stamp_prepare() {
    printf 'abi preparation\n' >> "$WORK_LOG"
    export KANDELO_ABI_STAMP_XTASK="$PWD/target/fixture/release/xtask"
}
abi_contract_stamp() { :; }
export -f abi_contract_stamp
SH
    cat > "$root/bin/rustc" <<'SH'
#!/usr/bin/env bash
echo 'host: fixture'
SH
    cat > "$root/bin/cargo" <<'SH'
#!/usr/bin/env bash
printf 'cargo %s\n' "$*" >> "$WORK_LOG"
mkdir -p target/fixture/release
printf '#!/bin/sh\nexit 0\n' > target/fixture/release/xtask
chmod +x target/fixture/release/xtask
SH
    cat > "$root/sdk/bin/wasm32posix-cc" <<'SH'
#!/usr/bin/env bash
printf 'compiler %s\n' "$*" >> "$WORK_LOG"
while [ "$#" -gt 1 ]; do
    case "$1" in
        *.c) [ -f "$1" ] || { echo "missing source $1" >&2; exit 1; } ;;
        -o) touch "$2"; exit ;;
    esac
    shift
done
exit 1
SH
    for command in npm node npx; do
        cat > "$root/bin/$command" <<'SH'
#!/usr/bin/env bash
printf '%s %s\n' "${0##*/}" "$*" >> "$WORK_LOG"
case "${0##*/}" in
    npm) exit 0 ;;
    node)
        case "$*" in *check-conformance-rootfs.ts*) exit 0 ;; esac
        if [ "$FIXTURE_CASE" = late-rootfs ]; then
            rm -f host/wasm/rootfs.vfs.zst
            if [ -n "${KANDELO_RUNNER_SETUP_ERROR_FILE:-}" ]; then
                echo 'Missing rootfs.vfs.zst. Run scripts/dev-shell.sh bash scripts/build-rootfs.sh.' > "$KANDELO_RUNNER_SETUP_ERROR_FILE"
            fi
        fi
        if [ ! -f host/wasm/rootfs.vfs.zst ]; then
            echo 'Binary not found: rootfs.vfs.zst' >&2
            exit 1
        fi
        ;;
    npx)
        if [ "$FIXTURE_CASE" = late-rootfs ]; then
            rm -f host/wasm/rootfs.vfs.zst
            echo 'SETUP ERROR: missing rootfs.vfs.zst. Run scripts/dev-shell.sh bash scripts/build-rootfs.sh.' >&2
            exit 2
        fi
        if [ ! -f host/wasm/rootfs.vfs.zst ]; then
            echo 'Error: missing rootfs.vfs.zst' >&2
            exit 1
        fi
        for arg in "$@"; do
            if [[ "$arg" == *.wasm ]]; then
                echo '{"exitCode":0,"durationMs":1}'
            fi
        done
        ;;
esac
SH
    done
    cat > "$root/scripts/run-wasm-fork-instrument.sh" <<'SH'
#!/bin/sh
[ -f "$1" ] || exit 1
if [ "$1" != "$3" ]; then cp "$1" "$3"; fi
SH
    chmod +x "$root/bin/"* "$root/sdk/bin/"* "$root/scripts/"*.sh

    case "$missing" in
        rootfs)
            rm "$root/host/wasm/rootfs.vfs.zst"
            expected='rootfs.vfs.zst'
            remedy='scripts/build-rootfs.sh'
            ;;
        kernel)
            rm "$root/host/wasm/kernel.wasm"
            expected='kernel.wasm'
            remedy='./run.sh setup'
            ;;
        sysroot)
            rm "$root/sysroot/lib/libc.a"
            expected='sysroot/lib/libc.a'
            remedy='./run.sh setup'
            ;;
        late-rootfs) ;;
        ruby|exec-child)
            expected="$missing.wasm"
            if [ "$missing" = ruby ]; then
                touch "$root/host/wasm/exec-child.wasm"
                remedy='./run.sh setup --all'
            else
                touch "$root/host/wasm/ruby.wasm"
                remedy='scripts/build-programs.sh'
            fi
            ;;
        sources)
            case "$suite" in
                libc) expected='tests/libc/libc-test'; remedy="git submodule update --init $expected" ;;
                sortix) expected='tests/sortix/os-test'; remedy="git submodule update --init $expected" ;;
                posix)
                    expected='tests/posix/open-posix-testsuite'
                    remedy="git restore -- $expected"
                    ;;
            esac
            rm -rf "$root/$expected"
            mkdir -p "$root/$expected" # an uninitialized gitlink is an empty directory
            ;;
    esac

    : > "$tmpdir/work"
    PATH="$root/bin:$PATH" WORK_LOG="$tmpdir/work" FIXTURE_CASE="$missing" \
        timeout 10s bash "$root/scripts/$runner" "$@" > "$log" 2>&1 || rc=$?
    if [ "$missing" = late-rootfs ]; then
        if [ "$rc" -ne 0 ] && grep -Eq '^SETUP ERROR .*[/]' "$log" &&
            grep -Eq '^SETUP: +[1-9][0-9]*$' "$log" &&
            grep -Eq '^FAIL: +0$' "$log" && grep -Eq '^PASS: +0$' "$log"; then
            echo "PASS ($runner $* / $missing, exit $rc)"
            grep -E '^(SETUP ERROR|SETUP:)' "$log"
            return 0
        fi
        echo "FAIL ($runner $* / $missing, exit $rc)" >&2
        cat "$log" >&2
        return 1
    fi
    if [ "$rc" -eq 0 ] || ! grep -F 'SETUP ERROR' "$log" | grep -Fq "$expected" ||
        ! grep -Fq "$remedy" "$log" || [ -s "$tmpdir/work" ] ||
        grep -Eq '^(PASS|FAIL|BUILD|XFAIL|XPASS|TIMEOUT|TOTAL)([[:space:]]|:)' "$log"; then
        echo "FAIL ($runner $* / $missing, exit $rc)" >&2
        cat "$log" >&2
        sed 's/^/  invoked: /' "$tmpdir/work" >&2
        return 1
    fi
    echo "PASS ($runner $* / $missing, exit $rc)"
    grep -F 'SETUP ERROR' "$log"
}

failed=0
for missing in rootfs sources kernel sysroot late-rootfs; do
    for suite in libc posix sortix; do
        case "$suite" in
            libc) args=(functional snprintf) ;;
            posix) args=(sigpending) ;;
            sortix) args=(malloc) ;;
        esac
        check_runner "$suite" "$missing" "run-$suite-tests.sh" "${args[@]}" || failed=1
        check_runner "$suite" "$missing" "run-browser-$suite-tests.sh" "${args[0]}" || failed=1
        if [ "$missing" != late-rootfs ]; then
            check_runner "$suite" "$missing" ci-run-test-suite.sh "$suite" || failed=1
        fi
    done
done
check_runner vitest rootfs ci-run-test-suite.sh vitest || failed=1
check_runner browser rootfs ci-run-test-suite.sh browser || failed=1
check_runner vitest ruby ci-run-test-suite.sh vitest resource-isolated || failed=1
check_runner vitest exec-child ci-run-test-suite.sh vitest resource-isolated || failed=1
exit "$failed"
