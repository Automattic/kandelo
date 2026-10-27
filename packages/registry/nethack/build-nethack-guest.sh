#!/bin/sh
# Build NetHack inside a Kandelo build machine (see build-nethack.sh).
#
# The prepared source tree is mounted at /build and ncurses at
# /deps/ncurses. Everything here runs on the wasm32 target: the generators
# (makedefs, dgn_comp, lev_comp, dlb) are compiled with the guest compiler
# and run in the same machine, so the headers and data files they write
# describe the target the game runs on.
set -eu

JOBS="${NETHACK_JOBS:-4}"
cd /build

# The build image has no yacc or lex. Upstream ships the generated parsers
# in sys/share for this case; copied after the grammars, they are newer
# than them, so make uses them as they are.
cp sys/share/dgn_yacc.c sys/share/dgn_lex.c \
    sys/share/lev_yacc.c sys/share/lev_lex.c util/
cp sys/share/dgn_comp.h sys/share/lev_comp.h include/

make -j"$JOBS" CC=cc LINK=cc -C util makedefs dgn_comp lev_comp dlb
make -j"$JOBS" CC=cc LINK=cc -C dat all
make CC=cc LINK=cc dlb
make -j"$JOBS" CC=cc LINK=cc -C src nethack

test -f src/nethack
test -f dat/nhdat
