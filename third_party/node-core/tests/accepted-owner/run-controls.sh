#!/usr/bin/env bash
set -euo pipefail
# No setup, resolver, compilation, engine/product build or overall suite.
repo_root=$(cd "$(dirname "$0")/../../../.." && pwd)
: "${NODE26_REFERENCE:?Exact audited native Node26 binary required}"
: "${TCP_ACCEPT_CONTROL_DIR:?Fresh evidence directory required}"
mkdir -p "$TCP_ACCEPT_CONTROL_DIR"
export TCP_ACCEPT_CONTROL_REPORT="$TCP_ACCEPT_CONTROL_DIR/component-report.json"
python3 - "$repo_root" <<'PY'
from pathlib import Path
import os,hashlib,subprocess,sys,json
root=Path(sys.argv[1]);node=Path(os.environ['NODE26_REFERENCE']);out=Path(os.environ['TCP_ACCEPT_CONTROL_DIR'])
assert hashlib.sha256(node.read_bytes()).hexdigest()=='533bd644c5ae0e0ea3a80e433aad16b817447ccba1e1eea701875eac80cb75d4'
runs=[]
for name,script in [('component','third_party/node-core/tests/accepted-owner/control.cjs'),('native-reference','third_party/node-core/tests/socket-owner/lease-native-reference.cjs')]:
 try:
  p=subprocess.run([str(node),'--expose-internals',str(root/script)],capture_output=True,timeout=15)
  (out/(name+'.stdout')).write_bytes(p.stdout);(out/(name+'.stderr')).write_bytes(p.stderr)
  runs.append(dict(name=name,exit=p.returncode,timedOut=False))
 except subprocess.TimeoutExpired as e:
  (out/(name+'.stdout')).write_bytes(e.stdout or b'');(out/(name+'.stderr')).write_bytes(e.stderr or b'')
  runs.append(dict(name=name,exit=None,timedOut=True))
(out/'runs.json').write_text(json.dumps(runs,indent=2)+'\n')
assert all(run['exit']==0 and not run['timedOut']for run in runs),runs
print(json.dumps(dict(runs=runs,scope='Native reference + JS publication component; candidate SpiderMonkey init/watch unexecuted')))
PY
