#!/usr/bin/env python3
"""Run bounded actual process native-data controls in separate pinned children."""
from pathlib import Path
import argparse,datetime,hashlib,json,subprocess
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('native',type=Path)
parser.add_argument('report',type=Path)
args=parser.parse_args()
binary=args.native.resolve()
expected='533bd644c5ae0e0ea3a80e433aad16b817447ccba1e1eea701875eac80cb75d4'
shared_path=Path('tests/nodejs/upstream/native-data-shared-controls.js')
prefix_path=Path('tests/nodejs/upstream/native-data-native-prefix.cjs')
shared=shared_path.read_text();prefix=prefix_path.read_text()
def identity(path):
 data=path.read_bytes();return {'path':str(path),'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
runs=[];observations=[]
for index in range(12):
 source=prefix.replace('// @shared-native-data-controls',shared)+f'console.log(JSON.stringify(observeShared(sharedControls[{index}],make)));'
 # Verify the executable afresh immediately before every child.
 assert identity(binary)['sha256']==expected
 child=subprocess.run([str(binary),'--no-warnings','--no-node-snapshot','-e',source],env={'PATH':'/usr/bin:/bin','LANG':'C','TZ':'UTC'},capture_output=True,text=True,timeout=30)
 record={'index':index,'sourceSha256':hashlib.sha256(source.encode()).hexdigest(),'nativeSha256VerifiedImmediatelyBeforeChild':expected,'exitCode':child.returncode,'stdout':child.stdout,'stderr':child.stderr};runs.append(record)
 assert child.returncode==0 and child.stderr=='',record
 observations.append(json.loads(child.stdout))
report={'scope':'Twelve bounded genuine live native data property comparisons, not full native interface compatibility','completedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'binary':identity(binary),'args':['--no-warnings','--no-node-snapshot'],'environment':{'PATH':'/usr/bin:/bin','LANG':'C','TZ':'UTC'},'sourceCommit':'18b32a3b1552e199a01f1a8d9fd64aa756d3b75b','fixtureSha256':identity(shared_path)['sha256'],'fixtures':[identity(p)for p in [prefix_path,shared_path]],'runner':identity(Path(__file__)),'runs':runs,'observations':observations}
args.report.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'children':len(runs),'failures':0}))
