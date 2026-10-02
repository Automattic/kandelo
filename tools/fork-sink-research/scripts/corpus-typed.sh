#!/usr/bin/env bash
# Typed variant of corpus.sh: export fpa (plugin v3 side files) indirect
# targets for each link, then run fsa with them.
#   corpus-typed.sh <out-dir> <fpa-mode: registry|registry-flow> [program...]
set -uo pipefail
OUT=$1; MODE=$2; shift 2
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
FPR=/Users/brandon/conductor/workspaces/kandelo/ljubljana/.context/fpr
HOST=$(rustc -vV | awk '/^host/ {print $2}')
F=$ROOT/tools/fork-sink-research/fsa/target/$HOST/release/fsa
FPA=$ROOT/tools/fork-sink-research/fpa/target/$HOST/release/fpa
L=$FPR/shims/links
O=$FPR/oracle
declare -A LINK ORACLE
LINK[bash]=bash-84131-1790914960;            ORACLE[bash]=$O/bash.stacks
LINK[git]=git-85486-1790914202;              ORACLE[git]=$O/git.stacks
LINK[git-remote-http]=git-remote-http-85493-1790914202
LINK[python]=python.wasm-77331-1790915985;   ORACLE[python]=$O/python.parsed
LINK[ruby]=ruby-37651-1790916729;            ORACLE[ruby]=$O/ruby.stacks
LINK[foot]=foot.wasm-16371-1790915554;       ORACLE[foot]=$O/foot.parsed
LINK[waybar]=waybar.wasm-63265-1790916337
LINK[qtgallery]=qtgallery.raw.wasm-79140-1790915998
LINK[php]=php-45856-1790918007
LINK[php-fpm]=php-fpm-58310-1790918024
LINK[quickshell]=quickshell-52651-1790915851
mkdir -p "$OUT"
for prog in "$@"; do
  B=$L/${LINK[$prog]}
  IT=$OUT/$prog.itargets.$MODE
  if [ ! -s "$IT" ]; then
    FL=(--rule cancel); [ "$MODE" = registry-flow ] && FL+=(--rule flow)
    "$FPA" --wasm $B.wasm --map $B.map --inputs $B.inputs --side-dir $FPR/shims/side --aliases $FPR/runtime/aliases.tsv "${FL[@]}" --export-targets "$IT" registry > "$OUT/$prog.fpa.$MODE.log" 2>&1
  fi
  for rs in ${RULESETS:-strict gate equiv runtime}; do
    case $rs in
      strict)  A=(--signal-policy sig) ;;
      gate)    A=(--signal-policy nothrow --registries --param --cancel) ;;
      equiv)   A=(--signal-policy nothrow --registries --param --cancel --exc equiv) ;;
      runtime) A=(--signal-policy nothrow --registries --param --cancel --exc runtime) ;;
    esac
    [ -n "${ORACLE[$prog]:-}" ] && A+=(--oracle "${ORACLE[$prog]}")
    "$F" --wasm $B.wasm --itargets "$IT" "${A[@]}" --show-open 25 --out-set "$OUT/$prog.$MODE.$rs.set" > "$OUT/$prog.$MODE.$rs.txt" 2>&1
    echo "$prog $MODE $rs exit=$? $(grep -E '^(instrumented_today|closure_same_rules_no_sinks|instrumented_sink|closed|oracle_stacks|sinks_with)' "$OUT/$prog.$MODE.$rs.txt" | tr '\n' ' ')"
  done
done
