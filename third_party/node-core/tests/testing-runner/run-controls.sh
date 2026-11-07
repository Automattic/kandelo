#!/usr/bin/env bash
set -euo pipefail
# Explicit no-global-setup: no engine/dependency/product/overall build or suite.
repo_root=$(cd "$(dirname "$0")/../../../.." && pwd)
: "${NODE26_REFERENCE:?Exact audited Node26 reference executable required}"
: "${TEST_RUNNER_CONTROL_DIR:?Fresh focused evidence directory required}"
python3 - "$repo_root" "$NODE26_REFERENCE" "$TEST_RUNNER_CONTROL_DIR" <<'PY'
from pathlib import Path
import copy,hashlib,json,subprocess,sys
repo,node,out=map(Path,sys.argv[1:]);out.mkdir(parents=True,exist_ok=False)
assert hashlib.sha256(node.read_bytes()).hexdigest()=='533bd644c5ae0e0ea3a80e433aad16b817447ccba1e1eea701875eac80cb75d4'
preflight=subprocess.run(['python3',str(repo/'third_party/node-core/build.py'),'--check'],cwd=repo,capture_output=True,timeout=30)
(out/'bundle-check.stdout').write_bytes(preflight.stdout);(out/'bundle-check.stderr').write_bytes(preflight.stderr)
assert preflight.returncode==0,'bundle must match actual source before controls'
fixture=repo/'third_party/node-core/tests/testing-runner/control.cjs';rows=[]
for name in ['validation','missing-owners','explicit','glob','directory','shard','filter','empty','load-failure','test-failure','hooks','global-setup']:
 for mode in (['candidate'] if name=='missing-owners' else ['native','candidate']):
  cmd=[str(node),'--expose-internals',str(fixture),mode,name]
  try:
   r=subprocess.run(cmd,cwd=repo,capture_output=True,timeout=20);stdout,stderr,code,timeout=r.stdout,r.stderr,r.returncode,False
  except subprocess.TimeoutExpired as e:stdout,stderr,code,timeout=e.stdout or b'',e.stderr or b'',None,True
  stem=out/(name+'-'+mode);Path(str(stem)+'.stdout').write_bytes(stdout);Path(str(stem)+'.stderr').write_bytes(stderr)
  results=[]
  for line in stdout.decode(errors='replace').splitlines():
   try:
    obj=json.loads(line)
    if isinstance(obj,dict) and obj.get('scenario')==name:results.append(obj)
   except ValueError:pass
  rows.append(dict(case=name,subject=mode,exit=code,timeout=timeout,result=results[-1] if results else None,command=cmd))
(out/'runs.json').write_text(json.dumps(rows,indent=2)+'\n')
assert all(r['exit']==0 and r['result'] and not r['timeout'] for r in rows),rows
matches=[]
for name in dict.fromkeys(r['case'] for r in rows):
 if name=='missing-owners':continue  # Explicit valid-public implementation failures, not conformance passes.
 pair={r['subject']:copy.deepcopy(r['result']) for r in rows if r['case']==name}
 for value in pair.values():
  if name in ['empty','load-failure']:
   file=Path(value['events'][0]['name'])
   assert file.is_absolute() and file.parent.name.startswith('kandelo-test-runner-')
   assert file.name==('empty.mjs' if name=='empty' else 'bad.mjs')
   value['events'][0]['name']='__OWN_FIXTURE_ROOT__/'+file.name
 assert pair['native']==pair['candidate'],name
 matches.append(name)
(out/'comparison.json').write_text(json.dumps(dict(matches=matches,scope='Native process/async/stream/fs/module dependencies, not guest/four-host conformance',compiles=0,overallSuites=0),indent=2)+'\n')
print(json.dumps(dict(matchedPairs=len(matches),implementationGapDiagnostics=1,compiles=0,overallSuites=0)))
PY
