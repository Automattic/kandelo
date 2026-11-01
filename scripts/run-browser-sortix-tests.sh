#!/bin/bash
set -euo pipefail

# Build and run Sortix os-test conformance tests in a headless browser.
#
# Include tests are compile-only (same as Node.js version).
# Runtime tests are built to wasm and executed via Playwright + BrowserKernel.
#
# Usage:
#   scripts/run-browser-sortix-tests.sh                       # run default suites
#   scripts/run-browser-sortix-tests.sh include               # run one suite
#   scripts/run-browser-sortix-tests.sh basic stdio            # run specific suites
#   scripts/run-browser-sortix-tests.sh --all                 # run all suites

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# WHY: the SDK driver finds its sysroot and glue dir by walking up from the
# current directory (find_project_root in crates/kandelo-cc/src/toolchain.rs), not from
# this script's location. Run from inside another Kandelo checkout, it would
# compile against THAT checkout's sysroot while the prerequisite check below
# validated this one. Pin the cwd so both agree. (The browser runner below
# also needs this cwd; it used to set it just before the npx call.)
cd "$REPO_ROOT"
SYSROOT="$REPO_ROOT/sysroot"
OS_TEST="$REPO_ROOT/tests/sortix/os-test"
OS_TEST_LOCAL="$REPO_ROOT/tests/sortix/os-test-local"
# Upstream tests that do not test a POSIX requirement on Kandelo are
# reported as SKIP; see scripts/sortix-not-applicable.sh.
source "$REPO_ROOT/scripts/sortix-not-applicable.sh"
# shellcheck source=scripts/browser-runner-accounting.sh
source "$REPO_ROOT/scripts/browser-runner-accounting.sh"
BUILD_DIR="$REPO_ROOT/tests/sortix/os-test/build"
KERNEL_WASM="$("$REPO_ROOT/scripts/resolve-binary.sh" kernel.wasm)"

# Expected failures, their recorded reasons, and how expected output is
# found and compared are shared with the Node.js runner: both boot the same
# kernel and libc, so a test's expected outcome belongs to Kandelo, not to
# the host.
# shellcheck source=scripts/sortix-expectations.sh
source "$REPO_ROOT/scripts/sortix-expectations.sh"
# shellcheck source=scripts/xfail-reasons.sh
source "$REPO_ROOT/scripts/xfail-reasons.sh"

# ── Browser-specific expected failures ──────────────────────────────
# Tests that pass on Node.js but fail in the browser because of a real
# difference between the hosts. Each needs a reason in
# browser_xfail_expected_reason, like the shared entries.

BROWSER_BASIC_EXPECTED_FAIL=()

BROWSER_INCLUDE_EXPECTED_FAIL=()
BROWSER_LIMITS_EXPECTED_FAIL=()
BROWSER_MALLOC_EXPECTED_FAIL=()
BROWSER_STDIO_EXPECTED_FAIL=()
BROWSER_IO_EXPECTED_FAIL=()

BROWSER_SIGNAL_EXPECTED_FAIL=()

BROWSER_PROCESS_EXPECTED_FAIL=()
BROWSER_PATHS_EXPECTED_FAIL=()
BROWSER_UDP_EXPECTED_FAIL=()

# How each browser-specific XFAIL is expected to fail (see
# xfail_expected_reason in scripts/sortix-expectations.sh). Shared entries
# fall through to the shared table.
browser_xfail_expected_reason() {
    case "$1" in
        *) xfail_expected_reason "$1" ;;
    esac
}

# A mismatched XFAIL counts as a FAIL: the test is failing for a reason
# nobody has accepted, and the run must not read as clean.
record_xfail_mismatch() {
    local id="$1" output="$2"
    echo "XFAIL-MISMATCH ${id} (${XFAIL_MISMATCH})"
    printf '%s\n' "$output" | tail -10 | head -5 | sed 's/^/  /'
    RESULTS+=("FAIL  ${id}")
    FAIL=$((FAIL + 1))
}

# ── Helpers ──────────────────────────────────────────────────────

is_expected_fail() {
    local test_name="$1"
    shift
    local list=("$@")
    for pattern in "${list[@]}"; do
        [ "$pattern" = "$test_name" ] && return 0
        if [[ "$pattern" == *"*"* ]]; then
            case "$test_name" in
                $pattern) return 0 ;;
            esac
        fi
    done
    return 1
}

