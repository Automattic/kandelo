#!/usr/bin/env bash
# Compare two wasm objects, ignoring only private local label numbering
# (.L.str.N etc.) and the file name header.
norm() { wasm-objdump -x -d "$1" 2>/dev/null | sed -e 1,2d -e 's/^ *[0-9a-f]*://' -e 's/\.L\.[A-Za-z_]*\(\.[0-9]*\)*/.L.X/g' -e 's/\.L[A-Za-z_]*[0-9]\+/.L.X/g'; }
cmp -s <(norm "$1") <(norm "$2") && echo SAME || echo DIFF
