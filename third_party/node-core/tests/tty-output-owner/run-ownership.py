from pathlib import Path
import pty,os,subprocess,json,hashlib,selectors,time,termios
test_root=Path(__file__).resolve().parent;r=Path(os.environ['TTY_OUTPUT_TEST_REPO']);out=Path(os.environ['TTY_OUTPUT_CONTROL_DIR']);node=Path(os.environ['NODE26_REFERENCE']);assert hashlib.sha256(node.read_bytes()).hexdigest()=='533bd644c5ae0e0ea3a80e433aad16b817447ccba1e1eea701875eac80cb75d4'
results={};runs=[];payloads={}
for mode in ('native','candidate'):
 master,slave=pty.openpty();attrs=termios.tcgetattr(slave);attrs[3]&=~termios.ECHO;termios.tcsetattr(slave,termios.TCSANOW,attrs)
 with (out/(mode+'-ownership.report')).open('wb') as report:
  env=dict(os.environ,REPORT_FD=str(report.fileno()));cmd=[str(node),str(test_root/'ownership.cjs'),mode]
  p=subprocess.Popen(cmd,stdin=slave,stdout=slave,stderr=subprocess.PIPE,pass_fds=(report.fileno(),),env=env);os.close(slave)
  timed=False;payload=b'';error=b'';started=time.monotonic();acknowledged=False;selector=selectors.DefaultSelector();selector.register(master,selectors.EVENT_READ,'tty');selector.register(p.stderr,selectors.EVENT_READ,'error')
  while selector.get_map():
   if time.monotonic()-started>10:timed=True;p.kill();break
   for key,_ in selector.select(.1):
    try:data=os.read(key.fd,65536)
    except OSError:data=b''
    if not data:selector.unregister(key.fileobj);continue
    if key.data=='tty':
     payload+=data
     if payload==b'ABCD' and not acknowledged:os.write(master,b'\n');acknowledged=True
    else:error+=data
  try:p.wait(timeout=1)
  except subprocess.TimeoutExpired:p.kill();p.wait();timed=True
  p.stderr.close();selector.close()
 os.close(master);(out/(mode+'-ownership.error')).write_bytes(error);payloads[mode]=payload;(out/(mode+'-ownership.tty')).write_bytes(payload)
 packet=json.loads((out/(mode+'-ownership.report')).read_text());results[mode]=packet;runs.append({'mode':mode,'command':cmd,'exit':p.returncode,'timedOut':timed,'reaped':p.poll() is not None,'actualSharedStdinStdoutPty':True,'actualBytesAcknowledgedBeforeLastSlaveClose':acknowledged})
(out/'ownership-runs.json').write_text(json.dumps(runs,indent=2)+'\n')
assert all(x['exit']==0 and not x['timedOut'] for x in runs),runs
assert results['native']['rows']==results['candidate']['rows'],results
assert payloads['native']==payloads['candidate']==b'ABCD',payloads
print(json.dumps({'nativeGroups':len(results['native']['rows']),'matching':len(results['candidate']['rows']),'actualPtyBytes':payloads['native'].decode(),'source':'actual production OutputHandle through NAPI versus pinned native TTY; no guest claim'}))
