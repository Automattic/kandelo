from pathlib import Path
import subprocess,json,hashlib,os
here=Path(__file__).resolve().parent;tree=here.parents[3];ev=Path(os.environ['TRACING_EVIDENCE_DIR']);node=Path(os.environ['NODE26_REFERENCE']);component=Path(os.environ['TRACING_COMPONENT'])
assert hashlib.sha256(node.read_bytes()).hexdigest()=='533bd644c5ae0e0ea3a80e433aad16b817447ccba1e1eea701875eac80cb75d4'
ev.mkdir(parents=True,exist_ok=False)
identities=[]
for p in [here/'control.cjs',here/'platform.cjs',here/'compare-controls.py',tree/'third_party/node-core/node-core.js',component,node]:
 identities.append({'path':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
(ev/'inputs.json').write_text(json.dumps(identities,indent=2)+'\n')
baseline=Path(os.environ['TRACING_NATIVE_BASELINE']) if os.environ.get('TRACING_NATIVE_BASELINE') else None
referenceRows={}
if baseline:
 previousInputs=json.loads((baseline/'inputs.json').read_text())
 for path in [here/'control.cjs',node]:
  original=next(x for x in previousInputs if x['path']==str(path))
  assert hashlib.sha256(path.read_bytes()).hexdigest()==original['sha256']
 referenceRows={r['kind']:r['subjects']['native'] for r in json.loads((baseline/'report.json').read_text())['rows']}
rows=[];failures=[]
for kind in ['public','snapshot','getters','events','exit-events','overlap-events','worker-events','open-error','worker-admission']:
 pair={}
 for mode in ['native','candidate']:
  out=ev/kind/mode;out.mkdir(parents=True)
  if mode=='native' and baseline:
   record=dict(referenceRows[kind]);record['reusedReference']=str(baseline/kind/'native/result.json')
   (out/'reused-reference.json').write_text(json.dumps(record,indent=2)+'\n');pair[mode]=record
   continue
  env=os.environ.copy();env['TRACING_COMPONENT']=str(component)
  command=[str(node),'--expose-internals',str(here/'control.cjs'),mode,kind]
  record={'command':command,'cwd':str(out),'timeoutSeconds':20,'status':'starting'}
  (out/'result.json').write_text(json.dumps(record,indent=2)+'\n')
  with (out/'stdout').open('w') as stdout,(out/'stderr').open('w') as stderr:
   p=subprocess.Popen(command,cwd=out,env=env,stdout=stdout,stderr=stderr,text=True)
   record['pid']=p.pid
   try:p.wait(timeout=20);record.update(exit=p.returncode,timedOut=False,status='completed')
   except subprocess.TimeoutExpired:
    p.kill();p.wait();record.update(exit=p.returncode,timedOut=True,status='timeout nonpass')
  lines=[s.removeprefix('RESULT ') for s in (out/'stdout').read_text().splitlines() if s.startswith('RESULT ')]
  record['result']=json.loads(lines[-1]) if lines else None
  path=out/'node_trace.1.log';record['fileCreated']=path.is_file();record['portableEvents']=[]
  if path.is_file():
   try:
    data=json.loads(path.read_text());record['metadataEvents']=[x for x in data['traceEvents'] if x['cat']=='__metadata'];events=[x for x in data['traceEvents'] if x['cat']!='__metadata'];record['traceEvents']=events
    for x in events:
     assert x['pid']==p.pid and isinstance(x['tid'],int) and x['tid']>0
     assert isinstance(x['ts'],(int,float)) and x['ts']>0
    record['portableEvents']=[{k:x[k] for k in ['ph','cat','name','id','args'] if k in x} for x in events]
    if kind=='worker-events':assert len({x['tid'] for x in events})==2
   except Exception as e:record['fileError']=str(e)
  if kind=='open-error':record['failedOpenDiagnostic']='Could not open trace file node_trace.1.log:' in (out/'stderr').read_text()
  (out/'result.json').write_text(json.dumps(record,indent=2)+'\n');pair[mode]=record
 equal=pair['native']['result']==pair['candidate']['result'];portable=pair['native']['portableEvents']==pair['candidate']['portableEvents']
 passed=equal and portable and all(x['exit']==0 and not x['timedOut'] and 'fileError' not in x for x in pair.values())
 if kind=='open-error':passed=equal and all(x['exit']==0 and not x['timedOut'] and x['failedOpenDiagnostic'] for x in pair.values())
 rows.append({'kind':kind,'pass':passed,'publicEqual':equal,'portableEventsEqual':portable,'subjects':pair})
 if not passed:failures.append(kind)
 (ev/'report.json').write_text(json.dumps({'rows':rows,'failures':failures,'status':'in progress'},indent=2)+'\n')
report={'rows':rows,'failures':failures,'scope':'Actual portable native process owner + exact pinned public/Console source with native Node/V8/stream/inspection/loader/process fixture dependencies; guest JSAPI/engine/lifecycle uncompiled/unexecuted. CPU fields omitted rather than fabricated; metadata/native producer/CLI/rotation/Perfetto/schema/report gaps remain.'}
(ev/'report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'groups':len(rows),'failures':failures}));raise SystemExit(bool(failures))
