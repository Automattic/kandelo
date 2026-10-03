#!/usr/bin/env bash
# run.sh <label> <link> <oracle|-> [fpa rules...]   (env GEN=ids.tsv to generalize)
set -u
D=$PWD/.context/fpr2; H=$(rustc -vV | awk '/^host/ {print $2}')
FPA=tools/fork-sink-research/fpa/target/$H/release/fpa; FSA=tools/fork-sink-research/fsa/target/$H/release/fsa
label=$1; link=$2; oracle=$3; shift 3
B=$D/shims/links/$link
R=(); for r in "$@"; do R+=(--rule "$r"); done
env FPA_GENERALIZE=${GEN:-} ${DLC:+FPA_IGNORE_DYNLINK=1} $FPA --wasm $B.wasm --map $B.map --inputs $B.inputs --side-dir $D/shims/side --aliases ${ALIASES:-$D/runtime/aliases.tsv} "${R[@]}" --mode registry --census ${CENSUS:-0} --cuts 0 --export-targets $D/$label.itargets registry > $D/$label.fpa.txt 2>&1 || { echo "$label fpa failed"; tail -3 $D/$label.fpa.txt; exit 1; }
OA=(); [ "$oracle" != - ] && OA=(--oracle $oracle)
$FSA --wasm $B.wasm --itargets $D/$label.itargets --registries --param --cancel --exc equiv --signal-policy sig ${DLC:+--dlopen-contract} ${CLMAP:+--cleanup-map $D/$label.itargets.cleanup --jmp-map $D/$label.itargets.jmp} "${OA[@]}" --show-open 40 --out-set $D/$label.set > $D/$label.fsa.txt 2>&1
echo "$label: $(grep -E '^(instrumented_today|instrumented_sink)' $D/$label.fsa.txt | tr '\n' ' ') $(grep -o 'oracle_stacks.*' $D/$label.fsa.txt) | $(grep -E '^casts:' $D/$label.fpa.txt)"
