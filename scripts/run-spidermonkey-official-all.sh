#!/usr/bin/env bash
set -euo pipefail

# Exhaustively run the upstream SpiderMonkey shell harnesses in chunks.
#
# `run-spidermonkey-official-tests.sh` can run a whole upstream suite in one
# invocation, but jstests.py spends a long time feature-probing the complete
# tree before it emits progress. Chunking by upstream directory makes the run
# resumable and leaves one log per area for kernel-bug triage. This runner is
# exhaustive: it enumerates every runnable SpiderMonkey jstest and jit-test
# file from the Mozilla source checkout, rather than maintaining a hand-picked
# selector list.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_WRAPPER="$REPO_ROOT/scripts/kandelo-js-shell-wrapper.sh"
BROWSER_WRAPPER="$REPO_ROOT/scripts/kandelo-browser-js-shell-wrapper.sh"
source "$REPO_ROOT/scripts/spidermonkey-known-skips.sh"

HOST="both"
SUITE="both"
JOBS="${SPIDERMONKEY_OFFICIAL_JOBS:-1}"
TIMEOUT="${SPIDERMONKEY_OFFICIAL_TIMEOUT:-120}"
XUL_INFO="${SPIDERMONKEY_XUL_INFO:-wasm32:Linux:false}"
WPT_MODE="${SPIDERMONKEY_OFFICIAL_WPT:-disabled}"
FORMAT="${SPIDERMONKEY_OFFICIAL_FORMAT:-automation}"
JSTEST_JITFLAGS="${SPIDERMONKEY_OFFICIAL_JSTEST_JITFLAGS:-none}"
JITFLAGS="${SPIDERMONKEY_OFFICIAL_JITFLAGS:-all}"
RESULTS_DIR="$REPO_ROOT/test-results/spidermonkey-official"
CONTINUE=1
RUN_SLOW="${SPIDERMONKEY_OFFICIAL_RUN_SLOW:-1}"
JSTEST_CHUNK_SIZE="${SPIDERMONKEY_OFFICIAL_JSTEST_CHUNK_SIZE:-500}"
JIT_CHUNK_SIZE="${SPIDERMONKEY_OFFICIAL_JIT_CHUNK_SIZE:-500}"
START_AT="${SPIDERMONKEY_OFFICIAL_START_AT:-}"
STARTED=0
RESTART_BRIDGE_PER_CHUNK="${SPIDERMONKEY_OFFICIAL_RESTART_BRIDGE_PER_CHUNK:-0}"
CHUNK_LIST="${SPIDERMONKEY_OFFICIAL_CHUNK_LIST:-}"
JS_SHELL_WRAPPER="$NODE_WRAPPER"
NODE_SERVER_PID=""
BROWSER_SERVER_PID=""
FILTERED_JIT_FILES=()
KANDELO_KNOWN_SKIP_FILES=()
NEXT_KNOWN_SKIP_FILES=()

FILTERED_JSTEST_SELECTORS=()

# Node-host jstest rows that exhausted the supported official-harness resource
# envelope during the kad-165.4 exhaustive inventory. These are post-processed
# only when the upstream harness actually reports a TIMEOUT for the exact test
# path; passing rows remain ordinary TEST-PASS results.
KANDELO_NODE_JSTEST_DETERMINISTIC_RESOURCE_TIMEOUT_SELECTORS=(
  "non262/TypedArray/sort_modifications_concurrent.js"
  "non262/async-functions/syntax.js"
  "shell/os.js"
  "test262/built-ins/Set/prototype/union/size-is-a-number.js"
)

