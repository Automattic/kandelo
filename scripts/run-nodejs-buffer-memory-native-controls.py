#!/usr/bin/env python3
"""Observe native detach-key contracts in the authenticated Node reference."""
from pathlib import Path
import hashlib
import json
import subprocess
import sys
import tempfile

program=Path(sys.argv[1]).resolve();report=Path(sys.argv[2])
expected='533bd644c5ae0e0ea3a80e433aad16b817447ccba1e1eea701875eac80cb75d4'
fixture=Path('tests/nodejs/upstream/buffer-detach-shared-controls.js')
source="const setDetachKey=require('internal/test/binding').internalBinding('buffer').setDetachKey,collect=()=>gc(),clone=(value,transfers)=>structuredClone(value,{transfer:transfers});\n"+fixture.read_text()+"\nrunBufferDetachControls();console.log(JSON.stringify({cases:observations.length,failures,observations}));if(failures)process.exitCode=1;"
work=Path(tempfile.mkdtemp(prefix='buffer-memory-native.',dir='.scratch')).resolve()
data=program.read_bytes();assert hashlib.sha256(data).hexdigest()==expected,'native identity mismatch'
result=subprocess.run([str(program),'--no-warnings','--expose-gc','--expose-internals','-e',source],cwd=work,env={'PATH':'/usr/bin:/bin','LANG':'C','TZ':'UTC'},capture_output=True,text=True,timeout=30)
run={'exitCode':result.returncode,'stdout':result.stdout,'stderr':result.stderr}
record={'scope':'Original native buffer.setDetachKey through real V8 transfer and structured clone; not guest binding/startup evidence','program':{'path':str(program),'bytes':len(data),'sha256':expected},'fixtureSha256':hashlib.sha256(fixture.read_bytes()).hexdigest(),'sourceSha256':hashlib.sha256(source.encode()).hexdigest(),'run':run}
report.write_text(json.dumps(record,indent=2)+'\n')
detail=json.loads(result.stdout);record['detail']=detail;report.write_text(json.dumps(record,indent=2)+'\n')
print(json.dumps({'cases':detail['cases'],'failures':detail['failures'],'exitCode':result.returncode}))
assert result.returncode==0 and result.stderr=='' and detail['cases']==12 and detail['failures']==0
