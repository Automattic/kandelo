from pathlib import Path
import subprocess,os,json,pty,tty,hashlib
repo=Path(os.environ['FD_PUBLISH_REPO']);out=Path(os.environ['FD_PUBLISH_EVIDENCE']);ev=out/'controls-r1';ev.mkdir(exist_ok=False);node=Path(os.environ['NODE26_REFERENCE']);assert hashlib.sha256(node.read_bytes()).hexdigest()=='533bd644c5ae0e0ea3a80e433aad16b817447ccba1e1eea701875eac80cb75d4';rows=[];payload=bytes([65,0,255,66])
for mode in ['generic-promise','terminal-promise','terminal-callback']:
 for poison in ['public-from','valueOf','iterator']:
  for subject in ['native','before','after']:
   command=[str(node),'--expose-internals',str(repo/'third_party/node-core/tests/fd-input-publication/control.cjs'),subject,mode,poison]
   master=slave=None
   if mode=='generic-promise':proc=subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=os.environ)
   else:master,slave=pty.openpty();tty.setraw(slave);proc=subprocess.Popen(command,stdin=slave,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=os.environ);os.close(slave);os.write(master,payload)
   try:
    stdout,stderr=proc.communicate(payload if mode=='generic-promise'else None,timeout=10);code=proc.returncode
   except subprocess.TimeoutExpired:proc.kill();stdout,stderr=proc.communicate();code=None
   finally:
    if master is not None:os.close(master)
   name='-'.join([mode,poison,subject]);(ev/(name+'.stdout')).write_bytes(stdout);(ev/(name+'.stderr')).write_bytes(stderr)
   try:result=json.loads(stdout)
   except Exception:result=None
   valid=code==0 and result is not None and result['error']is None and result['hookCalls']==0 and result['hex']==payload.hex() and result['retainsNativeSpan']
   row={'mode':mode,'poison':poison,'subject':subject,'command':command,'exit':code,'result':result,'matchesTargetByteOwner':valid};rows.append(row);(ev/'report.json').write_text(json.dumps({'rows':rows,'newCompiles':0,'guestValidated':False},indent=2)+'\n')
   if subject!='before':assert valid,row
report={'rows':rows,'nativeSubjects':9,'nativePassed':sum(x['matchesTargetByteOwner']for x in rows if x['subject']=='native'),'candidateSubjects':9,'candidatePassed':sum(x['matchesTargetByteOwner']for x in rows if x['subject']=='after'),'baselineMatched':sum(x['matchesTargetByteOwner']for x in rows if x['subject']=='before'),'newCompiles':0,'guestValidated':False};(ev/'report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({k:v for k,v in report.items()if k!='rows'}))