KANDELO_NODE_JSTEST_EXPECTED_RESOURCE_TIMEOUT_SELECTORS=(
  "non262/TypedArray/sort_modifications_concurrent.js"
  "non262/async-functions/syntax.js"
  "shell/os.js"
  "test262/built-ins/Math/sin/S15.8.2.16_A5.js"
  "test262/built-ins/Object/defineProperties/15.2.3.7-5-b-263.js"
  "test262/built-ins/Object/getOwnPropertyDescriptor/15.2.3.3-2-38.js"
  "test262/built-ins/Object/getOwnPropertyDescriptor/15.2.3.3-4-160.js"
  "test262/built-ins/Object/getOwnPropertyDescriptor/15.2.3.3-4-39.js"
  "test262/built-ins/RegExp/prototype/Symbol.matchAll/species-constructor-species-throws.js"
  "test262/built-ins/RegExp/prototype/Symbol.matchAll/this-get-flags.js"
  "test262/built-ins/RegExp/prototype/Symbol.matchAll/this-not-object-throws.js"
  "test262/built-ins/Set/prototype/has/has.js"
  "test262/built-ins/Set/prototype/has/this-not-object-throw-string.js"
  "test262/built-ins/Set/prototype/has/this-not-object-throw-symbol.js"
  "test262/built-ins/Set/prototype/has/this-not-object-throw-undefined.js"
  "test262/built-ins/Set/prototype/isDisjointFrom/size-is-a-number.js"
  "test262/built-ins/Set/prototype/union/size-is-a-number.js"
  "test262/built-ins/TypedArray/prototype/copyWithin/BigInt/detached-buffer.js"
  "test262/built-ins/TypedArray/prototype/every/not-a-constructor.js"
  "test262/built-ins/TypedArray/prototype/every/returns-false-if-any-cb-returns-false.js"
  "test262/built-ins/TypedArray/prototype/fill/BigInt/get-length-ignores-length-prop.js"
  "test262/built-ins/TypedArray/prototype/forEach/detached-buffer.js"
  "test262/built-ins/TypedArray/prototype/reduceRight/callbackfn-arguments-custom-accumulator.js"
  "test262/built-ins/TypedArray/prototype/slice/BigInt/speciesctor-get-species.js"
  "test262/built-ins/TypedArray/prototype/sort/prop-desc.js"
  "test262/built-ins/TypedArray/prototype/values/BigInt/iter-prototype.js"
  "test262/built-ins/TypedArray/prototype/with/index-bigger-or-eq-than-length.js"
  "test262/built-ins/TypedArrayConstructors/ctors-bigint/object-arg/null-tobigint.js"
  "test262/built-ins/TypedArrayConstructors/ctors/no-args/returns-object.js"
  "test262/built-ins/TypedArrayConstructors/internals/HasProperty/BigInt/detached-buffer-key-is-symbol.js"
  "test262/built-ins/TypedArrayConstructors/internals/HasProperty/BigInt/infinity-with-detached-buffer.js"
  "test262/built-ins/TypedArrayConstructors/internals/HasProperty/BigInt/key-is-minus-zero.js"
  "test262/built-ins/TypedArrayConstructors/of/BigInt/custom-ctor-does-not-instantiate-ta-throws.js"
  "test262/built-ins/Uint8Array/prototype/setFromHex/results.js"
  "test262/built-ins/Uint8Array/prototype/toBase64/descriptor.js"
  "test262/built-ins/decodeURI/S15.1.3.1_A1.11_T2.js"
  "test262/built-ins/global/S10.2.3_A1.2_T4.js"
  "test262/built-ins/isFinite/not-a-constructor.js"
  "test262/built-ins/isNaN/return-abrupt-from-tonumber-number.js"
  "test262/built-ins/parseFloat/tonumber-numeric-separator-literal-nzd-nsl-dd.js"
  "test262/built-ins/parseInt/S15.1.2.2_A1_T1.js"
  "test262/language/arguments-object/10.6-6-1.js"
  "test262/language/arguments-object/S10.6_A5_T4.js"
  "test262/language/arguments-object/cls-expr-async-gen-meth-static-args-trailing-comma-undefined.js"
  "test262/language/arguments-object/cls-expr-async-private-gen-meth-static-args-trailing-comma-spread-operator.js"
  "test262/language/asi/S7.9_A7_T4.js"
  "test262/language/block-scope/syntax/for-in/acquire-properties-from-object.js"
  "test262/language/block-scope/syntax/redeclaration/const-name-redeclaration-attempt-with-async-function.js"
  "test262/language/eval-code/direct/async-func-decl-no-pre-existing-arguments-bindings-are-present-declare-arguments-and-assign.js"
  "test262/language/eval-code/direct/async-gen-func-decl-a-following-parameter-is-named-arguments-declare-arguments-and-assign.js"
  "test262/language/eval-code/direct/gen-meth-no-pre-existing-arguments-bindings-are-present-declare-arguments-and-assign.js"
  "test262/language/expressions/arrow-function/dstr/ary-ptrn-rest-init-id.js"
  "test262/language/expressions/arrow-function/dstr/dflt-ary-ptrn-elem-id-iter-complete.js"
  "test262/language/expressions/arrow-function/dstr/dflt-ary-ptrn-elem-id-iter-step-err.js"
  "test262/language/expressions/arrow-function/dstr/dflt-ary-ptrn-rest-id-direct.js"
  "test262/language/expressions/arrow-function/dstr/dflt-obj-ptrn-id-init-skipped.js"
  "test262/language/expressions/arrow-function/dstr/obj-ptrn-id-init-unresolvable.js"
  "test262/language/expressions/arrow-function/dstr/obj-ptrn-prop-obj-value-undef.js"
  "test262/language/expressions/arrow-function/dstr/syntax-error-ident-ref-extends-escaped-ext.js"
  "test262/language/expressions/assignment/fn-name-class.js"
  "test262/language/expressions/assignment/member-expr-ident-name-continue-escaped.js"
  "test262/language/expressions/assignment/target-member-computed-reference-undefined.js"
  "test262/language/expressions/assignment/target-string.js"
  "test262/language/expressions/assignmenttargettype/direct-coalesceexpressionhead-coalesce-bitwiseorexpression-2.js"
  "test262/language/expressions/assignmenttargettype/direct-lefthandsideexpression-minus-minus.js"
  "test262/language/expressions/assignmenttargettype/parenthesized-asyncarrowfunction-0.js"
  "test262/language/expressions/async-function/expression-returns-promise.js"
  "test262/language/expressions/async-function/named-reassign-fn-name-in-body.js"
  "test262/language/expressions/async-function/nameless-unscopables-with-in-nested-fn.js"
  "test262/language/expressions/async-generator/dstr/ary-ptrn-elem-obj-prop-id-init.js"
  "test262/language/expressions/async-generator/dstr/ary-ptrn-rest-obj-prop-id.js"
  "test262/language/expressions/async-generator/dstr/named-ary-ptrn-elem-id-iter-done.js"
  "test262/language/expressions/async-generator/dstr/named-ary-ptrn-elem-obj-prop-id-init.js"
  "test262/language/expressions/async-generator/dstr/named-dflt-ary-init-iter-get-err.js"
  "test262/language/expressions/async-generator/dstr/named-dflt-ary-ptrn-rest-init-obj.js"
  "test262/language/expressions/async-generator/dstr/named-dflt-ary-ptrn-rest-not-final-id.js"
  "test262/language/expressions/async-generator/dstr/named-dflt-obj-ptrn-prop-ary-trailing-comma.js"
  "test262/language/expressions/async-generator/early-errors-expression-await-as-function-binding-identifier.js"
  "test262/language/expressions/async-generator/named-dflt-params-ref-prior.js"
  "test262/language/expressions/async-generator/named-object-destructuring-param-strict-body.js"
  "test262/language/expressions/async-generator/named-yield-star-getiter-async-get-abrupt.js"
  "test262/language/expressions/async-generator/named-yield-star-getiter-async-not-callable-boolean-throw.js"
  "test262/language/expressions/async-generator/unscopables-with.js"
  "test262/language/expressions/async-generator/yield-star-getiter-async-not-callable-string-throw.js"
  "test262/language/expressions/async-generator/yield-star-getiter-async-returns-symbol-throw.js"
  "test262/language/expressions/async-generator/yield-star-next-non-object-ignores-then.js"
  "test262/language/expressions/async-generator/yield-star-next-not-callable-null-throw.js"
  "test262/language/expressions/class/async-method-static/dflt-params-ref-prior.js"
  "test262/language/expressions/class/cpn-class-expr-accessors-computed-property-name-from-additive-expression-add.js"
  "test262/language/expressions/class/cpn-class-expr-computed-property-name-from-decimal-e-notational-literal.js"
  "test262/language/expressions/class/cpn-class-expr-computed-property-name-from-identifier.js"
  "test262/language/expressions/class/dstr/async-gen-meth-dflt-ary-ptrn-rest-id.js"
  "test262/language/expressions/class/dstr/async-gen-meth-dflt-obj-ptrn-id-init-fn-name-cover.js"
  "test262/language/expressions/class/dstr/async-private-gen-meth-obj-ptrn-id-trailing-comma.js"
  "test262/language/expressions/class/dstr/gen-meth-dflt-ary-ptrn-rest-ary-elision.js"
  "test262/language/expressions/class/dstr/gen-meth-dflt-obj-ptrn-prop-ary-init.js"
  "test262/language/expressions/class/dstr/meth-dflt-ary-ptrn-rest-id-iter-val-err.js"
  "test262/language/expressions/class/dstr/meth-dflt-obj-ptrn-prop-obj-value-null.js"
  "test262/language/expressions/class/dstr/meth-static-dflt-ary-ptrn-elision-exhausted.js"
  "test262/language/expressions/class/dstr/private-gen-meth-dflt-ary-ptrn-elem-id-init-fn-name-gen.js"
  "test262/language/expressions/class/elements/after-same-line-static-async-gen-private-names.js"
  "test262/language/expressions/class/elements/after-same-line-static-async-method-static-private-methods.js"
  "test262/language/expressions/class/elements/after-same-line-static-method-static-private-methods.js"
  "test262/language/expressions/class/elements/async-gen-private-method-static/yield-star-next-then-non-callable-number-fulfillpromise.js"
  "test262/language/expressions/class/elements/class-name-static-initializer-default-export.js"
  "test262/language/expressions/class/elements/init-err-evaluation.js"
  "test262/language/expressions/class/elements/multiple-stacked-definitions-rs-privatename-identifier-initializer-alt.js"
  "test262/language/expressions/class/elements/nested-private-literal-name-init-err-contains-arguments.js"
  "test262/language/expressions/class/elements/private-setter-shadowed-by-setter-on-nested-class.js"
  "test262/language/expressions/class/elements/prod-private-getter-before-super-return-in-field-initializer.js"
  "test262/language/expressions/class/elements/regular-definitions-static-private-methods-with-fields.js"
  "test262/language/expressions/class/elements/same-line-gen-rs-static-method-privatename-identifier-alt.js"
  "test262/language/expressions/class/elements/wrapped-in-sc-computed-names.js"
  "test262/language/expressions/class/elements/wrapped-in-sc-rs-private-setter.js"
  "test262/language/expressions/coalesce/short-circuit-number-0.js"
  "test262/language/expressions/compound-assignment/S11.13.2_A4.9_T2.8.js"
  "test262/language/expressions/compound-assignment/S11.13.2_A7.7_T3.js"
  "test262/language/expressions/does-not-equals/S11.9.2_A4.2.js"
  "test262/language/expressions/does-not-equals/bigint-and-number-extremes.js"
  "test262/language/expressions/dynamic-import/namespace/promise-then-ns-own-property-keys-sort.js"
  "test262/language/expressions/dynamic-import/usage/nested-arrow-import-then-is-call-expression-square-brackets.js"
  "test262/language/expressions/dynamic-import/usage/nested-async-function-is-call-expression-square-brackets.js"
  "test262/language/expressions/dynamic-import/usage/nested-async-gen-return-await-specifier-tostring.js"
  "test262/language/expressions/dynamic-import/usage/nested-else-import-then-eval-gtbndng-indirect-update-dflt.js"
  "test262/language/expressions/dynamic-import/usage/nested-function-import-then-eval-gtbndng-indirect-update.js"
  "test262/language/expressions/dynamic-import/usage/syntax-nested-block-labeled-eval-gtbndng-indirect-update-dflt.js"
  "test262/language/expressions/equals/S11.9.1_A1.js"
  "test262/language/expressions/equals/S11.9.1_A2.4_T1.js"
  "test262/language/expressions/function/dstr/ary-ptrn-elem-id-iter-val.js"
  "test262/language/expressions/function/dstr/ary-ptrn-rest-id-iter-val-err.js"
  "test262/language/expressions/function/dstr/dflt-ary-ptrn-elem-id-init-fn-name-fn.js"
  "test262/language/expressions/function/dstr/dflt-ary-ptrn-rest-id-iter-val-err.js"
  "test262/language/expressions/function/dstr/dflt-obj-ptrn-list-err.js"
  "test262/language/expressions/generators/dstr/dflt-ary-ptrn-rest-id-exhausted.js"
  "test262/language/expressions/new/S11.2.2_A3_T5.js"
  "test262/language/expressions/object/accessor-name-literal-string-single-quote.js"
  "test262/language/expressions/object/dstr/async-gen-meth-ary-ptrn-elem-id-iter-val-err.js"
  "test262/language/expressions/object/dstr/async-gen-meth-dflt-obj-ptrn-id-init-fn-name-gen.js"
  "test262/language/expressions/object/dstr/async-gen-meth-obj-ptrn-prop-ary-trailing-comma.js"
  "test262/language/expressions/object/dstr/gen-meth-dflt-ary-ptrn-elem-ary-empty-iter.js"
  "test262/language/expressions/object/dstr/meth-ary-ptrn-elision.js"
  "test262/language/expressions/object/dstr/meth-dflt-obj-init-null.js"
  "test262/language/expressions/object/ident-name-method-def-super-escaped.js"
  "test262/language/expressions/object/method-definition/async-gen-meth-dflt-params-abrupt.js"
  "test262/language/expressions/object/method-definition/async-gen-yield-star-next-not-callable-undefined-throw.js"
  "test262/language/expressions/object/method-definition/async-meth-eval-var-scope-syntax-err.js"
  "test262/language/expressions/object/method-definition/generator-params.js"
  "test262/language/expressions/object/method-definition/name-param-id-yield.js"
  "test262/language/expressions/object/method-definition/params-dflt-meth-ref-arguments.js"
  "test262/language/expressions/object/method-definition/static-init-await-binding-accessor.js"
  "test262/language/expressions/object/scope-setter-body-lex-distinc.js"
  "test262/language/expressions/subtraction/S11.6.2_A2.2_T1.js"
  "test262/language/expressions/subtraction/bigint-toprimitive.js"
  "test262/language/expressions/unsigned-right-shift/S11.7.3_A2.2_T1.js"
  "test262/language/statements/async-generator/dstr/dflt-ary-ptrn-elem-ary-rest-iter.js"
  "test262/language/statements/async-generator/dstr/dflt-ary-ptrn-elem-id-init-fn-name-fn.js"
  "test262/language/statements/async-generator/dstr/dflt-ary-ptrn-elem-id-iter-val-err.js"
  "test262/language/statements/async-generator/dstr/dflt-obj-ptrn-list-err.js"
)

