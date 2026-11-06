#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
: "${ELD_CONTROL_OUT:?Set an absolute private evidence directory}"
: "${HISTOGRAM_NATIVE_NODE:?Set exact pinned native node}"
mkdir -p "$ELD_CONTROL_OUT"
python3 - "$root" "$ELD_CONTROL_OUT" <<'PY'
from pathlib import Path
import hashlib,json,sys
root,out=map(Path,sys.argv[1:]);source=(root/'event-loop-delay-native.cpp').read_text()
a=source.index('struct KandeloELDState;');b=source.index('static thread_local ',a)
(out/'eld-native-state-control.inc').write_text(source[a:b])
(out/'retained-compiled-inputs.json').write_text(json.dumps({str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in [root/'event-loop-delay-native.cpp',root/'event-loop-delay.h',root/'event-loop-delay-lifetime.h',root/'native-retained-memory.h',out/'eld-native-state-control.inc']},indent=2)+'\n')
PY
hdr="$root/upstream/histogram-reference/deps/histogram"
cc -std=c11 -O2 -I"$hdr/include" -c "$hdr/src/hdr_histogram.c" -o "$ELD_CONTROL_OUT/retained-hdr.o"
c++ -std=c++20 -O2 -pthread -I"$root" -I"$hdr/include" -I"$ELD_CONTROL_OUT" \
  "$root/histogram-owner.cc" "$root/tests/event-loop-delay/retained-control.cc" \
  "$ELD_CONTROL_OUT/retained-hdr.o" -o "$ELD_CONTROL_OUT/retained-control"
"$ELD_CONTROL_OUT/retained-control"
"$HISTOGRAM_NATIVE_NODE" --expose-internals "$root/tests/event-loop-delay/own-code-control.cjs"
