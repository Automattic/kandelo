from pathlib import Path
import subprocess,pty,os,termios,selectors,time,json,hashlib,resource
test_root=Path(__file__).resolve().parent;r=Path(os.environ['TTY_OUTPUT_TEST_REPO']);o=Path(os.environ['TTY_OUTPUT_CONTROL_DIR']);node=Path(os.environ['NODE26_REFERENCE']);assert hashlib.sha256(node.read_bytes()).hexdigest()=='533bd644c5ae0e0ea3a80e433aad16b817447ccba1e1eea701875eac80cb75d4';resource.setrlimit(resource.RLIMIT_CORE,(0,0));runs=[];outputs={}
for mode in ['native','candidate']:
 master,slave=pty.openpty();termios.tcsetwinsize(master,(37,113));read,write=os.pipe();env=dict(os.environ);[env.pop(k,None)for k in ['FORCE_COLOR','NO_COLOR','NODE_DISABLE_COLORS','COLORTERM','CI','TERM_PROGRAM','TMUX']];env.update(REPORT_FD=str(write),TERM='xterm-256color');cmd=[str(node),'--expose-internals',str(test_root/'control.cjs'),mode];p=subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=slave,stderr=subprocess.PIPE,pass_fds=(write,),env=env);os.close(slave);os.close(write);selector=selectors.DefaultSelector();selector.register(read,selectors.EVENT_READ,'report');selector.register(master,selectors.EVENT_READ,'tty');selector.register(p.stderr,selectors.EVENT_READ,'error');buffers={'report':b'','tty':b'','error':b''};started=time.monotonic();timed=False;ready=False;seen=0
 while selector.get_map():
  if time.monotonic()-started>10:timed=True;p.kill();break
  for key,_ in selector.select(.1):
   try:data=os.read(key.fd,65536)
   except OSError:data=b''
   if not data:selector.unregister(key.fileobj);continue
   buffers[key.data]+=data
   if key.data=='report':
    lines=buffers['report'].splitlines()
    for line in lines[seen:]:
     try:packet=json.loads(line)
     except json.JSONDecodeError:break
     seen+=1
     if packet.get('ready'):
      ready=True;termios.tcsetwinsize(master,(43,147));p.stdin.write(b'resize\n');p.stdin.flush()
  if p.poll() is not None and not selector.get_map():break
 try:p.wait(timeout=1)
 except subprocess.TimeoutExpired:p.kill();p.wait();timed=True
 p.stdin.close();p.stderr.close();os.close(read);os.close(master);selector.close()
 for key,data in buffers.items():(o/(mode+'.'+key)).write_bytes(data)
 packets=[json.loads(line)for line in buffers['report'].splitlines()];rows=next((packet['rows']for packet in packets if 'rows'in packet),None);runs.append({'mode':mode,'command':cmd,'exit':p.returncode,'timedOut':timed,'reaped':p.poll()is not None,'actualPty':True,'ready':ready,'comparisonRows':len(rows)if rows else 0})
 if rows:outputs[mode]=rows
(o/'runs.json').write_text(json.dumps(runs,indent=2)+'\n');assert all(v['exit']==0 and not v['timedOut'] for v in runs),runs
assert len(outputs['native'])==len(outputs['candidate']);diff=[{'native':n,'candidate':c}for n,c in zip(outputs['native'],outputs['candidate']) if n!=c];(o/'differences.json').write_text(json.dumps(diff,indent=2)+'\n');print(json.dumps({'nativeGroups':len(outputs['native']),'matching':len(outputs['native'])-len(diff),'differences':len(diff),'ttyBytesEqual':(o/'native.tty').read_bytes()==(o/'candidate.tty').read_bytes(),'scope':'Actual host PTY, production WindowSize helper and JS owner over native stream/fd/error dependencies; not guest'}));assert not diff;assert(o/'native.tty').read_bytes()==(o/'candidate.tty').read_bytes()