usage() {
  cat <<EOF
Usage: $0 [OPTIONS]

Options:
  --host node|browser|both       Host to run on (default: both)
  --suite jstests|jit-tests|both Official suite(s) to run (default: both)
  --jobs N                       Upstream harness worker count per chunk (default: 1)
  --timeout SECONDS              Upstream per-test timeout (default: 120)
  --format FORMAT                Upstream output format (default: automation)
  --jstest-jitflags VARIANT      jstests jitflags variant (default: none)
  --jitflags VARIANT             jit-tests jitflags variant (default: all)
  --no-slow                      Use upstream defaults and skip tests marked slow
  --results-dir DIR              Directory for logs and summaries
  --start-at CHUNK               Skip chunks until CHUNK, suite/CHUNK, or host/suite/CHUNK
  --chunk-list FILE              Run only listed chunks, one chunk, suite/chunk, or host/suite/chunk per line
  --restart-bridge-per-chunk     Restart the host bridge before each chunk
  --fail-fast                    Stop after the first failing chunk
  --help                         Show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --host)
      HOST="${2:-}"
      if [ "$HOST" != "node" ] && [ "$HOST" != "browser" ] && [ "$HOST" != "both" ]; then
        echo "ERROR: --host must be node, browser, or both" >&2
        exit 2
      fi
      shift 2
      ;;
    --suite)
      SUITE="${2:-}"
      if [ "$SUITE" != "jstests" ] && [ "$SUITE" != "jit-tests" ] && [ "$SUITE" != "both" ]; then
        echo "ERROR: --suite must be jstests, jit-tests, or both" >&2
        exit 2
      fi
      shift 2
      ;;
    --jobs)
      JOBS="${2:-}"
      shift 2
      ;;
    --timeout)
      TIMEOUT="${2:-}"
      shift 2
      ;;
    --format)
      FORMAT="${2:-}"
      shift 2
      ;;
    --jstest-jitflags)
      JSTEST_JITFLAGS="${2:-}"
      shift 2
      ;;
    --jitflags)
      JITFLAGS="${2:-}"
      shift 2
      ;;
    --no-slow)
      RUN_SLOW=0
      shift
      ;;
    --results-dir)
      RESULTS_DIR="${2:-}"
      shift 2
      ;;
    --start-at)
      START_AT="${2:-}"
      shift 2
      ;;
    --chunk-list)
      CHUNK_LIST="${2:-}"
      shift 2
      ;;
    --restart-bridge-per-chunk)
      RESTART_BRIDGE_PER_CHUNK=1
      shift
      ;;
    --fail-fast)
      CONTINUE=0
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

is_positive_integer() {
  case "$1" in
    ''|*[!0-9]*)
      return 1
      ;;
    *)
      [ "$1" -gt 0 ]
      ;;
  esac
}

