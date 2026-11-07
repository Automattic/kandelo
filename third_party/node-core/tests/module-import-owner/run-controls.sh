#!/usr/bin/env bash
set -euo pipefail
# No global setup, native compilation, engine/dependency/product build or suite.
repo_root=$(cd "$(dirname "$0")/../../../.." && pwd)
: "${NODE26_REFERENCE:?Exact audited Node26 executable required}"
: "${MODULE_IMPORT_CONTROL_DIR:?Fresh focused evidence directory required}"
python3 - "$repo_root" "$NODE26_REFERENCE" "$MODULE_IMPORT_CONTROL_DIR" <<'PY'
from pathlib import Path
import hashlib,json,subprocess,sys
repo,node,out=map(Path,sys.argv[1:]);out.mkdir(parents=True,exist_ok=False)
assert hashlib.sha256(node.read_bytes()).hexdigest()=='533bd644c5ae0e0ea3a80e433aad16b817447ccba1e1eea701875eac80cb75d4'
x=subprocess.run(['python3',str(repo/'third_party/node-core/build.py'),'--check'],cwd=repo,capture_output=True,timeout=30)
(out/'bundle-check.stdout').write_bytes(x.stdout);(out/'bundle-check.stderr').write_bytes(x.stderr)
assert x.returncode==0,'bundle must match actual source before controls'
cmd=[str(node),'--expose-internals',str(repo/'third_party/node-core/tests/module-import-owner/control.cjs')]
try:
 x=subprocess.run(cmd,cwd=repo,capture_output=True,timeout=30);stdout,stderr,code,timeout=x.stdout,x.stderr,x.returncode,False
except subprocess.TimeoutExpired as e:stdout,stderr,code,timeout=e.stdout or b'',e.stderr or b'',None,True
(out/'control.stdout').write_bytes(stdout);(out/'control.stderr').write_bytes(stderr)
results=[]
for line in stdout.decode(errors='replace').splitlines():
 try:
  obj=json.loads(line)
  if isinstance(obj,dict) and 'groups' in obj:results.append(obj)
 except ValueError:pass
report=dict(command=cmd,exit=code,timeout=timeout,result=results[-1] if results else None,scope='JS forwarding plus explicit native Node loader dependency; production C++ request/completion uncompiled/unexecuted',compiles=0,overallSuites=0)
(out/'report.json').write_text(json.dumps(report,indent=2)+'\n')
assert code==0 and not timeout and report['result']['groups']==9 and report['result']['failures']==0,report
print(json.dumps(report))
PY
