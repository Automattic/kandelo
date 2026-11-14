from pathlib import Path
import subprocess,os,json,hashlib,sys
out=Path(sys.argv[1]).resolve();out.mkdir(parents=True,exist_ok=False)
host=subprocess.check_output(['rustc','-vV'],text=True).split('host: ')[1].splitlines()[0]
instrument=Path('tools/common-memory-program/instrument/target')/host/'debug/common-memory-program-instrument'
helper=Path('.scratch/common-memory-survey-fused-1/helpers-fuse-small.wasm').resolve()
def artifact(p):return {'path':str(p.resolve()),'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}
def run(args):subprocess.run(list(map(str,args)),check=True)
wat=['(module (import "env" "memory" (memory 2 65536 shared))']
for kind in ['i32','i64']:
 for bits in [8,16,32]+([64]if kind=='i64'else[]):
  suffix=''if bits==int(kind[1:])else str(bits)
  for offset in [0,16]:
   for action in ['load','store','add','cmp']:
    op=kind+'.atomic.'+{'load':'load'+suffix+('_u'if suffix else ''),'store':'store'+suffix,'add':'rmw'+suffix+'.add'+('_u'if suffix else ''),'cmp':'rmw'+suffix+'.cmpxchg'+('_u'if suffix else '')}[action]
    params='(param i32)'+(f'(param {kind})'if action!='load'else '')+(f'(param {kind})'if action=='cmp'else '')
    result=''if action=='store'else f'(result {kind})';operands='local.get 0'+(' local.get 1'if action!='load'else '')+(' local.get 2'if action=='cmp'else '')
    wat.append(f'(func (export "{kind}_{bits}_{action}_{offset}") {params} {result} {operands} {op} offset={offset})')
wat.append(')');(out/'atomic.wat').write_text('\n'.join(wat)+'\n');run(['wat2wasm','--enable-threads',out/'atomic.wat','-o',out/'atomic-native.wasm'])
sources={'fpm':Path('.scratch/common-memory-php-shared-build-1/out/php-fpm.wasm').resolve(),'canary':Path('.scratch/common-memory-program-outlined-3/canary-native.wasm').resolve(),'access':Path('.scratch/common-memory-program-outlined-3/access-native.wasm').resolve(),'bounds':Path('.scratch/common-memory-survey-fused-1/bounds-native.wasm').resolve(),'fork':Path('.scratch/common-memory-shared-fork-3/shared-fork.native.wasm').resolve(),'atomic':out/'atomic-native.wasm'}
variants={}
for mode,flags in [('baseline',[]),('atomics',['--fuse-atomics']),('small',['--fuse-scalars=small']),('combined',['--fuse-scalars=small','--fuse-atomics'])]:
 arts={}
 for kind,p in sources.items():
  target=out/f'{kind}-{mode}.wasm';r=subprocess.run(list(map(str,[instrument,p,helper,target,'--outline-accesses',*flags])),capture_output=True,text=True);(out/f'{kind}-{mode}.log').write_text(r.stderr);(out/f'{kind}-{mode}.json').write_text(r.stdout);r.check_returncode();arts[kind]=artifact(target)
 variants[mode]={'ids':(['VM-06','VM-10']if mode in ['atomics','combined']else ['VM-10']if mode=='small'else []),'artifacts':arts}
assert variants['baseline']['artifacts']['fpm']['sha256']=='f879effe0ecbcc1c35d21f718e259c15b9edd5c62cdf5f4339b7e2cff534cc9c'
assert variants['small']['artifacts']['fpm']['sha256']=='2edbcf32ef3c309eefdabec5eaceeb6d6082ca80fc9b1fc0e235ff838b7b89b4'
manifest={'scope':'Atomic fusion individually and with existing small scalar fusion; no diagnostic counter artifacts. Original ordinary compiler and host profile matched.','helper':artifact(helper),'variants':variants,'pairReferences':{'atomics':'baseline','combined':'small'},'nativeArtifacts':{m:artifact(sources['fpm'])for m in variants},'sources':{str(p):artifact(p)for p in [Path(__file__),Path('tools/common-memory-program/instrument/src/main.rs'),*sources.values()]}}
(out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n');print(json.dumps({'output':str(out),'variants':list(variants)}))
