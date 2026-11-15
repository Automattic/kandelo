#!/usr/bin/env python3
"""VM-03 one/two-entry epoch caches, independently and with VM-01/02."""
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
def cached(text, slots):
 before = '    uint32_t e = words(root + HEADER)[p >> 16];'
 assert text.count(before)==1
 replacement = f"""    uint32_t epoch = words(root)[4], vpage = p >> 16;
    uint32_t *slot = words(root) + 5 + 3 * (vpage & {slots-1});
    uint32_t e;
    if (epoch && slot[0] == epoch && slot[1] == vpage) e = slot[2];
    else {{
        e = words(root + HEADER)[vpage];
        if (epoch) {{ slot[1] = vpage; slot[2] = e; slot[0] = epoch; }}
    }}"""
 text=text.replace(before,replacement)
 # Growth is a mapping mutation even though existing PTEs remain unchanged.
 before='            words(root)[0] = old + delta;'
 assert text.count(before)==1
 text=text.replace(before,'            if (words(root)[4]) words(root)[4]++;\n'+before)
 return text+f'\nEXPORT("vm_cache_slots") uint32_t vm_cache_slots(void) {{ return {slots}; }}\n'
for mode,text in [('baseline',original),('cache-root1',cached(original,1)),
                  ('cache-root2',cached(original,2)),('cache-root2-combined',cached(scalar,2))]:
 source=out/f'helpers-{mode}.c';source.write_text(text)
 helpers=out/f'helpers-{mode}.wasm'
 run([llvm/'clang','--target=wasm32-unknown-unknown','-ffreestanding','-fno-builtin','-O2','-matomics','-mbulk-memory','-msimd128',
 '-nostdlib',f'-fuse-ld={llvm/"wasm-ld"}','-Wl,--no-entry','-Wl,--import-memory','-Wl,--shared-memory',
 '-Wl,--initial-memory=131072','-Wl,--max-memory=4294967296',source,'-o',helpers])
 run(['wasm-validate','--enable-threads',helpers])
 for conditional in [mode.endswith('combined')]:
  name=mode
  files={}
  for kind,native_source in sources.items():
   target=out/f'{kind}-{name}.wasm'
   flags=['--outline-accesses']+(['--conditional-commit'] if conditional else [])
   with (out/f'{kind}-{name}.json').open('w') as report:run([instrument,native_source,helpers,target,*flags],report)
   files[kind]={'path':str(target),'sha256':sha(target),'bytes':target.stat().st_size}
  artifacts[name]={'ids':(['VM-03'] if mode.startswith('cache-') else [])+(['VM-01','VM-02'] if conditional else []),'artifacts':files}
manifest={'host':host,'compiler':subprocess.check_output([llvm/'clang','--version'],text=True),
 'sources':{str(p):sha(p) for p in [Path(__file__),Path('tools/common-memory-program/helpers.c'),Path('tools/common-memory-program/instrument/src/main.rs'),*sources.values()]},
 'variants':artifacts}
(out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({'output':str(out),'variants':list(artifacts)}))
