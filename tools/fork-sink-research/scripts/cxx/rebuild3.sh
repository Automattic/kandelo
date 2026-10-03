#!/usr/bin/env bash
# From-scratch research capture: plugin, shims, musl facts, corpus, libc++ facts.
set -uo pipefail
D=$PWD/.context/fpr2; S=tools/fork-sink-research/fpr/scripts
bash $S/build-plugin.sh || exit 1
rm -rf $D/shims $D/runtime $D/socache
FPR_PLUGIN=$D/KandeloCallTypes.dylib bash $S/make-shims.sh $D/shims || exit 1
bash $S/runtime-side.sh $D/shims $D/runtime
bash $S/build-corpus.sh $D/shims $D/socache ${PROGS:-foot git quickshell}
.context/fpr2/libcxx-facts.sh $(ls -t $D/shims/links/quickshell-*.inputs | head -1) > $D/libcxx-aliases.tsv
cat $D/runtime/aliases.tsv $D/libcxx-aliases.tsv > $D/aliases-all.tsv