find_llvm_bin() {
    if [ -n "${LLVM_BIN:-}" ] && [ -x "$LLVM_BIN/clang" ]; then
        echo "$LLVM_BIN"
        return
    fi
    if [ -n "${LLVM_PREFIX:-}" ] && [ -x "$LLVM_PREFIX/bin/clang" ]; then
        echo "$LLVM_PREFIX/bin"
        return
    fi
    if command -v clang >/dev/null 2>&1; then
        dirname "$(command -v clang)"
        return
    fi
    echo "Error: LLVM/clang not found. Run scripts/dev-shell.sh or set LLVM_BIN/LLVM_PREFIX." >&2
    exit 1
}

LLVM_BIN="$(find_llvm_bin)"

# ── Toolchain: the SDK owns the target/link contract ──
#
# Identical to scripts/run-sortix-tests.sh, the Node.js runner for this same
# suite. Conformance binaries must be built the way user software is built.
# `crates/kandelo-cc/src/flags.rs` is the single authority for the wasm32posix target
# triple, the guest syscall glue, crt1/libc ordering, the pinned wasm-ld, the
# host-imports allowance file that bounds what may stay undefined, and the
# process memory layout (8 MiB main-thread shadow stack, `--global-base`,
# `__heap_base` export). This runner used to hand-maintain a
# copy of that contract which had drifted (no `__heap_base` export, no
# `--global-base`), so the browser suite measured a memory layout no real
# Kandelo program runs under. See docs/sdk-guide.md.
#
# Deliberately NOT named CC. That name is already exported in the dev shell,
# and bash keeps the export attribute when you assign to an exported name, so
# `CC=.../wasm32posix-cc` would reach every child process this script starts,
# including any `cargo build -p xtask`, whose cc-rs build scripts would then
# compile host objects with a wasm cross-compiler. The parallel include
# build below needs the compiler across a `bash -c` boundary, so it is
# exported under this safe name instead.
WASM32_CC="$REPO_ROOT/sdk/bin/wasm32posix-cc"

# Only test-specific flags belong here. The SDK supplies the target,
# sysroot, `-nostdlib`, atomics/bulk-memory/exception-handling, the SjLj
# and wasm-EH lowering choices, and `-fno-trapping-math`.
CFLAGS_BASE=(
    -O2
    -D__sortix__
)

# The SDK driver contributes the whole executable link line: syscall
# glue, compiler-rt shims, crt1.o, libc.a, and every `-Wl,` flag. `-ldl`
# is how the SDK spells the `libc/glue/dlopen.c` input this list used to
# name directly (parse_args/link_dl in crates/kandelo-cc/src/driver.rs); the suite's
# dlfcn tests need it.
LINK_FLAGS=(
    -ldl
)

FORK_INSTRUMENT="$REPO_ROOT/scripts/run-wasm-fork-instrument.sh"

# Stamp each compiled test program with this checkout's ABI-contract digest.
source "$REPO_ROOT/scripts/abi-contract-stamp.sh"

instrument_wasm() {
    local wasm="$1"
    "$FORK_INSTRUMENT" "$wasm" -o "$wasm.instr"
    mv "$wasm.instr" "$wasm"
    abi_contract_stamp "$wasm"
}

TEST_TIMEOUT=30000  # ms (for browser runner)

# ── Test discovery ─────────────────────────────────────────────

discover_include() {
    find "$OS_TEST/include" -name "*.c" -type f | sort | while read -r f; do
        local rel="${f#$OS_TEST/include/}"
        echo "${rel%.c}"
    done
}

discover_runtime_suite() {
    local suite="$1"
    for root in "$OS_TEST" "$OS_TEST_LOCAL"; do
        [ -d "$root/$suite" ] || continue
        find "$root/$suite" -name "*.c" -type f | while read -r f; do
            local rel="${f#$root/$suite/}"
            echo "${rel%.c}"
        done
    done | sort -u
}

