#!/usr/bin/env bash
# Rebuild plugin + all research captures from scratch (under dev shell).
set -uo pipefail
D=$PWD/.context/fpr2; S=tools/fork-sink-research/fpr/scripts
bash $S/build-plugin.sh || exit 1
rm -rf $D/shims $D/runtime $D/socache
FPR_PLUGIN=$D/KandeloCallTypes.dylib bash $S/make-shims.sh $D/shims || exit 1
bash $S/runtime-side.sh $D/shims $D/runtime
bash $S/build-corpus.sh $D/shims $D/socache ${PROGS:-foot git}
