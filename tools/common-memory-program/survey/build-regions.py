from pathlib import Path
import subprocess,os,json,hashlib,sys
out=Path(sys.argv[1]).resolve();out.mkdir(parents=True,exist_ok=False)
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def artifact(p,**extra):return{'path':str(p.resolve()),'bytes':p.stat().st_size,'sha256':sha(p),**extra}
def run(label,args):
 r=subprocess.run(list(map(str,args)),capture_output=True,text=True);(out/(label+'.log')).write_text(r.stderr);(out/(label+'.json')).write_text(r.stdout);r.check_returncode();return r
host=subprocess.check_output(['rustc','-vV'],text=True).split('host: ')[1].splitlines()[0];tool=Path('tools/common-memory-program/instrument/target')/host/'debug/common-memory-program-instrument'
normal=Path('.scratch/common-memory-survey-fused-1/helpers-fuse-small.wasm').resolve();c=Path('tools/common-memory-program/helpers.c').read_text();guard=Path('tools/common-memory-program/survey/object-guard.c').read_text()
helper_paths={}
for name,text in [('guard',c+'\n'+guard),('guard-diagnostic',c+'\n'+guard.replace('EXPORT("vm_try_span")\nuint32_t vm_try_span(', 'AI uint32_t vm_try_span_impl(')+'''
EXPORT("vm_try_span") uint32_t vm_try_span(uint32_t p,uint32_t n,uint32_t rights,uint32_t root) {
 uint32_t result=vm_try_span_impl(p,n,rights,root);
 if(root&&(uint64_t)root+HEADER<=(uint64_t)__builtin_wasm_memory_size(0)*PAGE) words(root)[result?6:7]++;
 return result;
}
''')]:
 source=out/(name+'.c');source.write_text(text);target=out/(name+'.wasm');llvm=Path(os.environ['LLVM_BIN'])
 run(name+'-build',[llvm/'clang','--target=wasm32-unknown-unknown','-ffreestanding','-fno-builtin','-O2','-matomics','-mbulk-memory','-msimd128','-nostdlib',f'-fuse-ld={llvm/"wasm-ld"}','-Wl,--no-entry','-Wl,--import-memory','-Wl,--shared-memory','-Wl,--initial-memory=131072','-Wl,--max-memory=4294967296',source,'-o',target]);helper_paths[name]=target
run('regional-native',['wat2wasm','--enable-threads','tools/common-memory-program/survey/regional.wat','-o',out/'regional-native.wasm'])
sources={'fpm':Path('.scratch/common-memory-php-shared-build-1/out/php-fpm.wasm').resolve(),'canary':Path('.scratch/common-memory-program-outlined-3/canary-native.wasm').resolve(),'access':Path('.scratch/common-memory-program-outlined-3/access-native.wasm').resolve(),'bounds':Path('.scratch/common-memory-survey-fused-1/bounds-native.wasm').resolve(),'fork':Path('.scratch/common-memory-shared-fork-3/shared-fork.native.wasm').resolve(),'regional':out/'regional-native.wasm'}
variants={}
for mode,flags in [('baseline',[]),('regions',['--guard-regions=4']),('small',['--fuse-scalars=small']),('regions-small',['--guard-regions=4','--fuse-scalars=small'])]:
 artifacts={}
 for kind,source in sources.items():
  diagnostic=mode.startswith('regions')and kind=='regional';helper=helper_paths['guard-diagnostic'if diagnostic else'guard']if mode.startswith('regions')else normal
  target=out/f'{kind}-{mode}.wasm';run(f'{kind}-{mode}',[tool,source,helper,target,'--outline-accesses',*flags]);artifacts[kind]=artifact(target,**({'guardCounters':diagnostic}if kind=='regional'else{}))
 variants[mode]={'ids':['VM-04','VM-07','VM-08']+(['VM-10']if 'small'in mode else[])if mode.startswith('regions')else['VM-10']if mode=='small'else[],'artifacts':artifacts}
assert variants['baseline']['artifacts']['fpm']['sha256']=='f879effe0ecbcc1c35d21f718e259c15b9edd5c62cdf5f4339b7e2cff534cc9c'
assert variants['small']['artifacts']['fpm']['sha256']=='2edbcf32ef3c309eefdabec5eaceeb6d6082ca80fc9b1fc0e235ff838b7b89b4'
for mode in ['regions','regions-small']:
 report=json.loads((out/f'regional-{mode}.json').read_text());plans=report['regionPlans'];exports=json.loads(run('inspect-'+mode,[tool,'--inspect-function-exports',sources['regional']]).stdout)
 assert not any(p['function']in[exports['outer_value'],exports['base_mutate']]for p in plans)
 assert sum(p['function']==exports['call_boundary']for p in plans)==2
 assert sum(p['function']==exports['branches']for p in plans)==2
manifest={'scope':'Regional guarded i32 spans individually and with small scalar fusion. Detailed guard counters only in synthetic regional fixture, never FPM or timing artifacts.','variants':variants,'pairReferences':{'regions':'baseline','regions-small':'small'},'nativeArtifacts':{mode:artifact(sources['fpm'])for mode in variants},'helpers':{k:artifact(p)for k,p in helper_paths.items()},'sources':{str(p):sha(p)for p in [Path(__file__),*Path('tools/common-memory-program/instrument/src').glob('*.rs'),*Path('tools/common-memory-program/feasibility/src').glob('*.rs'),*sources.values()]}}
(out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n');print(json.dumps({'output':str(out),'variants':list(variants)}))
