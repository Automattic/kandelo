#!/usr/bin/env bash

# Shared Kandelo policy for official SpiderMonkey harness exclusions.
# Callers must set SM_SOURCE before using path helpers.

KANDELO_BROWSER_WASM32_KNOWN_JIT_SKIP_FILES=(
  "atomics/bigint-add-for-effect.js"
  "atomics/bigint-add.js"
  "atomics/bigint-and-for-effect.js"
  "atomics/bigint-and.js"
  "atomics/bigint-compareExchange.js"
  "atomics/bigint-exchange.js"
  "atomics/bigint-load.js"
  "atomics/bigint-or-for-effect.js"
  "atomics/bigint-or.js"
  "atomics/bigint-store.js"
  "atomics/bigint-sub-for-effect.js"
  "atomics/bigint-sub.js"
  "atomics/bigint-xor-for-effect.js"
  "atomics/bigint-xor.js"
)

kandelo_rel_jstest_path() {
  local file="$1"
  printf '%s\n' "${file#$SM_SOURCE/js/src/tests/}"
}

kandelo_rel_jit_test_path() {
  local file="$1"
  printf '%s\n' "${file#$SM_SOURCE/js/src/jit-test/tests/}"
}

kandelo_known_jstest_skip_reason() {
  local host="$1"
  local rel="$2"

  case "$host:$rel" in
    node:non262/extensions/array-isArray-proxy-recursion.js|\
    node:non262/regress/regress-311629.js)
      printf '%s\n' "Node worker stack stress: recursive SpiderMonkey wasm frames currently exhaust the host WebAssembly call stack before the shell can report the guest recursion error"
      return 0
      ;;
  esac

  case "$rel" in
    test262/built-ins/Atomics/*/bigint/*.js)
      printf '%s\n' "wasm32 SpiderMonkey limitation: this build lacks native 64-bit BigInt atomics"
      return 0
      ;;
  esac

  if [ "$host" = "browser" ]; then
    case "$rel" in
      non262/extensions/array-isArray-proxy-recursion.js|\
      non262/extensions/String-methods-infinite-recursion.js|\
      non262/extensions/regress-355497.js|\
      non262/extensions/regress-192465.js|\
      non262/object/setPrototypeOf-cycle.js|\
      non262/operators/instanceof-bound-function-recursion.js|\
      non262/regress/regress-256501.js|\
      non262/regress/regress-96526-002.js|\
      non262/regress/regress-329530.js|\
      non262/regress/regress-192414.js|\
      non262/regress/regress-234389.js|\
      non262/regress/regress-311629.js|\
      non262/regress/regress-152646.js)
        printf '%s\n' "browser process-worker stack stress: recursive SpiderMonkey wasm frames currently exceed the supported browser worker stack envelope before the shell can report the guest recursion error"
        return 0
        ;;
      non262/Promise/any-stack-overflow.js)
        printf '%s\n' "browser process-worker stack stress: Promise.any recursion currently exceeds the supported browser worker stack envelope"
        return 0
        ;;
      test262/staging/sm/extensions/recursion.js)
        printf '%s\n' "browser worker stack stress: recursive SpiderMonkey wasm frames currently exceed the supported browser worker stack envelope"
        return 0
        ;;
      test262/staging/sm/expressions/destructuring-pattern-parenthesized.js|\
      test262/staging/sm/expressions/optional-chain-super-elem.js|\
      test262/staging/sm/expressions/optional-chain-tdz.js)
        printf '%s\n' "known Kandelo browser wasm32 SpiderMonkey staging limitation"
        return 0
        ;;
    esac
  fi

  return 1
}

kandelo_known_jit_skip_reason() {
  local host="$1"
  local rel="$2"
  local known

  if [ "$host" != "browser" ]; then
    return 1
  fi

  for known in "${KANDELO_BROWSER_WASM32_KNOWN_JIT_SKIP_FILES[@]}"; do
    if [ "$rel" = "$known" ]; then
      printf '%s\n' "browser wasm32 SpiderMonkey limitation: this build lacks native 64-bit BigInt atomics"
      return 0
    fi
  done

  return 1
}

kandelo_expected_jstest_variant_count() {
  case "${JSTEST_JITFLAGS:-none}" in
    all|jstests) printf '4\n' ;;
    ion) printf '2\n' ;;
    debug) printf '3\n' ;;
    baseline|interp|none) printf '1\n' ;;
    *) printf '1\n' ;;
  esac
}

kandelo_jitflag_variant_count() {
  case "${JITFLAGS:-all}" in
    all) printf '6\n' ;;
    jstests) printf '4\n' ;;
    ion) printf '2\n' ;;
    debug) printf '3\n' ;;
    tsan) printf '3\n' ;;
    baseline|interp|none) printf '1\n' ;;
    *) printf '1\n' ;;
  esac
}

kandelo_known_skip_entry_count() {
  local suite="$1"
  local file="$2"

  if [ "$suite" = "jstests" ]; then
    kandelo_expected_jstest_variant_count
    return 0
  fi

  if [ "$suite" != "jit-tests" ]; then
    printf '1\n'
    return 0
  fi

  local count joins
  count="$(kandelo_jitflag_variant_count)"
  joins="$({ head -n 1 "$file" | grep -o 'test-join=' || true; } | wc -l | tr -d ' ')"
  while [ "$joins" -gt 0 ]; do
    count=$((count * 2))
    joins=$((joins - 1))
  done
  printf '%s\n' "$count"
}

kandelo_known_skip_reason() {
  local suite="$1"
  local host="$2"
  local file="$3"

  case "$suite" in
    jstests)
      kandelo_known_jstest_skip_reason "$host" "$(kandelo_rel_jstest_path "$file")"
      ;;
    jit-tests)
      kandelo_known_jit_skip_reason "$host" "$(kandelo_rel_jit_test_path "$file")"
      ;;
    *)
      return 1
      ;;
  esac
}

kandelo_rel_suite_test_path() {
  local suite="$1"
  local file="$2"

  case "$suite" in
    jstests)
      kandelo_rel_jstest_path "$file"
      ;;
    jit-tests)
      kandelo_rel_jit_test_path "$file"
      ;;
    *)
      printf '%s\n' "$file"
      ;;
  esac
}

kandelo_write_known_skip_entries() {
  local suite="$1"
  local host="$2"
  shift 2

  local file rel count index reason
  for file in "$@"; do
    rel="$(kandelo_rel_suite_test_path "$suite" "$file")"
    count="$(kandelo_known_skip_entry_count "$suite" "$file")"
    reason="$(kandelo_known_skip_reason "$suite" "$host" "$file" || true)"
    if [ -z "$reason" ]; then
      reason="known Kandelo SpiderMonkey limitation"
    fi

    index=1
    while [ "$index" -le "$count" ]; do
      printf 'TEST-KNOWN-FAIL | %s | skipped: %s (variant %s/%s)\n' \
        "$rel" "$reason" "$index" "$count"
      index=$((index + 1))
    done
  done
}
