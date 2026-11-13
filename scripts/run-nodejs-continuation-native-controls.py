#!/usr/bin/env python3
"""Observe the pinned native continuation contracts without guest substitutes."""
from pathlib import Path
import hashlib
import json
import subprocess
import sys
import tempfile
program=Path(sys.argv[1]).resolve();report_path=Path(sys.argv[2]);data=program.read_bytes()
expected='533bd644c5ae0e0ea3a80e433aad16b817447ccba1e1eea701875eac80cb75d4'
assert hashlib.sha256(data).hexdigest()==expected,'native reference identity mismatch'
fixture=Path('tests/nodejs/upstream/continuation-shared-controls.js')
base="const internalBinding=require('internal/test/binding').internalBinding,binding=internalBinding('async_context_frame');"
setup=base+"const get=binding.getContinuationPreservedEmbedderData,set=binding.setContinuationPreservedEmbedderData;"
source=base+"const enqueue=internalBinding('task_queue').enqueueMicrotask,load=require,collect=()=>gc();\n"+fixture.read_text()+"\nrunSharedContinuationControls().then(()=>{console.log(JSON.stringify({cases:observations.length,failures,observations}));if(failures)process.exitCode=1},error=>{console.error(error);process.exitCode=2});"
cases=[('shared',[],source),
 ('disabled-option',['--no-async-context-frame'],setup+"const Frame=require('internal/async_context_frame');const enabled=Frame.enabled;set('raw');const work=Promise.resolve().then(()=>get());set('root');work.then(captured=>console.log(JSON.stringify({enabled,captured,outside:get()})));"),
 ('uncaught-microtask-context',[],setup+"process.on('uncaughtException',error=>console.log(JSON.stringify({message:error.message,framePresent:get()!==undefined,frame:get()})));set('captured');internalBinding('task_queue').enqueueMicrotask(()=>{throw Error('CPED_ERROR_REFERENCE')});set('outside');")]
work=Path(tempfile.mkdtemp(prefix='continuation-native.',dir='.scratch')).resolve();runs=[]
for name,flags,code in cases:
 assert hashlib.sha256(program.read_bytes()).hexdigest()==expected,'native reference changed before execution'
 r=subprocess.run([str(program),'--no-warnings','--expose-gc','--expose-internals',*flags,'-e',code],cwd=work,env={'PATH':'/usr/bin:/bin','LANG':'C','TZ':'UTC'},capture_output=True,text=True,timeout=30)
 runs.append({'name':name,'flags':flags,'sourceSha256':hashlib.sha256(code.encode()).hexdigest(),'exitCode':r.returncode,'stdout':r.stdout,'stderr':r.stderr})
report_path.write_text(json.dumps({'scope':'Native reference attempt before shared-result validation','programSha256':expected,'runs':runs},indent=2)+'\n')
shared=json.loads(runs[0]['stdout'])
report={'scope':'Native20raw plus4active original consumers after real native bootstrap; guest source consumers remain guarded before startup','program':{'path':str(program),'bytes':len(data),'sha256':expected},'fixtureSha256':hashlib.sha256(fixture.read_bytes()).hexdigest(),'detail':shared,'runs':runs}
report_path.write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({'cases':shared['cases'],'failures':shared['failures'],'additional':runs[1:]}))
assert all(r['exitCode']==0 and r['stderr']=='' for r in runs)
assert shared['cases']==24 and shared['failures']==0
assert json.loads(runs[1]['stdout'])=={'enabled':False,'captured':'raw','outside':'root'}