runtime_test_src() {
    local suite="$1"
    local test_name="$2"
    local local_src="$OS_TEST_LOCAL/$suite/${test_name}.c"
    if [ -f "$local_src" ]; then
        echo "$local_src"
        return
    fi
    echo "$OS_TEST/$suite/${test_name}.c"
}

discover_basic() {
    discover_runtime_suite basic
}

discover_limits() {
    discover_runtime_suite limits
}

discover_suite() {
    local suite="$1"
    discover_runtime_suite "$suite"
}

discover_malloc()  { discover_suite malloc; }
discover_stdio()   { discover_suite stdio; }
discover_io()      { discover_suite io; }
discover_signal()  { discover_suite signal; }
discover_process() { discover_suite process; }
discover_paths()   { discover_suite paths; }
discover_udp()     { discover_suite udp; }

# ── Build helpers ──────────────────────────────────────────────

build_include_one() {
    local test_name="$1"
    local src="$OS_TEST/include/${test_name}.c"
    local wasm="$BUILD_DIR/include/${test_name}.wasm"
    local result_file="$BUILD_DIR/include/${test_name}.result"
    mkdir -p "$(dirname "$wasm")"

    local -a cflags=("${CFLAGS_BASE[@]}" -Wall -Wextra -Werror
        -Wno-error=deprecated -Wno-error=deprecated-declarations
        -I"$OS_TEST")

    if "$WASM32_CC" "${cflags[@]}" -D_POSIX_C_SOURCE=202405L \
        "$src" "${LINK_FLAGS[@]}" -o "$wasm" 2>/dev/null; then
        echo "good" > "$result_file"; rm -f "$wasm"; return
    fi
    if "$WASM32_CC" "${cflags[@]}" -D_POSIX_C_SOURCE=200809L \
        "$src" "${LINK_FLAGS[@]}" -o "$wasm" 2>/dev/null; then
        echo "previous_posix" > "$result_file"; rm -f "$wasm"; return
    fi
    if "$WASM32_CC" "${cflags[@]}" -D_GNU_SOURCE -D_BSD_SOURCE -D_ALL_SOURCE -D_DEFAULT_SOURCE \
        "$src" "${LINK_FLAGS[@]}" -o "$wasm" 2>/dev/null; then
        echo "extension" > "$result_file"; rm -f "$wasm"; return
    fi

    local err_file="$BUILD_DIR/include/${test_name}.err"
    "$WASM32_CC" "${cflags[@]}" -D_POSIX_C_SOURCE=202405L \
        "$src" "${LINK_FLAGS[@]}" -o "$wasm" 2>"$err_file" || true

    if grep -q '/\*optional\*/' "$src" 2>/dev/null; then
        echo "missing_optional" > "$result_file"
    elif grep -Eq 'fatal error' "$err_file"; then
        echo "missing_header" > "$result_file"
    elif grep -Eq 'incompatible|pointer-sign' "$err_file"; then
        echo "incompatible" > "$result_file"
    elif grep -Eq 'undeclared|no member named|is not defined' "$err_file"; then
        echo "undeclared" > "$result_file"
    elif grep -Eq 'unknown type name|storage size of|expected declaration specifiers' "$err_file"; then
        echo "unknown_type" > "$result_file"
    elif grep -Eq 'undefined symbol' "$err_file"; then
        echo "undefined" > "$result_file"
    else
        echo "compile_error" > "$result_file"
    fi
    rm -f "$wasm"
}

build_runtime_test() {
    local suite="$1"
    local test_name="$2"
    local src
    src="$(runtime_test_src "$suite" "$test_name")"
    local wasm="$BUILD_DIR/$suite/${test_name}.wasm"
    mkdir -p "$(dirname "$wasm")"
    rm -f "$wasm"

    local -a cflags=("${CFLAGS_BASE[@]}" -D_GNU_SOURCE -I"$OS_TEST")

    "$WASM32_CC" "${cflags[@]}" \
        "$src" "${LINK_FLAGS[@]}" \
        -o "$wasm" 2>/dev/null || return 1
    instrument_wasm "$wasm"
}

# ── Include suite (compile-only, no browser needed) ──────────────

