#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/../../../.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/kandelo-sfwbar-symbols.XXXXXX")"
trap 'rm -rf "$work"' EXIT
check="$repo/packages/registry/sfwbar/wasm-symbols.mjs"
cat > "$work/main.wat" <<'WAT'
(module
 (import "env" "__wpk_fork_frame_commit" (func))
 (import "env" "__wpk_fork_made_up" (func))
 (import "env" "__wpk_fork_frame_next" (global i32))
 (func (export "gtk_widget_show"))
 (global (export "wrong_kind") i32 (i32.const 0)))
WAT
wat2wasm "$work/main.wat" -o "$work/main.wasm"
fixture() {
  printf '(module %s)\n' "$2" > "$work/$1.wat"
  wat2wasm "$work/$1.wat" -o "$work/$1.wasm"
  node "$check" missing "$work/main.wasm" "$work/$1.wasm" > "$work/$1.missing"
  test "$(cat "$work/$1.missing")" = "$3"
}
fixture ordinary '(import "env" "gtk_widget_show" (func))' ''
fixture missing '(import "env" "gtk_widget_missing" (func))' gtk_widget_missing
fixture wrong-kind '(import "env" "wrong_kind" (func))' wrong_kind
fixture fork '(import "env" "__wpk_fork_frame_commit" (func))' ''
fixture fake-fork '(import "env" "__wpk_fork_made_up" (func))' __wpk_fork_made_up
fixture wrong-fork-kind '(import "env" "__wpk_fork_frame_next" (global i32))' __wpk_fork_frame_next
fixture side-only-fork '(import "env" "__wpk_fork_frame_reserve" (func))' ''
fixture numbered-fork '(import "env" "__wpk_fork_ref_gc_i31" (func))' ''
fixture relocation '(import "env" "__memory_base" (global i32))' ''
fixture wrong-relocation '(import "env" "__memory_base" (func))' __memory_base
fixture got-function '(import "GOT.func" "gtk_widget_show" (global (mut i32)))' ''
fixture wrong-got-kind '(import "GOT.mem" "gtk_widget_show" (global (mut i32)))' gtk_widget_show
printf '\0asm\1' > "$work/malformed.wasm"
if node "$check" missing "$work/main.wasm" "$work/malformed.wasm" > "$work/malformed.output" 2> "$work/malformed.error"; then
  echo 'Malformed artifact was accepted' >&2; exit 1
fi
test ! -s "$work/malformed.output"
# Exercise the real post-link typed-reference artifacts, not an objdump mock.
source "$repo/sdk/activate.sh"
printf 'extern void gtk_widget_show(void); void entry(void) { gtk_widget_show(); }\n' > "$work/side.c"
printf 'void gtk_widget_show(void) {} int main(void) { return 0; }\n' > "$work/main.c"
wasm32posix-cc -O1 -Wl,--export-all "$work/main.c" -o "$work/main-raw.wasm"
wasm32posix-cc -O1 -fPIC -shared "$work/side.c" -o "$work/side-raw.so"
bash "$repo/scripts/run-wasm-fork-instrument.sh" "$work/main-raw.wasm" -o "$work/main-typed.wasm"
bash "$repo/scripts/run-wasm-fork-instrument.sh" "$work/side-raw.so" -o "$work/side-typed.so"
node "$check" missing "$work/main-typed.wasm" "$work/side-typed.so" > "$work/typed.missing"
if [ -s "$work/typed.missing" ]; then cat "$work/typed.missing" >&2; exit 1; fi
node "$check" exports "$work/side-typed.so" > "$work/typed.exports"
grep -Fx entry "$work/typed.exports" >/dev/null
printf 'SFWBar module symbol checks: 14 controls passed\n'
