from pathlib import Path
import hashlib,json,shutil,subprocess,sys
source=Path(__file__).resolve().parent;out=Path(sys.argv[1]).resolve();out.mkdir(parents=True,exist_ok=False)
for p in source.iterdir():
 if p.suffix in ['.mjs','.html','.wat','.py','.ts']:shutil.copy2(p,out/p.name)
commands=[]
for name,args in [('compile',['wat2wasm','--enable-threads','--enable-multi-memory',str(out/'probe.wat'),'-o',str(out/'probe.wasm')]),
                  ('validate',['wasm-validate','--enable-threads','--enable-multi-memory',str(out/'probe.wasm')])]:
 r=subprocess.run(args,capture_output=True,text=True);(out/(name+'.log')).write_text(r.stdout+r.stderr)
 commands.append({'args':args,'exit':r.returncode});(out/'commands.json').write_text(json.dumps(commands,indent=2)+'\n');r.check_returncode()
files={p.name:{'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'bytes':p.stat().st_size} for p in out.iterdir() if p.is_file()}
(out/'inputs.json').write_text(json.dumps({'scope':'synthetic Worker-owned capability/alias probe','files':files},indent=2)+'\n')
print(out)