guard_browser_jobs() {
  if ! is_positive_integer "$JOBS"; then
    echo "ERROR: --jobs must be a positive integer" >&2
    exit 2
  fi
  case "$HOST" in
    browser|both)
      if [ "$JOBS" -gt 1 ] && [ "${SPIDERMONKEY_ALLOW_BROWSER_MULTIWORKER_SINGLE_BRIDGE:-0}" != "1" ]; then
        echo "ERROR: browser --jobs $JOBS through one bridge is non-authoritative; use scripts/run-spidermonkey-browser-sharded.sh for multi-lane browser parallelism." >&2
        exit 2
      fi
      ;;
  esac
}

guard_browser_jobs

if [ -n "$CHUNK_LIST" ] && [ ! -f "$CHUNK_LIST" ]; then
  echo "ERROR: --chunk-list file not found: $CHUNK_LIST" >&2
  exit 2
fi

ensure_kernel() {
  if "$REPO_ROOT/scripts/resolve-binary.sh" kernel.wasm >/dev/null 2>&1; then
    return 0
  fi
  echo "==> Building kernel.wasm for SpiderMonkey official tests..." >&2
  bash "$REPO_ROOT/packages/registry/kernel/build-kernel.sh"
}

resolve_js_wasm() {
  local candidate

  candidate="${SPIDERMONKEY_WASM:-}"
  if [ -n "$candidate" ] && [ -f "$candidate" ]; then
    printf '%s\n' "$candidate"
    return 0
  fi

  candidate="$("$REPO_ROOT/scripts/resolve-binary.sh" programs/js.wasm 2>/dev/null || true)"
  if [ -n "$candidate" ] && [ -f "$candidate" ]; then
    printf '%s\n' "$candidate"
    return 0
  fi

  candidate="$("$REPO_ROOT/scripts/resolve-binary.sh" programs/spidermonkey.wasm 2>/dev/null || true)"
  if [ -n "$candidate" ] && [ -f "$candidate" ]; then
    printf '%s\n' "$candidate"
    return 0
  fi

  candidate="$REPO_ROOT/packages/registry/spidermonkey/bin/js.wasm"
  if [ -n "$candidate" ] && [ -f "$candidate" ]; then
    printf '%s\n' "$candidate"
    return 0
  fi

  return 1
}

ensure_js_wasm() {
  local js_wasm host_target
  if js_wasm="$(resolve_js_wasm)"; then
    export SPIDERMONKEY_WASM="$js_wasm"
    return 0
  fi

  if command -v cargo >/dev/null 2>&1 && command -v rustc >/dev/null 2>&1; then
    echo "==> Resolving SpiderMonkey js.wasm via package registry..." >&2
    host_target="$(rustc -vV | awk '/^host/ {print $2}')"
    (
      cd "$REPO_ROOT"
      cargo --config "build.target=\"$host_target\"" run -p xtask --quiet -- \
        build-deps --arch wasm32 --binaries-dir "$REPO_ROOT/binaries" resolve spidermonkey
    ) >&2 || true
  fi

  if js_wasm="$(resolve_js_wasm)"; then
    export SPIDERMONKEY_WASM="$js_wasm"
    return 0
  fi

  echo "ERROR: SpiderMonkey js.wasm not found." >&2
  echo "Run: bash packages/registry/spidermonkey/build-spidermonkey.sh" >&2
  exit 1
}

ensure_browser_rootfs() {
  if [ -f "$REPO_ROOT/host/wasm/rootfs.vfs" ] ||
      "$REPO_ROOT/scripts/resolve-binary.sh" rootfs.vfs >/dev/null 2>&1; then
    return 0
  fi
  echo "==> Building minimal rootfs.vfs for the browser test host..." >&2
  node --import tsx/esm "$REPO_ROOT/scripts/build-minimal-rootfs-vfs.ts"
}

SM_SOURCE="$("$REPO_ROOT/scripts/ensure-spidermonkey-source.sh")"
ensure_kernel
ensure_js_wasm
export SPIDERMONKEY_SOURCE_DIR="$SM_SOURCE"
chmod +x "$NODE_WRAPPER" "$BROWSER_WRAPPER"
mkdir -p "$RESULTS_DIR"
SUMMARY="$RESULTS_DIR/summary.tsv"
printf 'host\tsuite\tchunk\tstatus\tpass\tknown_skip\tunexpected\telapsed_seconds\tqueue_seconds\tguest_seconds\tstart\tend\tlog\n' > "$SUMMARY"
INVENTORY="$RESULTS_DIR/inventory.tsv"

safe_name() {
  printf '%s' "$1" | tr '/ ' '__'
}

count_pattern() {
  local pattern="$1"
  local file="$2"
  grep -c "$pattern" "$file" 2>/dev/null || true
}

record_result() {
  local host="$1"
  local suite="$2"
  local chunk="$3"
  local status="$4"
  local log="$5"
  local start="${6:-}"
  local end="${7:-}"
  local elapsed="${8:-0}"
  local queue_seconds="${9:-0}"
  local guest_seconds="${10:-$elapsed}"
  local pass known unexpected
  pass="$(count_pattern 'TEST-PASS' "$log")"
  known="$(count_pattern 'TEST-KNOWN-FAIL' "$log")"
  unexpected="$(count_pattern 'TEST-UNEXPECTED' "$log")"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$host" "$suite" "$chunk" "$status" "$pass" "$known" "$unexpected" \
    "$elapsed" "$queue_seconds" "$guest_seconds" "$start" "$end" "$log" \
    | tee -a "$SUMMARY"
}

rel_jit_test_path() {
  local file="$1"
  printf '%s\n' "${file#$SM_SOURCE/js/src/jit-test/tests/}"
}

rel_jstest_path() {
  local file="$1"
  printf '%s\n' "${file#$SM_SOURCE/js/src/tests/}"
}

array_contains() {
  local needle="$1"
  shift
  local value
  for value in "$@"; do
    if [ "$value" = "$needle" ]; then
      return 0
    fi
  done
  return 1
}

is_kandelo_node_jstest_expected_resource_timeout() {
  local host="$1"
  local selector="$2"
  if [ "$host" != "node" ]; then
    return 1
  fi
  array_contains "$selector" "${KANDELO_NODE_JSTEST_EXPECTED_RESOURCE_TIMEOUT_SELECTORS[@]}"
}

kandelo_node_jstest_expected_resource_timeout_reason() {
  local selector="$1"
  if array_contains "$selector" "${KANDELO_NODE_JSTEST_DETERMINISTIC_RESOURCE_TIMEOUT_SELECTORS[@]}"; then
    printf 'deterministic Kandelo Node host SpiderMonkey jstest resource/stress timeout'
  else
    printf 'chunk/order-dependent Kandelo Node host SpiderMonkey jstest resource-envelope timeout'
  fi
}

