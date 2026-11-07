from pathlib import Path
import pty,os,subprocess,json
test_root=Path(__file__).resolve().parent;r=Path(os.environ['TTY_OUTPUT_TEST_REPO']);out=Path(os.environ['TTY_OUTPUT_CONTROL_DIR']);node=Path(os.environ['NODE26_REFERENCE']);results={};runs=[]
for mode in ('native','candidate'):
 master,slave=pty.openpty()
 with (out/(mode+'-fallback.report')).open('wb') as report:
  env=dict(os.environ,REPORT_FD=str(report.fileno()),TTY_MASTER_FD=str(master));cmd=[str(node),'--expose-internals',str(test_root/'fallback.cjs'),mode];p=subprocess.Popen(cmd,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,pass_fds=(report.fileno(),master),env=env);timed=False
  try:stdout,error=p.communicate(timeout=10)
  except subprocess.TimeoutExpired:p.kill();stdout,error=p.communicate();timed=True
 os.close(master);os.close(slave);(out/(mode+'-fallback.stdout')).write_bytes(stdout);(out/(mode+'-fallback.error')).write_bytes(error);results[mode]=json.loads((out/(mode+'-fallback.report')).read_text());runs.append({'mode':mode,'exit':p.returncode,'reaped':p.poll() is not None,'timedOut':timed,'actualPtyMaster':True})
(out/'fallback-runs.json').write_text(json.dumps(runs,indent=2)+'\n');(out/'fallback-comparison.json').write_text(json.dumps(results,indent=2)+'\n')
assert all(x['exit']==0 and not x['timedOut'] for x in runs),runs
native={k:v for k,v in results['native'].items() if k!='mode'};candidate={k:v for k,v in results['candidate'].items() if k!='mode'}
print(json.dumps({'native':native,'candidate':candidate,'scope':'Actual unsupported master/reopen fallback; remains a failure, not supported compatibility'}))
assert native==candidate,results
