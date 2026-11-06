#!/usr/bin/env bash
set -euo pipefail
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)
owner_root="$repo_root/third_party/node-core"
hdr_root="$owner_root/upstream/histogram-reference/deps/histogram"
: "${HISTOGRAM_BINDING_OUT:?Set a private evidence directory}"
: "${HISTOGRAM_NATIVE_NODE:?Set the exact pinned native Node executable}"
: "${HISTOGRAM_NODE_SOURCE:?Set the exact pinned Node source tree}"
mkdir -p "$HISTOGRAM_BINDING_OUT"
python3 "$owner_root/generate-histogram-owner.py" --check
cc -std=c11 -O2 -I"$hdr_root/include" -c "$hdr_root/src/hdr_histogram.c" -o "$HISTOGRAM_BINDING_OUT/hdr.o"
c++ -std=c++20 -O2 -pthread -shared -undefined dynamic_lookup \
  -I"$HISTOGRAM_NODE_SOURCE/src" -I"$hdr_root/include" -I"$owner_root" \
  "$owner_root/histogram-owner.cc" "$owner_root/histogram-window.cc" \
  "$owner_root/tests/histogram-binding/addon.cc" "$HISTOGRAM_BINDING_OUT/hdr.o" \
  -o "$HISTOGRAM_BINDING_OUT/histogram.node"
HISTOGRAM_BINDING_ADDON="$HISTOGRAM_BINDING_OUT/histogram.node" \
  "$HISTOGRAM_NATIVE_NODE" --expose-internals "$owner_root/tests/histogram-binding/public-control.cjs" \
  > "$HISTOGRAM_BINDING_OUT/candidate.tsv" 2> "$HISTOGRAM_BINDING_OUT/candidate.stderr"
"$HISTOGRAM_NATIVE_NODE" "$owner_root/tests/histogram/native-control.js" > "$HISTOGRAM_BINDING_OUT/native.tsv"
python3 - "$HISTOGRAM_BINDING_OUT" "$owner_root/tests/histogram/compare-values.py" <<'PY'
import json,math,sys
from pathlib import Path
root=Path(sys.argv[1])
def read(name):
    return {k:json.loads(v) for k,v in (line.split('\t',1) for line in (root/name).read_text().splitlines())}
exec(Path(sys.argv[2]).read_text())
a,b=read('candidate.tsv'),read('native.tsv');compare(a,b)
report={'comparedPublicRows':len(b),'source':'complete unchanged pinned internal/histogram.js',
        'nativeOwner':'actual portable HDR/statistics/shared ownership',
        'numericComparison':'exact public binary64 Number/BigInt/CBOR fields; tolerance only stats/cdf/meanCI/pair/QRDE quantiles/densities',
        'hostTransport':'test-only N-API, asynchronous QRDE work',
        'sameProcessEngineClone':'not validated; explicit native material alias control substituted',
        'guestProductsAndFourHosts':'not built or validated'}
(root/'report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
PY
