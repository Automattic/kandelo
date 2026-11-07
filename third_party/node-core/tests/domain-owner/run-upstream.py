"""Explicit focused Domain native/source controls; no global setup or guest suite."""
from pathlib import Path
import subprocess,hashlib,json,sys,shlex,re
node=Path(sys.argv[1]).resolve();upstream=Path(sys.argv[2]).resolve();output=Path(sys.argv[3]).resolve();output.mkdir(parents=True,exist_ok=True)
assert hashlib.sha256(node.read_bytes()).hexdigest()=='533bd644c5ae0e0ea3a80e433aad16b817447ccba1e1eea701875eac80cb75d4'
names=['enter-exit','ee','ee-implicit','ee-error-listener','nexttick','multiple-errors','multi','promise','timer','safe-exit','error-types','stack-empty-in-process-uncaughtexception']
preload=Path(__file__).with_name('upstream-preload.cjs');rows=[]
assert 'function _createNodeDomainPlatform(platform)'in Path(__file__).parents[2].joinpath('node-core.js').read_text(),'Candidate Domain bundle generation has not completed; do not run against stale source'

for name in names:
 source=upstream/'test/parallel'/('test-domain-'+name+'.js');flags=[]
 for line in source.read_text().splitlines():
  if line.startswith('// Flags:'):flags+=shlex.split(line[len('// Flags:'):])
 for mode in ['native','candidate-component']:
  args=[str(node),'--expose-internals']+flags+(['--require',str(preload)]if mode=='candidate-component'else[])+[str(source)]
  try:
   p=subprocess.run(args,capture_output=True,timeout=20);exit=p.returncode;stdout=p.stdout;stderr=p.stderr;status='pass'if exit==0 else'failure'
  except subprocess.TimeoutExpired as error:exit=None;stdout=error.stdout or b'';stderr=error.stderr or b'';status='timeout'
  key=name+'-'+mode;(output/(key+'.stdout')).write_bytes(stdout);(output/(key+'.stderr')).write_bytes(stderr)
  rows.append({'name':name,'mode':mode,'source':str(source),'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'declaredFlags':flags,'command':args,'exit':exit,'status':status})
 (output/'report.json').write_text(json.dumps({'scope':'Unchanged targeted Domain source tests over actual native Node dependencies; not Kandelo guest/runtime evidence','nativeSha256':hashlib.sha256(node.read_bytes()).hexdigest(),'preloadSha256':hashlib.sha256(preload.read_bytes()).hexdigest(),'rows':rows},indent=2)+'\n')
print(json.dumps({'processes':len(rows),'passes':sum(row['status']=='pass'for row in rows),'failures':[{'name':r['name'],'mode':r['mode'],'status':r['status'],'exit':r['exit']}for r in rows if r['status']!='pass'],'runtimeConformance':False}))
sys.exit(0 if all(row['status']=='pass'for row in rows)else 1)
