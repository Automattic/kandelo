#!/usr/bin/env python3
from pathlib import Path
import hashlib,json,subprocess,sys,tempfile
if len(sys.argv)!=3:raise SystemExit('usage: run-nodejs-function-compiler-native-controls.py <authenticated-native-node> <report.json>')
program=Path(sys.argv[1]).resolve();data=program.read_bytes();expected='533bd644c5ae0e0ea3a80e433aad16b817447ccba1e1eea701875eac80cb75d4';assert len(data)==147346864 and hashlib.sha256(data).hexdigest()==expected
paths=[Path('tests/nodejs/upstream/function-compiler-native-prefix.cjs'),Path('tests/nodejs/upstream/function-compiler-shared-controls.js')];source='\n'.join(p.read_text()for p in paths)+'\nrunFunctionCompilerControls().then(detail=>{writeSync(1,JSON.stringify(detail)+"\\n");if(detail.failures)process.exitCode=1}).catch(error=>{console.error(error);process.exitCode=1});\n'
work=Path(tempfile.mkdtemp(prefix='function-compiler-native.',dir='.scratch'));fixture=work/'controls.cjs';fixture.write_text(source)
result=subprocess.run([str(program),'--no-warnings','--no-node-snapshot','--expose-gc',str(fixture)],env={'PATH':'/usr/bin:/bin','LANG':'C','TZ':'UTC'},capture_output=True,text=True,timeout=60)
record={'scope':'Authenticated native V8 function-body compilation through original Node vm/contextify; reference only, not guest backend/startup support','native':{'path':str(program),'bytes':len(data),'sha256':expected},'fixtures':[{'path':str(p),'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}for p in paths],'sourceSha256':hashlib.sha256(source.encode()).hexdigest(),'flags':['--no-warnings','--no-node-snapshot','--expose-gc'],'result':{'exitCode':result.returncode,'stdout':result.stdout,'stderr':result.stderr}}
try:record['detail']=json.loads(result.stdout)
except ValueError:pass
Path(sys.argv[2]).write_text(json.dumps(record,indent=2)+'\n');print(json.dumps({'exitCode':result.returncode,'cases':record.get('detail',{}).get('cases'),'failures':record.get('detail',{}).get('failures'),'stderr':result.stderr}))
assert result.returncode==0 and result.stderr=='' and record['detail']['cases']==21 and record['detail']['failures']==0
