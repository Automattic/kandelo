#!/usr/bin/env bash
# Tests for scripts/check-no-allow-undefined.sh.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
GUARD="$HERE/check-no-allow-undefined.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

mkdir -p "$T/a/scripts" "$T/b/scripts" "$T/c/scripts"
printf 'LDFLAGS="-Wl,--allow-undefined"\n' > "$T/a/scripts/bad.sh"
printf 'LDFLAGS="-Wl,--allow-undefined-file=x.txt"\n' > "$T/a/scripts/good.sh"
printf 'LDFLAGS="-Wl,--allow-undefined-file=x.txt"\n' > "$T/b/scripts/good.sh"
printf '# before ABI 44 the SDK used --allow-undefined\n  // --allow-undefined was here\n' > "$T/b/scripts/comment.sh"
printf "expect(r).not.toMatch(/--allow-undefined(?!-file)/);\n" > "$T/b/scripts/flags.test.ts"
printf -- '-Wl,--allow-undefined # side-module: dynamic linking resolves at dlopen\n' > "$T/c/scripts/side.sh"

if out="$(bash "$GUARD" "$T/a" 2>&1)"; then fail "a: expected failure"; fi
grep -q 'bad.sh' <<<"$out" || fail "a: did not name bad.sh: $out"
grep -q 'good.sh' <<<"$out" && fail "a: wrongly named good.sh"
bash "$GUARD" "$T/b" >/dev/null || fail "b: comments and allowance files must pass"
bash "$GUARD" "$T/c" >/dev/null || fail "c: marked side-module lines must pass"
echo "check-no-allow-undefined: all tests passed"
