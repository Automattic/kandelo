#!/usr/bin/env python3
"""Compare private binding contracts with the authenticated native Node reference."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile

program=Path(sys.argv[1]).resolve()
report_path=Path(sys.argv[2])
data=program.read_bytes()
expected='533bd644c5ae0e0ea3a80e433aad16b817447ccba1e1eea701875eac80cb75d4'
assert hashlib.sha256(data).hexdigest()==expected,'native reference identity mismatch'
fixture=Path('tests/nodejs/upstream/trace-binding-shared-controls.js')
work=Path(tempfile.mkdtemp(prefix='trace-binding-native.',dir='.scratch')).resolve()
setup="const binding=require('internal/test/binding').internalBinding('trace_events');const C=binding.CategorySet;"
runs=[]
cases=[
 ('shared',"const binding=require('internal/test/binding').internalBinding('trace_events'),collect=()=>gc();\n"+fixture.read_text()+"\nconsole.log(JSON.stringify({cases:observations.length,failures,observations}));if(failures)process.exitCode=1;"),
 ('source-constructor-array-check',setup+'new C(3)'),
 ('source-proxy-array-check',setup+"new C(new Proxy(['x'],{}))"),
 ('source-handler-function-check',setup+'binding.setTraceCategoryStateUpdateHandler(3)'),
 ('source-category-buffer-string-check',setup+'binding.getCategoryEnabledBuffer(3)'),
 ('original-json-undefined-result-cast',setup+"const owner=new C(['trace.json']);owner.enable();binding.trace(105,'trace.json','function-data',undefined,()=>{});"),
 ('observer-exception-routing',setup+"const marker=Error('TRACE_OBSERVER_MARKER'),values=[];process.on('uncaughtException',error=>values.push(error===marker));binding.setTraceCategoryStateUpdateHandler(()=>{throw marker});const owner=new C(['node.async_hooks']);owner.enable();owner.disable();binding.setTraceCategoryStateUpdateHandler(()=>{});console.log(JSON.stringify({values}));"),
]
for name,source in cases:
 run_work=work/name;run_work.mkdir()
 try:
  result=subprocess.run([str(program),'--no-warnings','--expose-gc','--expose-internals','--trace-event-file-pattern='+str(run_work/'trace-${pid}-${rotation}.json'),'-e',source],cwd=run_work,env={'PATH':'/usr/bin:/bin','LANG':'C','TZ':'UTC'},capture_output=True,text=True,timeout=15)
  runs.append({'name':name,'sourceSha256':hashlib.sha256(source.encode()).hexdigest(),'exitCode':result.returncode,'stdout':result.stdout,'stderr':result.stderr})
 except subprocess.TimeoutExpired as error:
  runs.append({'name':name,'failureKind':'timeout','stdout':str(error.stdout),'stderr':str(error.stderr)})
shared=json.loads(runs[0]['stdout'])
trace=json.loads(next((work/'shared').glob('trace-*-1.json')).read_text())
projection=[{key:event[key] for key in ['cat','name','ph','id','args'] if key in event} for event in trace['traceEvents'] if event.get('cat','').startswith('trace.')]
report={'scope':'Pinned native binding reference; observer exception routing is a remaining embedding gap','program':{'path':str(program),'bytes':len(data),'sha256':expected},'fixtureSha256':hashlib.sha256(fixture.read_bytes()).hexdigest(),'detail':shared,'traceProjection':projection,'runs':runs}
report_path.write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({'cases':shared['cases'],'failures':shared['failures'],'runs':[{key:row[key] for key in ['name','exitCode','failureKind','stdout'] if key in row} for row in runs[1:]]}))
assert runs[0]['exitCode']==0 and shared['failures']==0
assert all(row.get('exitCode') ==-6 for row in runs[1:6])
assert runs[6]['exitCode']==0