run_include_suite() {
    local -a tests=()
    while IFS= read -r t; do
        [ -n "$t" ] && tests+=("$t")
    done < <(discover_include)

    local count=${#tests[@]}
    echo "  Discovered $count tests"

    local JOBS
    JOBS=$(nproc 2>/dev/null || sysctl -n hw.logicalcpu 2>/dev/null || echo 4)

    # Export for parallel compilation
    export OS_TEST WASM32_CC BUILD_DIR SYSROOT
    export CFLAGS_BASE_STR="${CFLAGS_BASE[*]}"
    export LINK_FLAGS_STR="${LINK_FLAGS[*]}"

    _build_include_wrapper() {
        local test_name="$1"
        local src="$OS_TEST/include/${test_name}.c"
        local wasm="$BUILD_DIR/include/${test_name}.wasm"
        local result_file="$BUILD_DIR/include/${test_name}.result"
        mkdir -p "$(dirname "$wasm")"

        # shellcheck disable=SC2086
        local -a cflags=($CFLAGS_BASE_STR -Wall -Wextra -Werror
            -Wno-error=deprecated -Wno-error=deprecated-declarations
            -I"$OS_TEST")
        # shellcheck disable=SC2086
        local -a link_flags=($LINK_FLAGS_STR)

        if "$WASM32_CC" "${cflags[@]}" -D_POSIX_C_SOURCE=202405L \
            "$src" "${link_flags[@]}" -o "$wasm" 2>/dev/null; then
            echo "good" > "$result_file"; rm -f "$wasm"; return
        fi
        if "$WASM32_CC" "${cflags[@]}" -D_POSIX_C_SOURCE=200809L \
            "$src" "${link_flags[@]}" -o "$wasm" 2>/dev/null; then
            echo "previous_posix" > "$result_file"; rm -f "$wasm"; return
        fi
        if "$WASM32_CC" "${cflags[@]}" -D_GNU_SOURCE -D_BSD_SOURCE -D_ALL_SOURCE -D_DEFAULT_SOURCE \
            "$src" "${link_flags[@]}" -o "$wasm" 2>/dev/null; then
            echo "extension" > "$result_file"; rm -f "$wasm"; return
        fi

        local err_file="$BUILD_DIR/include/${test_name}.err"
        "$WASM32_CC" "${cflags[@]}" -D_POSIX_C_SOURCE=202405L \
            "$src" "${link_flags[@]}" -o "$wasm" 2>"$err_file" || true

        if grep -q '/\*optional\*/' "$src" 2>/dev/null; then
            echo "missing_optional" > "$result_file"
        elif grep -Eq 'fatal error' "$err_file"; then
            echo "missing_header" > "$result_file"
        elif grep -Eq 'incompatible|pointer-sign' "$err_file"; then
            echo "incompatible" > "$result_file"
        elif grep -Eq 'undeclared|no member named|is not defined' "$err_file"; then
            echo "undeclared" > "$result_file"
        elif grep -Eq 'unknown type name|storage size of|expected declaration specifiers' "$err_file"; then
            echo "unknown_type" > "$result_file"
        elif grep -Eq 'undefined symbol' "$err_file"; then
            echo "undefined" > "$result_file"
        else
            echo "compile_error" > "$result_file"
        fi
        rm -f "$wasm"
    }
    export -f _build_include_wrapper

    echo "  Compiling in parallel ($JOBS jobs)..."
    printf '%s\n' "${tests[@]}" | xargs -P "$JOBS" -I{} bash -c '_build_include_wrapper "$@"' _ {}

    # Combine both shared and browser-specific XFAIL lists
    local -a xfail_list=("${INCLUDE_EXPECTED_FAIL[@]}")
    if [ ${#BROWSER_INCLUDE_EXPECTED_FAIL[@]} -gt 0 ]; then
        xfail_list+=("${BROWSER_INCLUDE_EXPECTED_FAIL[@]}")
    fi

    # Analyze results
    for test_name in "${tests[@]}"; do
        TOTAL=$((TOTAL + 1))
        local result_file="$BUILD_DIR/include/${test_name}.result"
        local outcome
        outcome=$(cat "$result_file" 2>/dev/null || echo "compile_error")

        local is_xfail=false
        if [ ${#xfail_list[@]} -gt 0 ] && is_expected_fail "$test_name" "${xfail_list[@]}"; then
            is_xfail=true
        fi

        case "$outcome" in
        good|previous_posix|extension)
            if $is_xfail; then
                echo "XPASS include/${test_name} ($outcome)"
                RESULTS+=("XPASS include/${test_name}")
                XPASS=$((XPASS + 1))
            else
                RESULTS+=("PASS  include/${test_name}")
                PASS=$((PASS + 1))
            fi
            ;;
        *)
            if $is_xfail && xfail_check "$(browser_xfail_expected_reason "include/${test_name}")" outcome "$outcome"; then
                RESULTS+=("XFAIL include/${test_name}")
                XFAIL=$((XFAIL + 1))
            elif $is_xfail; then
                record_xfail_mismatch "include/${test_name}" "$outcome"
            elif [ "$outcome" = "missing_optional" ]; then
                RESULTS+=("SKIP  include/${test_name}")
                SKIP=$((SKIP + 1))
            else
                echo "FAIL  include/${test_name} ($outcome)"
                RESULTS+=("FAIL  include/${test_name}")
                FAIL=$((FAIL + 1))
            fi
            ;;
        esac
    done

    local suite_pass=0 suite_fail=0 suite_xfail=0 suite_skip=0
    for r in "${RESULTS[@]}"; do
        case "$r" in
            "PASS  include/"*)  suite_pass=$((suite_pass + 1)) ;;
            "FAIL  include/"*)  suite_fail=$((suite_fail + 1)) ;;
            "XFAIL include/"*)  suite_xfail=$((suite_xfail + 1)) ;;
            "SKIP  include/"*)  suite_skip=$((suite_skip + 1)) ;;
            "XPASS include/"*)  suite_pass=$((suite_pass + 1)) ;;
        esac
    done
    echo "  include: $suite_pass pass, $suite_fail fail, $suite_xfail xfail, $suite_skip skip"
}

