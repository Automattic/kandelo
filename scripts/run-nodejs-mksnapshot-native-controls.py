from pathlib import Path
import hashlib,json,subprocess,sys
if len(sys.argv)!=3:raise SystemExit('usage: run-nodejs-mksnapshot-native-controls.py <authenticated-native-node> <report.json>')
p=Path(sys.argv[1]).resolve();b=p.read_bytes();sha=hashlib.sha256(b).hexdigest();assert len(b)==147346864 and sha=='533bd644c5ae0e0ea3a80e433aad16b817447ccba1e1eea701875eac80cb75d4'
f=Path('tests/nodejs/upstream/mksnapshot-live-native-controls.cjs');r=subprocess.run([str(p.resolve()),'--no-warnings','--no-node-snapshot','--expose-internals','--expose-gc',str(f)],env={'PATH':'/usr/bin:/bin','LANG':'C','TZ':'UTC'},capture_output=True,text=True,timeout=60)
out={'invocation':{'flags':['--no-warnings','--no-node-snapshot','--expose-internals','--expose-gc'],'environment':{'PATH':'/usr/bin:/bin','LANG':'C','TZ':'UTC'}},'native':{'path':str(p),'bytes':len(b),'sha256':sha},'fixture':{'path':str(f),'bytes':f.stat().st_size,'sha256':hashlib.sha256(f.read_bytes()).hexdigest()},'code':r.returncode,'stdout':r.stdout,'stderr':r.stderr}
try:out['detail']=json.loads(r.stdout)
except ValueError:pass
Path(sys.argv[2]).write_text(json.dumps(out,indent=2)+'\n');print(json.dumps({'code':r.returncode,'stderr':r.stderr,'cases':out.get('detail',{}).get('cases'),'failures':out.get('detail',{}).get('failures')}))
assert r.returncode==0 and r.stderr=='' and out['detail']['cases']==8 and out['detail']['failures']==0
