#!/usr/bin/env python3
"""VM-10 zero/small-offset fused wrappers and the VM-01/02 combination."""
import hashlib,json,os,platform,subprocess,sys
from pathlib import Path
out=Path(sys.argv[1]).resolve();out.mkdir(parents=True,exist_ok=False)
def run(args,stdout=None): subprocess.run([str(a) for a in args],check=True,stdout=stdout)
def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
llvm=Path(os.environ['LLVM_BIN'])
host=subprocess.check_output(['rustc','-vV'],text=True).split('host: ')[1].splitlines()[0]
run(['cargo','build','--manifest-path','tools/common-memory-program/instrument/Cargo.toml','--target',host])
instrument=Path('tools/common-memory-program/instrument/target')/host/'debug/common-memory-program-instrument'
original=Path('tools/common-memory-program/helpers.c').read_text()
scalar=original.replace('EXPORT("vm_read_address")', '''// Effective bounds were already checked by each scalar caller. Preserve the
// original span path for crossing pages, including its permission preflight.
AI uint32_t scalar_address(uint32_t p, uint32_t n, uint32_t rights, uint32_t root) {
    if (n && n <= PAGE - (p & (PAGE - 1))) return page(p, rights, root);
    return vm_span(p, n, rights, root);
}
EXPORT("vm_read_address")''')
for rights in ['1','2','rights']:
 before=f'uint32_t a = vm_span(p, n, {rights}, root);'
 assert scalar.count(before)==(2 if rights=='2' else 1),before
 scalar=scalar.replace(before,f'uint32_t a = scalar_address(p, n, {rights}, root);',1)
artifacts={}
native=Path('.scratch/common-memory-php-shared-build-1/out/php-fpm.wasm').resolve()
sources={'fpm':native,'canary':Path('.scratch/common-memory-program-outlined-3/canary-native.wasm').resolve(),
 'access':Path('.scratch/common-memory-program-outlined-3/access-native.wasm').resolve(),
 'fork':Path('.scratch/common-memory-shared-fork-3/shared-fork.native.wasm').resolve()}
bounds=out/'bounds-native.wasm'
run(['wat2wasm','--enable-threads','tools/common-memory-program/survey/bounds.wat','-o',bounds])
sources['bounds']=bounds
for mode,text in [('baseline',original),('fuse-zero',original),('fuse-small',original),('fuse-small-combined',scalar),('scalar-conditional',scalar)]:
 source=out/f'helpers-{mode}.c';source.write_text(text)
 helpers=out/f'helpers-{mode}.wasm'
 run([llvm/'clang','--target=wasm32-unknown-unknown','-ffreestanding','-fno-builtin','-O2','-matomics','-mbulk-memory','-msimd128',
 '-nostdlib',f'-fuse-ld={llvm/"wasm-ld"}','-Wl,--no-entry','-Wl,--import-memory','-Wl,--shared-memory',
 '-Wl,--initial-memory=131072','-Wl,--max-memory=4294967296',source,'-o',helpers])
 run(['wasm-validate','--enable-threads',helpers])
 for conditional in [mode in ['fuse-small-combined','scalar-conditional']]:
  name=mode
  files={}
  for kind,native_source in sources.items():
   target=out/f'{kind}-{name}.wasm'
   flags=['--outline-accesses']+(['--conditional-commit'] if conditional else [])+(['--fuse-scalars='+('zero' if mode=='fuse-zero' else 'small')] if mode.startswith('fuse-') else [])
   with (out/f'{kind}-{name}.json').open('w') as report:run([instrument,native_source,helpers,target,*flags],report)
   files[kind]={'path':str(target),'sha256':sha(target),'bytes':target.stat().st_size}
  artifacts[name]={'ids':(['VM-10'] if mode.startswith('fuse-') else [])+(['VM-01','VM-02'] if conditional else []),'artifacts':files}
manifest={'host':host,'compiler':subprocess.check_output([llvm/'clang','--version'],text=True),
 'sources':{str(p):sha(p) for p in [Path(__file__),Path('tools/common-memory-program/helpers.c'),Path('tools/common-memory-program/instrument/src/main.rs'),*sources.values()]},
 'variants':artifacts,'pairReferences':{'fuse-zero':'baseline','fuse-small':'baseline','fuse-small-combined':'scalar-conditional'}}
assert artifacts['baseline']['artifacts']['fpm']['sha256']=='f879effe0ecbcc1c35d21f718e259c15b9edd5c62cdf5f4339b7e2cff534cc9c'
assert artifacts['scalar-conditional']['artifacts']['fpm']['sha256']=='b3f912f008fb24d3dab53d9bbd168e36632978e64e529c3cb09a8f9e177e49da'
(out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({'output':str(out),'variants':list(artifacts)}))
