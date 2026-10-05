#!/usr/bin/env bash
# Plugin + musl facts + forced source rebuild of the corpus (dev shell).
set -uo pipefail
D=$PWD/.context/fpr2; S=tools/fork-sink-research/fpr/scripts
bash $S/build-plugin.sh || exit 1
bash $S/runtime-side.sh $D/shims $D/runtime
FORCE=1 bash $S/build-corpus.sh $D/shims $D/socache ${PROGS:-quickshell foot git}
.context/fpr2/libcxx-facts.sh $(ls -t $D/shims/links/quickshell-*.inputs | head -1) > $D/libcxx-aliases.tsv
cat $D/runtime/aliases.tsv $D/libcxx-aliases.tsv > $D/aliases-all.tsv
