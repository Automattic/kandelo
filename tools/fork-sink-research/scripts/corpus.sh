#!/usr/bin/env bash
# Run fsa over the ljubljana corpus (read-only inputs) under three rule sets.
#   corpus.sh <out-dir> [program...]
# Rule sets:
#   strict   signal handlers by signature, exceptions proved statically
#   gate     + signal-dispatch gate, musl registries, param, cancel rules
#   equiv    gate + rule 2 by run-time check only where no frame above the
#            sink can catch the escaping tag (behaviour-preserving)
#   runtime  gate + rule 2 enforced by a loud run-time check at every sink
set -uo pipefail
OUT=$1; shift
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
FPR=/Users/brandon/conductor/workspaces/kandelo/ljubljana/.context/fpr
F=$ROOT/tools/fork-sink-research/fsa/target/$(rustc -vV | awk '/^host/ {print $2}')/release/fsa
L=$FPR/shims/links
O=$FPR/oracle
declare -A WASM ORACLE
WASM[bash]=$L/bash-84131-1790914960.wasm;            ORACLE[bash]=$O/bash.stacks
WASM[git]=$L/git-85486-1790914202.wasm;              ORACLE[git]=$O/git.stacks
WASM[git-remote-http]=$L/git-remote-http-85493-1790914202.wasm
WASM[python]=$L/python.wasm-77331-1790915985.wasm;   ORACLE[python]=$O/python.parsed
WASM[ruby]=$L/ruby-37651-1790916729.wasm;            ORACLE[ruby]=$O/ruby.stacks
WASM[foot]=$L/foot.wasm-16371-1790915554.wasm;       ORACLE[foot]=$O/foot.parsed
WASM[waybar]=$L/waybar.wasm-63265-1790916337.wasm
WASM[qtgallery]=$L/qtgallery.raw.wasm-79140-1790915998.wasm
WASM[php]=$L/php-45856-1790918007.wasm
WASM[php-fpm]=$L/php-fpm-58310-1790918024.wasm
WASM[curl]=$L/curl-78483-1790914184.wasm
WASM[quickshell]=/Users/brandon/conductor/workspaces/kandelo/st-georges/.context/qsmap/quickshell.named.wasm
mkdir -p "$OUT"
for prog in "$@"; do
  for rs in ${RULESETS:-strict gate equiv runtime}; do
    case $rs in
      strict)  A=(--signal-policy sig) ;;
      gate)    A=(--signal-policy nothrow --registries --param --cancel) ;;
      equiv)   A=(--signal-policy nothrow --registries --param --cancel --exc equiv) ;;
      runtime) A=(--signal-policy nothrow --registries --param --cancel --exc runtime) ;;
    esac
    [ -n "${ORACLE[$prog]:-}" ] && A+=(--oracle "${ORACLE[$prog]}")
    "$F" --wasm "${WASM[$prog]}" "${A[@]}" --show-open 25 --out-set "$OUT/$prog.$rs.set" --out-today "$OUT/$prog.today.set" > "$OUT/$prog.$rs.txt" 2>&1
    echo "$prog $rs exit=$? $(grep -E '^(instrumented_today|closure_same_rules_no_sinks|instrumented_sink|closed|oracle_stacks)' "$OUT/$prog.$rs.txt" | tr '\n' ' ')"
  done
done
