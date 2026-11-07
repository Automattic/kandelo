"""Actual native Node TTY and two real PTYs, no injected fd/brand metadata."""
import os,select,subprocess,sys,hashlib,json,ctypes,termios
from pathlib import Path
node=Path(sys.argv[1]).resolve()
assert hashlib.sha256(node.read_bytes()).hexdigest()=='533bd644c5ae0e0ea3a80e433aad16b817447ccba1e1eea701875eac80cb75d4'
libc=ctypes.CDLL(None,use_errno=True);libc.ptsname.restype=ctypes.c_char_p
def pair():
 master=libc.posix_openpt(os.O_RDWR|os.O_NOCTTY|os.O_CLOEXEC);assert master>=0
 assert libc.grantpt(master)==0 and libc.unlockpt(master)==0
 return master,os.open(libc.ptsname(master),os.O_RDWR|os.O_NOCTTY|os.O_CLOEXEC)
a,slave=pair();b,other=pair();initial=termios.tcgetattr(slave);child=None
try:
 child=subprocess.Popen([str(node),str(Path(__file__).with_suffix('.cjs')),str(slave),os.ttyname(other)],pass_fds=(slave,),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env={**os.environ,'KANDELO_TTY_ATTRIBUTES':str(Path(sys.argv[2]).resolve())})
 ready,_,_=select.select([child.stdout],[],[],5)
 assert ready,'native READY timeout'
 line=child.stdout.readline();assert line.strip()=='READY',line
 os.write(a,b'A');os.write(b,b'B\n')
 ready,_,_=select.select([child.stdout],[],[],5);assert ready,'native NORMAL timeout'
 assert child.stdout.readline().strip()=='NORMAL'
 normal=termios.tcgetattr(slave)
 stdout,stderr=child.communicate('ACK\n',timeout=5)
 if stderr:sys.stderr.write(stderr)
 assert child.returncode==0,child.returncode
 report=json.loads(stdout);assert report['actualInput']=='A'and report['replacementPreserved']
 restored=termios.tcgetattr(slave);report['parentInitialTermiosWords']=[initial[3],initial[0],initial[1],initial[2]];report['parentNormalTermiosWords']=[normal[3],normal[0],normal[1],normal[2]];report['parentClosedTermiosWords']=[restored[3],restored[0],restored[1],restored[2]]
 print(json.dumps({'scope':'Native differential reference only; actual Node TTYWRAP is not candidate support','nodeSha256':hashlib.sha256(node.read_bytes()).hexdigest(),'report':report}))
finally:
 if child is not None and child.poll() is None:child.kill();child.communicate()
 for fd in [a,slave,b,other]:os.close(fd)