# ── Runtime suite (build + run in browser) ────────────────────────

run_runtime_suite() {
    local suite="$1"

    local -a tests=()
    while IFS= read -r t; do
        [ -n "$t" ] && tests+=("$t")
    done < <("discover_${suite}")

    local count=${#tests[@]}
    echo "  Discovered $count tests"

    # Build all tests
    echo "  Building $count tests..."
    local -a wasm_files=()
    local -a test_names=()
    local build_fail_count=0

    for test_name in "${tests[@]}"; do
        local skip_reason
        skip_reason="$(not_applicable_reason "$suite" "$test_name")"
        if [ -n "$skip_reason" ]; then
            TOTAL=$((TOTAL + 1))
            echo "SKIP  ${suite}/${test_name} (${skip_reason})"
            RESULTS+=("SKIP  ${suite}/${test_name}")
            SKIP=$((SKIP + 1))
            continue
        fi
        if build_runtime_test "$suite" "$test_name" 2>/dev/null; then
            wasm_files+=("$BUILD_DIR/$suite/${test_name}.wasm")
            test_names+=("$test_name")
        else
            TOTAL=$((TOTAL + 1))
            # Check if build failure is expected
            local is_xfail=false
            _get_xfail_list "$suite"
            if [ ${#_XFAIL_LIST[@]} -gt 0 ] && is_expected_fail "$test_name" "${_XFAIL_LIST[@]}"; then
                is_xfail=true
            fi
            if $is_xfail && xfail_check "$(browser_xfail_expected_reason "${suite}/${test_name}")" build "wasm not found: $BUILD_DIR/$suite/${test_name}.wasm"; then
                RESULTS+=("XFAIL ${suite}/${test_name}")
                XFAIL=$((XFAIL + 1))
            elif $is_xfail; then
                record_xfail_mismatch "${suite}/${test_name}" "build failed"
            else
                echo "BUILD ${suite}/${test_name}"
                RESULTS+=("BUILD ${suite}/${test_name}")
                BUILD_FAIL=$((BUILD_FAIL + 1))
            fi
            build_fail_count=$((build_fail_count + 1))
        fi
    done

    if [ ${#wasm_files[@]} -eq 0 ]; then
        echo "  No tests to run"
        return
    fi

    echo "  Running ${#wasm_files[@]} tests in browser..."

    # Run through browser test runner with JSON output
    local RESULT_FILE STDERR_FILE
    RESULT_FILE=$(mktemp)
    STDERR_FILE=$(mktemp)

    local RUNNER_RC=0
    set +e
    npx tsx scripts/browser-test-runner.ts --json --timeout "$TEST_TIMEOUT" \
        --reload-interval 10 \
        --data-prefix "$BUILD_DIR/$suite" \
        --source-dir "$OS_TEST/$suite" \
        --suite "$suite" \
        "${wasm_files[@]}" > "$RESULT_FILE" 2>"$STDERR_FILE"
    RUNNER_RC=$?
    set -e
    cat "$STDERR_FILE" >&2
    rm -f "$STDERR_FILE"

    # Parse results. Each JSON line is one test, in the order handed over.
    local idx=0
    local OUTPUT_FILE
    OUTPUT_FILE=$(mktemp)
    while IFS= read -r line; do
        [[ "$line" != "{"* ]] && continue

        if [ $idx -ge ${#test_names[@]} ]; then
            break
        fi

        # One parse per line: the scalar fields on stdout, and the guest's
        # output written byte-for-byte to OUTPUT_FILE, so an output of just
        # "\n" stays distinguishable from no output (sortix_compose_output).
        # Newer runner pages return an interleaved combined stream; older
        # ones only stdout and stderr.
        local exitCode error duration
        IFS=$'\t' read -r exitCode duration error < <(printf '%s' "$line" | OUTPUT_FILE="$OUTPUT_FILE" python3 -c '
import json, os, sys
d = json.load(sys.stdin)
combined = d.get("combined")
if not combined:
    combined = d.get("stdout", "") + d.get("stderr", "")
open(os.environ["OUTPUT_FILE"], "w").write(combined)
error = (d.get("error") or "").replace("\t", " ").replace("\n", " ")
print("\t".join([str(d.get("exitCode", -1)), str(d.get("durationMs", 0)), error]))
' 2>/dev/null || printf -- '-1\t0\tunparseable runner result\n')

        local test_name="${test_names[$idx]}"
        idx=$((idx + 1))
        TOTAL=$((TOTAL + 1))

        # Combined XFAIL list (shared + browser-specific)
        _get_xfail_list "$suite"

        local is_xfail=false
        if [ ${#_XFAIL_LIST[@]} -gt 0 ] && is_expected_fail "$test_name" "${_XFAIL_LIST[@]}"; then
            is_xfail=true
        fi
        local reason
        reason="$(browser_xfail_expected_reason "${suite}/${test_name}")"

        if [ -n "$error" ]; then
            local output
            output=$(cat "$OUTPUT_FILE")
            if [ "$error" = "TIMEOUT" ]; then
                if $is_xfail && xfail_check "$reason" timeout "$output"; then
                    RESULTS+=("XFAIL ${suite}/${test_name}")
                    XFAIL=$((XFAIL + 1))
                elif $is_xfail; then
                    record_xfail_mismatch "${suite}/${test_name}" "$output"
                else
                    echo "TIME  ${suite}/${test_name} (timeout)"
                    RESULTS+=("TIME  ${suite}/${test_name}")
                    TIMEOUT_COUNT=$((TIMEOUT_COUNT + 1))
                fi
            else
                # The runner could not run the test (page crash, load
                # failure): no XFAIL reason describes that.
                echo "ERROR ${suite}/${test_name}: $error"
                RESULTS+=("ERROR ${suite}/${test_name}")
                ERROR_COUNT=$((ERROR_COUNT + 1))
            fi
            continue
        fi

        local output test_passed=false
        output=$(sortix_compose_output "$OUTPUT_FILE" "$exitCode")
        sortix_expect_dirs "$suite" "$test_name"
        if [ ${#SORTIX_EXPECT_DIRS[@]} -gt 0 ]; then
            if sortix_output_matches "$suite" "$test_name" "$output"; then
                test_passed=true
            fi
        elif [ "$exitCode" = "0" ]; then
            test_passed=true
        fi

        if $test_passed; then
            if $is_xfail; then
                echo "XPASS ${suite}/${test_name}"
                RESULTS+=("XPASS ${suite}/${test_name}")
                XPASS=$((XPASS + 1))
            else
                echo "PASS  ${suite}/${test_name} (${duration}ms)"
                RESULTS+=("PASS  ${suite}/${test_name}")
                PASS=$((PASS + 1))
            fi
        elif $is_xfail && xfail_check "$reason" output "exit $exitCode
$output"; then
            RESULTS+=("XFAIL ${suite}/${test_name}")
            XFAIL=$((XFAIL + 1))
        elif $is_xfail; then
            record_xfail_mismatch "${suite}/${test_name}" "$output"
        else
            echo "FAIL  ${suite}/${test_name} (exit $exitCode)"
            printf '%s\n' "$output" | tail -10 | sed 's/^/  /'
            RESULTS+=("FAIL  ${suite}/${test_name}")
            FAIL=$((FAIL + 1))
        fi
    done < "$RESULT_FILE"
    rm -f "$RESULT_FILE" "$OUTPUT_FILE"

    # A test the runner never reported (its server or page could not start,
    # or it crashed) is an ERROR, not an absence: counting only reported
    # lines once let a 55-test section vanish from the totals.
    if [ "$idx" -lt "${#test_names[@]}" ]; then
        local -a ids=()
        local n
        for n in "${test_names[@]}"; do ids+=("${suite}/${n}"); done
        TOTAL=$((TOTAL + ${#test_names[@]} - idx))
        record_missing_browser_results "$idx" "$RUNNER_RC" "${ids[@]}"
    else
        record_runner_exit_after_results "$RUNNER_RC" "${suite}/browser-runner"
    fi
}

# Get combined XFAIL list (shared + browser-specific) for a suite.
# Sets _XFAIL_LIST global array (bash 3.2 doesn't support nameref).
_get_xfail_list() {
    local suite="$1"
    _XFAIL_LIST=()
    case "$suite" in
        include)  _XFAIL_LIST=(${INCLUDE_EXPECTED_FAIL[@]+"${INCLUDE_EXPECTED_FAIL[@]}"} ${BROWSER_INCLUDE_EXPECTED_FAIL[@]+"${BROWSER_INCLUDE_EXPECTED_FAIL[@]}"}) ;;
        basic)    _XFAIL_LIST=(${BASIC_EXPECTED_FAIL[@]+"${BASIC_EXPECTED_FAIL[@]}"} ${BROWSER_BASIC_EXPECTED_FAIL[@]+"${BROWSER_BASIC_EXPECTED_FAIL[@]}"}) ;;
        limits)   _XFAIL_LIST=(${LIMITS_EXPECTED_FAIL[@]+"${LIMITS_EXPECTED_FAIL[@]}"} ${BROWSER_LIMITS_EXPECTED_FAIL[@]+"${BROWSER_LIMITS_EXPECTED_FAIL[@]}"}) ;;
        malloc)   _XFAIL_LIST=(${MALLOC_EXPECTED_FAIL[@]+"${MALLOC_EXPECTED_FAIL[@]}"} ${BROWSER_MALLOC_EXPECTED_FAIL[@]+"${BROWSER_MALLOC_EXPECTED_FAIL[@]}"}) ;;
        stdio)    _XFAIL_LIST=(${STDIO_EXPECTED_FAIL[@]+"${STDIO_EXPECTED_FAIL[@]}"} ${BROWSER_STDIO_EXPECTED_FAIL[@]+"${BROWSER_STDIO_EXPECTED_FAIL[@]}"}) ;;
        io)       _XFAIL_LIST=(${IO_EXPECTED_FAIL[@]+"${IO_EXPECTED_FAIL[@]}"} ${BROWSER_IO_EXPECTED_FAIL[@]+"${BROWSER_IO_EXPECTED_FAIL[@]}"}) ;;
        signal)   _XFAIL_LIST=(${SIGNAL_EXPECTED_FAIL[@]+"${SIGNAL_EXPECTED_FAIL[@]}"} ${BROWSER_SIGNAL_EXPECTED_FAIL[@]+"${BROWSER_SIGNAL_EXPECTED_FAIL[@]}"}) ;;
        process)  _XFAIL_LIST=(${PROCESS_EXPECTED_FAIL[@]+"${PROCESS_EXPECTED_FAIL[@]}"} ${BROWSER_PROCESS_EXPECTED_FAIL[@]+"${BROWSER_PROCESS_EXPECTED_FAIL[@]}"}) ;;
        paths)    _XFAIL_LIST=(${PATHS_EXPECTED_FAIL[@]+"${PATHS_EXPECTED_FAIL[@]}"} ${BROWSER_PATHS_EXPECTED_FAIL[@]+"${BROWSER_PATHS_EXPECTED_FAIL[@]}"}) ;;
        udp)      _XFAIL_LIST=(${UDP_EXPECTED_FAIL[@]+"${UDP_EXPECTED_FAIL[@]}"} ${BROWSER_UDP_EXPECTED_FAIL[@]+"${BROWSER_UDP_EXPECTED_FAIL[@]}"}) ;;
    esac
}

# ── Main ───────────────────────────────────────────────────────────

ALL_MODE=false
SUITES=()
DEFAULT_SUITES=(include limits basic malloc stdio)
ALL_SUITES=(include limits basic malloc stdio io signal process paths udp)

while [ $# -gt 0 ]; do
    case "$1" in
        --all)    ALL_MODE=true; shift ;;
        include|limits|basic|malloc|stdio|io|signal|process|paths|udp)
            SUITES+=("$1"); shift ;;
        *) echo "Unknown argument: $1"; exit 1 ;;
    esac
done

if [ ${#SUITES[@]} -eq 0 ]; then
    if $ALL_MODE; then
        SUITES=("${ALL_SUITES[@]}")
    else
        SUITES=("${DEFAULT_SUITES[@]}")
    fi
fi

# Verify prerequisites
if [ ! -f "$SYSROOT/lib/libc.a" ]; then
    echo "Error: sysroot not found. Run scripts/build-musl.sh first." >&2
    exit 1
fi
if [ ! -f "$KERNEL_WASM" ]; then
    echo "Error: kernel wasm not found. Run build.sh first." >&2
    exit 1
fi
if [ ! -d "$OS_TEST" ]; then
    echo "Error: os-test not found. Run: git submodule update --init tests/sortix/os-test" >&2
    exit 1
fi
abi_contract_stamp_prepare || exit 1

PASS=0
FAIL=0
SKIP=0
BUILD_FAIL=0
TIMEOUT_COUNT=0
ERROR_COUNT=0
XFAIL=0
XPASS=0
RESULTS=()
TOTAL=0

for suite in "${SUITES[@]}"; do
    echo ""
    echo "===== ${suite} tests ====="
    echo ""

    if [ "$suite" = "include" ]; then
        run_include_suite
    else
        run_runtime_suite "$suite"
    fi
done

# ── Summary ────────────────────────────────────────────────────────

echo ""
echo "===== Browser Sortix os-test Results ====="
echo "PASS:    $PASS"
echo "FAIL:    $FAIL"
echo "XFAIL:   $XFAIL"
echo "XPASS:   $XPASS"
echo "BUILD:   $BUILD_FAIL"
echo "SKIP:    $SKIP"
echo "ERROR:   $ERROR_COUNT"
echo "TIMEOUT: $TIMEOUT_COUNT"
echo "TOTAL:   $TOTAL"
echo ""

# Group non-PASS results
if [ ${#RESULTS[@]} -gt 0 ]; then
    for status in FAIL XPASS BUILD ERROR TIME; do
        count=0
        for r in "${RESULTS[@]}"; do
            [[ "$r" == "$status "* ]] && count=$((count + 1))
        done
        if [ $count -gt 0 ]; then
            echo "── ${status} ($count) ──"
            for r in "${RESULTS[@]}"; do
                [[ "$r" == "$status "* ]] && echo "  $r"
            done
            echo ""
        fi
    done
fi

# The expected failures are shared with the Node.js runner, so an XPASS is a
# Node/browser divergence or a stale entry, and fails the run as it does on
# Node. ERROR and TIMEOUT are tests that did not finish.
if [ $FAIL -gt 0 ] || [ $XPASS -gt 0 ] || [ $BUILD_FAIL -gt 0 ] \
    || [ $ERROR_COUNT -gt 0 ] || [ $TIMEOUT_COUNT -gt 0 ]; then
    exit 1
fi
exit 0