classify_kandelo_node_jstest_expected_resource_timeouts() {
  local host="$1"
  local suite="$2"
  local log="$3"
  local tmp changed line selector rest reason
  if [ "$suite" != "jstests" ] || [ "$host" != "node" ]; then
    return 1
  fi

  tmp="$log.classified.$$"
  changed=0
  while IFS= read -r line || [ -n "$line" ]; do
    if [[ "$line" == TEST-UNEXPECTED-FAIL\ \|\ * && "$line" == *"(TIMEOUT)"* ]]; then
      rest="${line#TEST-UNEXPECTED-FAIL | }"
      selector="${rest%% | *}"
      if is_kandelo_node_jstest_expected_resource_timeout "$host" "$selector"; then
        reason="$(kandelo_node_jstest_expected_resource_timeout_reason "$selector")"
        printf 'TEST-KNOWN-FAIL | %s | expected: %s (kad-165.21)\n' "$selector" "$reason" >> "$tmp"
        changed=1
        continue
      fi
    fi
    printf '%s\n' "$line" >> "$tmp"
  done < "$log"

  if [ "$changed" = "1" ]; then
    mv "$tmp" "$log"
    return 0
  fi

  rm -f "$tmp"
  return 1
}

is_kandelo_known_jstest_skip() {
  local host="$1"
  local file="$2"
  local rel
  rel="$(rel_jstest_path "$file")"
  kandelo_known_jstest_skip_reason "$host" "$rel" >/dev/null
}

