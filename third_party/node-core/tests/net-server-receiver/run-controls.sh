#!/usr/bin/env bash
set -euo pipefail
# Explicit no-global-setup: no resolver, compilation, product or overall suite.
repo_root=$(cd "$(dirname "$0")/../../../.." && pwd)
: "${NODE26_REFERENCE:?Exact audited native Node26 binary required}"
: "${NET_SERVER_CONTROL_DIR:?Fresh evidence directory required}"
mkdir -p "$NET_SERVER_CONTROL_DIR"
python3 - "$repo_root" <<'PY'
from pathlib import Path
import hashlib,json,os,subprocess,sys
repo=Path(sys.argv[1]);node=Path(os.environ['NODE26_REFERENCE']);out=Path(os.environ['NET_SERVER_CONTROL_DIR'])
assert hashlib.sha256(node.read_bytes()).hexdigest()=='533bd644c5ae0e0ea3a80e433aad16b817447ccba1e1eea701875eac80cb75d4'
preflight=subprocess.run(['python3',str(repo/'third_party/node-core/build.py'),'--check'],cwd=repo,capture_output=True,timeout=30)
(out/'bundle-check.stdout').write_bytes(preflight.stdout);(out/'bundle-check.stderr').write_bytes(preflight.stderr)
assert preflight.returncode==0,'candidate source bundle is stale; no control cases executed'
runs=[]
for mode in ['native','candidate']:
 env={**os.environ,'NET_SERVER_REPORT':str(out/(mode+'.json'))}
 command=[str(node),'--expose-internals',str(repo/'third_party/node-core/tests/net-server-receiver/control.cjs'),mode]
 try:
  result=subprocess.run(command,cwd=repo,env=env,capture_output=True,timeout=20)
  stdout,stderr=result.stdout,result.stderr;code=result.returncode;timeout=False
 except subprocess.TimeoutExpired as error:
  stdout,stderr=error.stdout or b'',error.stderr or b'';code=None;timeout=True
 (out/(mode+'.stdout')).write_bytes(stdout);(out/(mode+'.stderr')).write_bytes(stderr)
 runs.append({'mode':mode,'command':command,'exit':code,'timedOut':timeout})
(out/'runs.json').write_text(json.dumps(runs,indent=2)+'\n')
assert all(row['exit']==0 and not row['timedOut']for row in runs),runs
print(json.dumps({'runs':runs,'scope':'Focused native differential/source-component control, not guest conformance','globalSetup':0,'compiles':0,'overallSuites':0}))
PY
