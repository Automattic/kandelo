#!/bin/sh
# The parser (bison), keyword table (gperf) and library (libtool) together.
out=$(printf '1+2*3\ntwo*three+one\n' | ./calc)
test "$out" = "7
7"
