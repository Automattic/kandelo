#!/usr/bin/env bash
set -euo pipefail
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)
root="$repo_root/third_party/node-core"
hdr="$root/upstream/histogram-reference/deps/histogram"
: "${ELD_CONTROL_OUT:?Set an absolute private evidence directory}"
: "${HISTOGRAM_NATIVE_NODE:?Set the exact pinned native executable}"
: "${HISTOGRAM_NODE_SOURCE:?Set the exact pinned source tree}"
mkdir -p "$ELD_CONTROL_OUT"
python3 "$root/tests/event-loop-delay/generate-reference.py" "$ELD_CONTROL_OUT/reference-check.h"
python3 - "$root" "$ELD_CONTROL_OUT" <<'PY'
from pathlib import Path
import hashlib,sys
import json
root,out=map(Path,sys.argv[1:])
identity=json.loads((root/'event-loop-delay-source-identities.json').read_text())
target=json.loads((root.parents[1]/'packages/registry/node-compat/target.json').read_text())
assert identity['version']==target['version'] and identity['sourceCommit']==target['source']['commit']
for name,digest in identity['files'].items():
    assert hashlib.sha256((root/'upstream/event-loop-delay-reference'/name).read_bytes()).hexdigest()==digest,name
source=(root/'tests/histogram-binding/addon.cc').read_text()
assert source.count('NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)')==1
(out/'histogram-addon-control.inc').write_text(source.replace('NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)',''))
PY
cc -std=c11 -O2 -I"$hdr/include" -c "$hdr/src/hdr_histogram.c" -o "$ELD_CONTROL_OUT/hdr.o"
c++ -std=c++20 -O2 -pthread -I"$root" -I"$hdr/include" -I"$ELD_CONTROL_OUT" \
  "$root/histogram-owner.cc" "$root/tests/event-loop-delay/owner-control.cc" \
  "$ELD_CONTROL_OUT/hdr.o" -o "$ELD_CONTROL_OUT/owner-control"
"$ELD_CONTROL_OUT/owner-control"
c++ -std=c++20 -O2 -pthread -shared -undefined dynamic_lookup \
  -I"$HISTOGRAM_NODE_SOURCE/src" -I"$HISTOGRAM_NODE_SOURCE/deps/uv/include" \
  -I"$root" -I"$hdr/include" -I"$ELD_CONTROL_OUT" \
  "$root/histogram-owner.cc" "$root/histogram-window.cc" \
  "$root/tests/event-loop-delay/addon.cc" "$ELD_CONTROL_OUT/hdr.o" -o "$ELD_CONTROL_OUT/eld.node"
ELD_CONTROL_ADDON="$ELD_CONTROL_OUT/eld.node" "$HISTOGRAM_NATIVE_NODE" --expose-internals \
  "$root/tests/event-loop-delay/live-control.cjs"
ELD_CONTROL_ADDON="$ELD_CONTROL_OUT/eld.node" python3 - "$HISTOGRAM_NATIVE_NODE" "$root/tests/event-loop-delay/live-control.cjs" "$ELD_CONTROL_OUT" <<'PY'
import json,subprocess,sys
from pathlib import Path
node,fixture,out=sys.argv[1:]
records=[]
for api in ['reference','candidate']:
    for mode in ['interval','iteration']:
        result=subprocess.run([node,'--expose-internals',fixture,'--idle',api,mode],capture_output=True,text=True,timeout=5)
        assert result.returncode==0,(api,mode,result.returncode,result.stderr)
        value=json.loads(result.stdout)
        assert value=={'count':'0','enabledAgain':False},(api,mode,value)
        records.append({'api':api,'mode':mode,'result':value,'deadlineSeconds':5,'exitCode':result.returncode})
Path(out,'unref-exit.json').write_text(json.dumps(records,indent=2)+'\n')
print('4 real native unref-only process exit controls passed')
PY
