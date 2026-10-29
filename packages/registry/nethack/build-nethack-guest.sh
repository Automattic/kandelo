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

# util/Makefile does not order the headers makedefs generates (pm.h,
# onames.h) before the game objects lev_comp links, so the generators and
# the data files build one job at a time. With those headers in place,
# src/Makefile chains its own generated sources for parallel make.
make -j1 CC=cc LINK=cc -C util makedefs dgn_comp lev_comp dlb
make -j1 CC=cc LINK=cc -C dat all
make -j1 CC=cc LINK=cc dlb
make -j"$JOBS" CC=cc LINK=cc -C src nethack

test -f src/nethack
test -f dat/nhdat
