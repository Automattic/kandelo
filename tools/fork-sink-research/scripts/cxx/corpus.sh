#!/usr/bin/env bash
# corpus.sh <variant-label> [fpa rules...]   (generalized types, new aliases)
set -u
V=$1; shift
FPR=/Users/brandon/conductor/workspaces/kandelo/ljubljana/.context/fpr; O=$FPR/oracle
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
export CENSUS=0 ALIASES=$PWD/.context/cxx/aliases.tsv
one() {
  p=$1; shift
  FPA_GENERALIZE=${GEN-$PWD/.context/cxx/ids.tsv} .context/cxx/census.sh $V-$p ${LINK[$p]} "$@" > /dev/null
  OA=(); [ -n "${ORACLE[$p]:-}" ] && OA=(--oracle "${ORACLE[$p]}")
  .context/cxx/fsa.sh $V-$p-sig ${LINK[$p]} .context/cxx/$V-$p.itargets --signal-policy sig "${OA[@]}" > /dev/null
  echo "$p $(grep -E '^(instrumented_today|instrumented_sink|oracle_unsound)' .context/cxx/$V-$p-sig.fsa.txt | tr '\n' ' ') | $(grep -E '^unknown registries' .context/cxx/$V-$p.census.txt | cut -c1-160)"
}
PROGS=(${PROGS:-foot git git-remote-http bash python ruby waybar qtgallery php php-fpm})
i=0
for p in "${PROGS[@]}"; do one $p "$@" & i=$((i+1)); [ $((i % 4)) = 0 ] && wait; done; wait
