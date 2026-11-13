from pathlib import Path
import hashlib,json,subprocess,sys,tempfile
if len(sys.argv)!=3:raise SystemExit('usage: run-nodejs-lazy-data-native-controls.py <authenticated-native-node> <report.json>')
def identity(p):
 p=Path(p);b=p.read_bytes();return {'path':str(p),'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()}
fixtures=[Path('tests/nodejs/upstream/lazy-data-native-prefix.cjs'),Path('tests/nodejs/upstream/lazy-data-shared-controls.js')]
source=fixtures[0].read_text().replace('// @shared-native-lazy-data-controls',fixtures[1].read_text())
work=Path(tempfile.mkdtemp(prefix='node-lazy-native.',dir='.scratch'));script=work/'reference.cjs';script.write_text(source)
p=Path(sys.argv[1]).resolve();native=identity(p);assert native['bytes']==147346864 and native['sha256']=='533bd644c5ae0e0ea3a80e433aad16b817447ccba1e1eea701875eac80cb75d4'
flags=['--no-warnings','--no-node-snapshot','--expose-internals','--expose-gc'];r=subprocess.run([str(p),*flags,str(script.resolve())],env={'PATH':'/usr/bin:/bin','LANG':'C','TZ':'UTC'},capture_output=True,text=True,timeout=60)
d={'native':native,'fixtures':[identity(f)for f in fixtures],'generatedFixture':identity(script),'flags':flags,'result':{'exitCode':r.returncode,'stdout':r.stdout,'stderr':r.stderr}}
if r.returncode==0:d['detail']=json.loads(r.stdout)
Path(sys.argv[2]).write_text(json.dumps(d,indent=2)+'\n');print(json.dumps({'code':r.returncode,'cases':d.get('detail',{}).get('cases'),'failures':d.get('detail',{}).get('failures'),'stderr':r.stderr[:100]}));assert r.returncode==0 and not r.stderr and not d['detail']['failures']
