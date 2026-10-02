#!/usr/bin/env bash
# Fixture checks for fsa: each line is <fixture> <exc-mode> <expected
# instrumented_sink> <expected SINK names, comma-separated or ->.
set -uo pipefail
cd "$(dirname "$0")"
F=../target/$(rustc -vV | awk '/^host/ {print $2}')/release/fsa
fail=0
while read -r fx mode want sinks; do
  [ -z "$fx" ] && continue
  wasm-tools parse "$fx.wat" -o "/tmp/fsa-$fx.wasm" || { echo "FAIL $fx: parse"; fail=1; continue; }
  extra=(); [ "$mode" = param ] && { extra=(--param); mode=static; }
  [ "$mode" = coarse ] && { extra=(--catchers coarse); mode=equiv; }
  out=$("$F" --wasm "/tmp/fsa-$fx.wasm" --exc "$mode" "${extra[@]}" 2>&1)
  got=$(awk -F'\t' '$1=="instrumented_sink"{print $2}' <<<"$out")
  gsinks=$(awk -F'\t' '$1=="SINK"{print $2}' <<<"$out" | sort | paste -sd, -)
  [ -z "$gsinks" ] && gsinks=-
  if [ "$got" = "$want" ] && [ "$gsinks" = "$sinks" ]; then echo "ok   $fx $mode: $got [$gsinks]"
  else echo "FAIL $fx $mode: got $got [$gsinks], want $want [$sinks]"; fail=1; fi
done <<'CASES'
sink_exit static 2 spawn
child_returns static 3 -
escape_caught equiv 3 -
escape_caught runtime 2 spawn
escape_uncaught equiv 2 spawn
escape_uncaught static 3 -
o0_slot static 2 spawn
o0_escape static 3 -
indirect_child static 3 -
param_child param 2 spawn
param_child static 3 -
escape_cleanup_above equiv 2 spawn
escape_cleanup_above coarse 3 main
tail_child static 3 -
CASES
exit $fail