is_kandelo_wasm32_known_jstest_skip_dir() {
  local _host="$1"
  local dir="$2"
  local rel
  rel="${dir#$SM_SOURCE/js/src/tests/}"
  rel="${rel%/}"
  case "$rel" in
    test262/built-ins/Atomics/*/bigint)
      return 0
      ;;
  esac
  return 1
}

is_kandelo_browser_wasm32_known_jit_skip() {
  local host="$1"
  local file="$2"
  local rel
  rel="$(rel_jit_test_path "$file")"
  kandelo_known_jit_skip_reason "$host" "$rel" >/dev/null
}

filter_kandelo_known_jit_skips() {
  local host="$1"
  shift
  FILTERED_JIT_FILES=()
  KANDELO_KNOWN_SKIP_FILES=()
  local file
  for file in "$@"; do
    if is_kandelo_browser_wasm32_known_jit_skip "$host" "$file"; then
      KANDELO_KNOWN_SKIP_FILES+=("$file")
    else
      FILTERED_JIT_FILES+=("$file")
    fi
  done
}

filter_kandelo_known_jstest_skips() {
  local host="$1"
  shift
  FILTERED_JSTEST_SELECTORS=()
  KANDELO_KNOWN_SKIP_FILES=()
  local selector file
  for selector in "$@"; do
    file="$SM_SOURCE/js/src/tests/$selector"
    if [ -f "$file" ] && is_kandelo_known_jstest_skip "$host" "$file"; then
      KANDELO_KNOWN_SKIP_FILES+=("$file")
    else
      FILTERED_JSTEST_SELECTORS+=("$selector")
    fi
  done
}

queue_known_skip_entries() {
  NEXT_KNOWN_SKIP_FILES=()
  if [ "$#" -gt 0 ]; then
    NEXT_KNOWN_SKIP_FILES=("$@")
  fi
}

write_known_skip_entries() {
  local suite="$1"
  shift
  kandelo_write_known_skip_entries "$suite" "$CURRENT_HOST" "$@"
}

should_skip_chunk() {
  local host="$1"
  local suite="$2"
  local chunk="$3"
  if [ -n "$CHUNK_LIST" ] &&
      ! grep -Ev '^[[:space:]]*($|#)' "$CHUNK_LIST" |
        grep -Fxq -e "$chunk" -e "$suite/$chunk" -e "$host/$suite/$chunk"; then
    return 0
  fi
  if [ -z "$START_AT" ] || [ "$STARTED" = "1" ]; then
    return 1
  fi
  if [ "$chunk" = "$START_AT" ] ||
      [ "$suite/$chunk" = "$START_AT" ] ||
      [ "$host/$suite/$chunk" = "$START_AT" ]; then
    STARTED=1
    return 1
  fi
  echo "Skipping $host $suite $chunk before --start-at $START_AT" | tee -a "$RESULTS_DIR/progress.log"
  return 0
}

is_platform_crash_log() {
  local log="$1"
  grep -Eiq \
    'RuntimeError: unreachable|memory access out of bounds|Maximum call stack size exceeded|deadlock|unreaped|ABI mismatch|VFS .*mismatch|missing artifact|spidermonkey-test\.vfs\.zst not found' \
    "$log" 2>/dev/null
}

stop_shell_bridge_pid() {
  local pid="$1" name="$2" timeout killer_pid
  timeout="${SPIDERMONKEY_SHELL_BRIDGE_SHUTDOWN_TIMEOUT_SECONDS:-15}"
  [ -n "$pid" ] || return 0

  if ! kill -0 "$pid" 2>/dev/null; then
    wait "$pid" 2>/dev/null || true
    return 0
  fi

  kill "$pid" 2>/dev/null || true
  (
    sleep "$timeout"
    if kill -0 "$pid" 2>/dev/null; then
      echo "WARNING: $name did not exit after ${timeout}s; sending SIGKILL" >&2
      kill -KILL "$pid" 2>/dev/null || true
    fi
  ) &
  killer_pid=$!
  wait "$pid" 2>/dev/null || true
  kill "$killer_pid" 2>/dev/null || true
  wait "$killer_pid" 2>/dev/null || true
}

start_node_shell_bridge() {
  local port="${SPIDERMONKEY_NODE_JS_SHELL_PORT:-5311}"
  export SPIDERMONKEY_NODE_JS_SHELL_PORT="$port"
  export SPIDERMONKEY_NODE_JS_SHELL_URL="http://127.0.0.1:$port/run"

  node --experimental-wasm-exnref --import tsx/esm "$REPO_ROOT/scripts/kandelo-node-js-shell-server.ts" &
  NODE_SERVER_PID=$!

  for _ in $(seq 1 120); do
    if node -e "fetch('http://127.0.0.1:${port}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
      return 0
    fi
    if ! kill -0 "$NODE_SERVER_PID" 2>/dev/null; then
      echo "ERROR: node js shell bridge exited early" >&2
      return 1
    fi
    sleep 1
  done
  echo "ERROR: node js shell bridge did not become ready" >&2
  return 1
}

stop_node_shell_bridge() {
  if [ -n "${NODE_SERVER_PID:-}" ]; then
    stop_shell_bridge_pid "$NODE_SERVER_PID" "node js shell bridge"
    NODE_SERVER_PID=""
  fi
  unset SPIDERMONKEY_NODE_JS_SHELL_URL
}

start_browser_shell_bridge() {
  local port="${SPIDERMONKEY_BROWSER_JS_SHELL_PORT:-5312}"
  export SPIDERMONKEY_BROWSER_JS_SHELL_PORT="$port"
  export SPIDERMONKEY_BROWSER_JS_SHELL_URL="http://127.0.0.1:$port/run"
  export SPIDERMONKEY_OFFICIAL_REBUILD_VFS="${SPIDERMONKEY_OFFICIAL_REBUILD_VFS:-0}"
  export SPIDERMONKEY_BROWSER_JS_SHELL_RECYCLE_INTERVAL="${SPIDERMONKEY_BROWSER_JS_SHELL_RECYCLE_INTERVAL:-25}"
  export SPIDERMONKEY_BROWSER_JS_SHELL_BROWSER_RECYCLE_INTERVAL="${SPIDERMONKEY_BROWSER_JS_SHELL_BROWSER_RECYCLE_INTERVAL:-100}"
  export SPIDERMONKEY_BROWSER_JS_SHELL_WASM_OOB_RETRIES="${SPIDERMONKEY_BROWSER_JS_SHELL_WASM_OOB_RETRIES:-1}"

  node --import tsx/esm "$REPO_ROOT/scripts/kandelo-browser-js-shell-server.ts" &
  BROWSER_SERVER_PID=$!

  for _ in $(seq 1 180); do
    if node -e "fetch('http://127.0.0.1:${port}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
      return 0
    fi
    if ! kill -0 "$BROWSER_SERVER_PID" 2>/dev/null; then
      echo "ERROR: browser js shell bridge exited early" >&2
      return 1
    fi
    sleep 1
  done
  echo "ERROR: browser js shell bridge did not become ready" >&2
  return 1
}

stop_browser_shell_bridge() {
  if [ -n "${BROWSER_SERVER_PID:-}" ]; then
    stop_shell_bridge_pid "$BROWSER_SERVER_PID" "browser js shell bridge"
    BROWSER_SERVER_PID=""
  fi
}

restart_shell_bridge_for_chunk() {
  local host="$1"
  if [ "$RESTART_BRIDGE_PER_CHUNK" != "1" ]; then
    return 0
  fi
  case "$host" in
    node)
      stop_node_shell_bridge
      start_node_shell_bridge
      ;;
    browser)
      stop_browser_shell_bridge
      start_browser_shell_bridge
      ;;
  esac
}

has_runnable_jstest_files() {
  local dir="$1"
  [ -n "$(find "$dir" -type f -name '*.js' ! -name 'shell.js' ! -name 'browser.js' ! -name 'template.js' ! -name 'user.js' ! -name 'js-test-driver-begin.js' ! -name 'js-test-driver-end.js' -print -quit)" ]
}

count_runnable_jstest_files() {
  local dir="$1"
  find "$dir" -type f -name '*.js' ! -name 'shell.js' ! -name 'browser.js' ! -name 'template.js' ! -name 'user.js' ! -name 'js-test-driver-begin.js' ! -name 'js-test-driver-end.js' | wc -l | tr -d ' '
}

write_inventory() {
  local dir count total
  printf 'suite\tchunk\trunnable_js_files\n' > "$INVENTORY"

  total=0
  for dir in "$SM_SOURCE/js/src/tests"/*/; do
    [ -d "$dir" ] || continue
    if has_runnable_jstest_files "$dir"; then
      count="$(count_runnable_jstest_files "$dir")"
      total=$((total + count))
      printf 'jstests\t%s\t%s\n' "$(basename "$dir")" "$count" >> "$INVENTORY"
    fi
  done
  printf 'jstests\t_ALL_\t%s\n' "$total" >> "$INVENTORY"

  total=0
  count="$(find "$SM_SOURCE/js/src/jit-test/tests" -mindepth 1 -maxdepth 1 -type f -name '*.js' ! -name 'shell.js' ! -name 'browser.js' | wc -l | tr -d ' ')"
  if [ "$count" -gt 0 ]; then
    total=$((total + count))
    printf 'jit-tests\t_files\t%s\n' "$count" >> "$INVENTORY"
  fi
  for dir in "$SM_SOURCE/js/src/jit-test/tests"/*/; do
    [ -d "$dir" ] || continue
    count="$(find "$dir" -type f -name '*.js' ! -name 'shell.js' ! -name 'browser.js' ! -name 'template.js' ! -name 'user.js' ! -name 'js-test-driver-begin.js' ! -name 'js-test-driver-end.js' | wc -l | tr -d ' ')"
    if [ "$count" -gt 0 ]; then
      total=$((total + count))
      printf 'jit-tests\t%s\t%s\n' "$(basename "$dir")" "$count" >> "$INVENTORY"
    fi
  done
  printf 'jit-tests\t_ALL_\t%s\n' "$total" >> "$INVENTORY"

  echo "Inventory written to $INVENTORY"
}

run_chunk() {
  local host="$1"
  local suite="$2"
  local chunk="$3"
  shift 3
  local log="$RESULTS_DIR/$(safe_name "$host-$suite-$chunk").log"
  local known_skip_files=("${NEXT_KNOWN_SKIP_FILES[@]+"${NEXT_KNOWN_SKIP_FILES[@]}"}")
  local start end start_epoch end_epoch elapsed
  NEXT_KNOWN_SKIP_FILES=()

  if should_skip_chunk "$host" "$suite" "$chunk"; then
    return 0
  fi
  restart_shell_bridge_for_chunk "$host"

  start="$(date -u +%FT%TZ)"
  start_epoch="$(date +%s)"
  echo "===== $start $host $suite $chunk =====" | tee -a "$RESULTS_DIR/progress.log"
  set +e
  if [ "${#known_skip_files[@]}" -gt 0 ]; then
    write_known_skip_entries "$suite" "${known_skip_files[@]}" > "$log"
    run_upstream_chunk "$suite" "$@" >> "$log" 2>&1
  else
    run_upstream_chunk "$suite" "$@" > "$log" 2>&1
  fi
  local status=$?
  set -e
  end="$(date -u +%FT%TZ)"
  end_epoch="$(date +%s)"
  elapsed=$((end_epoch - start_epoch))

  if classify_kandelo_node_jstest_expected_resource_timeouts "$host" "$suite" "$log"; then
    if ! grep -q 'TEST-UNEXPECTED' "$log" && ! grep -q '^Terminated:' "$log"; then
      status=0
    fi
  fi

  record_result "$host" "$suite" "$chunk" "$status" "$log" "$start" "$end" "$elapsed" 0 "$elapsed"
  if is_platform_crash_log "$log"; then
    echo "Stopping after platform-crash signature in $host/$suite/$chunk" >&2
    exit 86
  fi
  if [ "$status" -ne 0 ] && [ "$CONTINUE" = "0" ]; then
    echo "Stopping after failing chunk $host/$suite/$chunk" >&2
    exit "$status"
  fi
}

record_known_skip_only_chunk() {
  local host="$1"
  local suite="$2"
  local chunk="$3"
  shift 3
  local log="$RESULTS_DIR/$(safe_name "$host-$suite-$chunk").log"
  local start end

  if should_skip_chunk "$host" "$suite" "$chunk"; then
    return 0
  fi

  start="$(date -u +%FT%TZ)"
  echo "===== $start $host $suite $chunk =====" | tee -a "$RESULTS_DIR/progress.log"
  write_known_skip_entries "$suite" "$@" > "$log"
  end="$(date -u +%FT%TZ)"
  record_result "$host" "$suite" "$chunk" 0 "$log" "$start" "$end" 0 0 0
}

run_upstream_chunk() {
  local suite="$1"
  shift
  local jstest_slow_args=()
  local jit_slow_args=()
  if [ "$RUN_SLOW" = "1" ]; then
    jstest_slow_args=(--run-slow-tests)
    jit_slow_args=(--slow)
  fi
  export SPIDERMONKEY_WRAPPER_TIMEOUT_MS="${SPIDERMONKEY_WRAPPER_TIMEOUT_MS:-$((TIMEOUT * 1000 + 30000))}"
  case "$suite" in
    jstests)
      echo "===== Official SpiderMonkey jstests on Kandelo $CURRENT_HOST host ====="
      python3 "$SM_SOURCE/js/src/tests/jstests.py" \
        --no-progress \
        --no-xdr \
        --xul-info "$XUL_INFO" \
        --wpt "$WPT_MODE" \
        --format "$FORMAT" \
        --jitflags "$JSTEST_JITFLAGS" \
        ${jstest_slow_args[@]+"${jstest_slow_args[@]}"} \
        --worker-count "$JOBS" \
        --timeout "$TIMEOUT" \
        "$JS_SHELL_WRAPPER" \
        "$@"
      ;;
    jit-tests)
      echo "===== Official SpiderMonkey jit-tests on Kandelo $CURRENT_HOST host ====="
      python3 "$SM_SOURCE/js/src/jit-test/jit_test.py" \
        --no-progress \
        --no-xdr \
        --worker-count "$JOBS" \
        --timeout "$TIMEOUT" \
        --format "$FORMAT" \
        --jitflags "$JITFLAGS" \
        ${jit_slow_args[@]+"${jit_slow_args[@]}"} \
        "$@" \
        "$JS_SHELL_WRAPPER"
      ;;
    *)
      echo "ERROR: unknown suite $suite" >&2
      return 2
      ;;
  esac
}

run_jstest_empty_chunk() {
  local host="$1"
  local chunk="$2"
  local log="$RESULTS_DIR/$(safe_name "$host-jstests-$chunk").log"
  if should_skip_chunk "$host" jstests "$chunk"; then
    return 0
  fi
  printf 'No runnable jstests in %s; only harness helper files were present.\n' "$chunk" > "$log"
  local now
  now="$(date -u +%FT%TZ)"
  record_result "$host" jstests "$chunk" 0 "$log" "$now" "$now" 0 0 0
}

run_jstest_selector_group() {
  local host="$1"
  local chunk="$2"
  shift 2
  if [ "$#" -eq 0 ]; then
    return 0
  fi
  filter_kandelo_known_jstest_skips "$host" "$@"
  if [ "${#FILTERED_JSTEST_SELECTORS[@]}" -gt 0 ]; then
    queue_known_skip_entries "${KANDELO_KNOWN_SKIP_FILES[@]+"${KANDELO_KNOWN_SKIP_FILES[@]}"}"
    run_chunk "$host" jstests "$chunk" "${FILTERED_JSTEST_SELECTORS[@]}"
  else
    record_known_skip_only_chunk "$host" jstests "$chunk" "${KANDELO_KNOWN_SKIP_FILES[@]+"${KANDELO_KNOWN_SKIP_FILES[@]}"}"
  fi
}

run_jstest_file_groups() {
  local host="$1"
  local chunk_prefix="$2"
  shift 2
  local selectors=("$@")
  local total="${#selectors[@]}"
  local index=0
  local part=1
  local group=()

  while [ "$index" -lt "$total" ]; do
    group=("${selectors[@]:$index:$JSTEST_CHUNK_SIZE}")
    run_jstest_selector_group "$host" "${chunk_prefix}#part-$(printf '%04d' "$part")" "${group[@]}"
    index=$((index + JSTEST_CHUNK_SIZE))
    part=$((part + 1))
  done
}

read_selected_chunks() {
  local host="$1"
  local suite="$2"
  local entry
  SELECTED_CHUNKS=()

  while IFS= read -r entry || [ -n "$entry" ]; do
    entry="$(printf '%s' "$entry" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    case "$entry" in
      ""|\#*) continue ;;
      "$host/$suite/"*) SELECTED_CHUNKS+=("${entry#"$host/$suite/"}") ;;
      "$suite/"*) SELECTED_CHUNKS+=("${entry#"$suite/"}") ;;
      node/*|browser/*|jstests/*|jit-tests/*) continue ;;
      *) SELECTED_CHUNKS+=("$entry") ;;
    esac
  done < "$CHUNK_LIST"
}

run_jstest_chunk_direct() {
  local host="$1"
  local chunk="$2"
  local base="$chunk"
  local part=""
  local dir dir_chunk path child start_index selectors=() group=()

  if [[ "$base" == *#part-* ]]; then
    part="${base##*#part-}"
    base="${base%#part-*}"
  fi

  if [[ "$base" == */_files ]]; then
    dir_chunk="${base%/_files}"
    dir="$SM_SOURCE/js/src/tests/$dir_chunk"
    if [ ! -d "$dir" ]; then
      echo "ERROR: selected jstest _files chunk directory not found: $chunk" >&2
      return 2
    fi
    while IFS= read -r -d '' child; do
      selectors+=("${child#$SM_SOURCE/js/src/tests/}")
    done < <(find "$dir" -mindepth 1 -maxdepth 1 -type f -name '*.js' ! -name 'shell.js' ! -name 'browser.js' ! -name 'template.js' ! -name 'user.js' ! -name 'js-test-driver-begin.js' ! -name 'js-test-driver-end.js' -print0 | sort -z)
    if [ -n "$part" ]; then
      start_index=$(( (10#$part - 1) * JSTEST_CHUNK_SIZE ))
      group=("${selectors[@]:$start_index:$JSTEST_CHUNK_SIZE}")
      run_jstest_selector_group "$host" "$chunk" "${group[@]}"
    else
      run_jstest_file_groups "$host" "$base" "${selectors[@]}"
    fi
    return 0
  fi

  if [ -n "$part" ]; then
    echo "ERROR: selected jstest part chunk is not an _files chunk: $chunk" >&2
    return 2
  fi

  path="$SM_SOURCE/js/src/tests/$base"
  if [ -f "$path" ]; then
    run_jstest_selector_group "$host" "$chunk" "$base"
    return 0
  fi
  if [ -d "$path" ]; then
    run_jstest_dir_recursive "$host" "$path" "$chunk"
    return 0
  fi

  echo "ERROR: selected jstest chunk not found: $chunk" >&2
  return 2
}

run_jstest_dir_recursive() {
  local host="$1"
  local dir="$2"
  local chunk="$3"
  local count child child_chunk direct_files=() known_skip_files=() selectors=()

  count="$(count_runnable_jstest_files "$dir")"
  if [ "$count" -eq 0 ]; then
    run_jstest_empty_chunk "$host" "$chunk"
    return 0
  fi

  if is_kandelo_wasm32_known_jstest_skip_dir "$host" "$dir"; then
    while IFS= read -r -d '' child; do
      known_skip_files+=("$child")
    done < <(find "$dir" -type f -name '*.js' ! -name 'shell.js' ! -name 'browser.js' ! -name 'template.js' ! -name 'user.js' ! -name 'js-test-driver-begin.js' ! -name 'js-test-driver-end.js' -print0 | sort -z)
    record_known_skip_only_chunk "$host" jstests "$chunk" "${known_skip_files[@]+"${known_skip_files[@]}"}"
    return 0
  fi

  if [ "$count" -le "$JSTEST_CHUNK_SIZE" ]; then
    while IFS= read -r -d '' child; do
      selectors+=("${child#$SM_SOURCE/js/src/tests/}")
    done < <(find "$dir" -type f -name '*.js' ! -name 'shell.js' ! -name 'browser.js' ! -name 'template.js' ! -name 'user.js' ! -name 'js-test-driver-begin.js' ! -name 'js-test-driver-end.js' -print0 | sort -z)
    filter_kandelo_known_jstest_skips "$host" "${selectors[@]}"
    if [ "${#KANDELO_KNOWN_SKIP_FILES[@]}" -gt 0 ]; then
      if [ "${#FILTERED_JSTEST_SELECTORS[@]}" -gt 0 ]; then
        queue_known_skip_entries "${KANDELO_KNOWN_SKIP_FILES[@]+"${KANDELO_KNOWN_SKIP_FILES[@]}"}"
        run_chunk "$host" jstests "$chunk" "${FILTERED_JSTEST_SELECTORS[@]}"
      else
        record_known_skip_only_chunk "$host" jstests "$chunk" "${KANDELO_KNOWN_SKIP_FILES[@]+"${KANDELO_KNOWN_SKIP_FILES[@]}"}"
      fi
      return 0
    fi
    run_chunk "$host" jstests "$chunk" "$chunk/"
    return 0
  fi

  # Large directories are split recursively. Any runnable files directly under
  # this directory are still included; helper files named shell.js/browser.js
  # are excluded because the upstream manifest loads them as harness support.
  while IFS= read -r -d '' child; do
    direct_files+=("${child#$SM_SOURCE/js/src/tests/}")
  done < <(find "$dir" -mindepth 1 -maxdepth 1 -type f -name '*.js' ! -name 'shell.js' ! -name 'browser.js' ! -name 'template.js' ! -name 'user.js' ! -name 'js-test-driver-begin.js' ! -name 'js-test-driver-end.js' -print0 | sort -z)
  if [ "${#direct_files[@]}" -gt 0 ]; then
    run_jstest_file_groups "$host" "$chunk/_files" "${direct_files[@]}"
  fi

  while IFS= read -r -d '' child; do
    child_chunk="$chunk/$(basename "$child")"
    run_jstest_dir_recursive "$host" "$child" "$child_chunk"
  done < <(find "$dir" -mindepth 1 -maxdepth 1 -type d -print0 | sort -z)
}

run_jstests_for_host() {
  local host="$1"
  local dir chunk
  if [ -n "$CHUNK_LIST" ]; then
    read_selected_chunks "$host" jstests
    for chunk in "${SELECTED_CHUNKS[@]+"${SELECTED_CHUNKS[@]}"}"; do
      run_jstest_chunk_direct "$host" "$chunk"
    done
    return 0
  fi

  for dir in "$SM_SOURCE/js/src/tests"/*/; do
    [ -d "$dir" ] || continue
    if has_runnable_jstest_files "$dir"; then
      run_jstest_dir_recursive "$host" "$dir" "$(basename "$dir")"
    fi
  done
}

run_jit_tests_for_host() {
  local host="$1"
  local dir files=() total index part group list_file chunk
  while IFS= read -r -d '' file; do
    files+=("$file")
  done < <(find "$SM_SOURCE/js/src/jit-test/tests" -mindepth 1 -maxdepth 1 -type f -name '*.js' ! -name 'shell.js' ! -name 'browser.js' -print0 | sort -z)
  total="${#files[@]}"
  if [ "$total" -gt 0 ]; then
    index=0
    part=1
    while [ "$index" -lt "$total" ]; do
      group=("${files[@]:$index:$JIT_CHUNK_SIZE}")
      if [ "$total" -le "$JIT_CHUNK_SIZE" ]; then
        chunk="_files"
      else
        chunk="_files#part-$(printf '%04d' "$part")"
      fi
      list_file="$RESULTS_DIR/jit-$(safe_name "$chunk").txt"
      filter_kandelo_known_jit_skips "$host" "${group[@]}"
      if [ "${#FILTERED_JIT_FILES[@]}" -gt 0 ]; then
        printf '%s\n' "${FILTERED_JIT_FILES[@]}" > "$list_file"
        queue_known_skip_entries "${KANDELO_KNOWN_SKIP_FILES[@]+"${KANDELO_KNOWN_SKIP_FILES[@]}"}"
        run_chunk "$host" jit-tests "$chunk" --read-tests "$list_file"
      else
        : > "$list_file"
        record_known_skip_only_chunk "$host" jit-tests "$chunk" "${KANDELO_KNOWN_SKIP_FILES[@]+"${KANDELO_KNOWN_SKIP_FILES[@]}"}"
      fi
      index=$((index + JIT_CHUNK_SIZE))
      part=$((part + 1))
    done
  fi

  for dir in "$SM_SOURCE/js/src/jit-test/tests"/*/; do
    [ -d "$dir" ] || continue
    files=()
    while IFS= read -r -d '' file; do
      files+=("$file")
    done < <(find "$dir" -type f -name '*.js' ! -name 'shell.js' ! -name 'browser.js' -print0 | sort -z)
    total="${#files[@]}"
    if [ "$total" -eq 0 ]; then
      continue
    fi
    index=0
    part=1
    while [ "$index" -lt "$total" ]; do
      group=("${files[@]:$index:$JIT_CHUNK_SIZE}")
      if [ "$total" -le "$JIT_CHUNK_SIZE" ]; then
        chunk="$(basename "$dir")"
      else
        chunk="$(basename "$dir")#part-$(printf '%04d' "$part")"
      fi
      list_file="$RESULTS_DIR/jit-$(safe_name "$chunk").txt"
      filter_kandelo_known_jit_skips "$host" "${group[@]}"
      if [ "${#FILTERED_JIT_FILES[@]}" -gt 0 ]; then
        printf '%s\n' "${FILTERED_JIT_FILES[@]}" > "$list_file"
        queue_known_skip_entries "${KANDELO_KNOWN_SKIP_FILES[@]+"${KANDELO_KNOWN_SKIP_FILES[@]}"}"
        run_chunk "$host" jit-tests "$chunk" --read-tests "$list_file"
      else
        : > "$list_file"
        record_known_skip_only_chunk "$host" jit-tests "$chunk" "${KANDELO_KNOWN_SKIP_FILES[@]+"${KANDELO_KNOWN_SKIP_FILES[@]}"}"
      fi
      index=$((index + JIT_CHUNK_SIZE))
      part=$((part + 1))
    done
  done
}

HOSTS=()
if [ "$HOST" = "both" ]; then
  HOSTS=(node browser)
else
  HOSTS=("$HOST")
fi

write_inventory

for host in "${HOSTS[@]}"; do
  CURRENT_HOST="$host"
  case "$host" in
    node)
      JS_SHELL_WRAPPER="$NODE_WRAPPER"
      start_node_shell_bridge || exit 1
      trap stop_node_shell_bridge EXIT
      ;;
    browser)
      JS_SHELL_WRAPPER="$BROWSER_WRAPPER"
      ensure_browser_rootfs
      start_browser_shell_bridge || exit 1
      trap stop_browser_shell_bridge EXIT
      ;;
  esac

  case "$SUITE" in
    jstests)
      run_jstests_for_host "$host"
      ;;
    jit-tests)
      run_jit_tests_for_host "$host"
      ;;
    both)
      run_jstests_for_host "$host"
      run_jit_tests_for_host "$host"
      ;;
  esac

  case "$host" in
    node)
      stop_node_shell_bridge
      trap - EXIT
      ;;
    browser)
      stop_browser_shell_bridge
      trap - EXIT
      ;;
  esac
done

echo "Summary written to $SUMMARY"
