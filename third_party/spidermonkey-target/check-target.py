#!/usr/bin/env python3
"""Focused source/SDK controls for the pinned Mozilla Kandelo target proposal.

Run in scripts/dev-shell.sh. Inputs are source-only canonical pre/post trees,
not generated engine artifacts. This exercises exact configure function bodies
without configure decorators/whole-project dependency evaluation. SDK probes
preprocess only, so no SDK/plugin/sysroot/guest artifact rebuild is needed.
"""
import argparse, ast, hashlib, importlib.util, json, logging, os
from pathlib import Path
import subprocess, sys, textwrap, types
sys.dont_write_bytecode = True

def functions(path, names, scope):
    parsed = ast.parse(path.read_text(), filename=str(path))
    selected = []
    for node in parsed.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names:
            node.decorator_list = []
            selected.append(node)
    assert {n.name for n in selected} == set(names), (path, names)
    unit = ast.Module(body=selected, type_ignores=[])
    exec(compile(unit, str(path), 'exec'), scope)

def constants(path):
    spec = importlib.util.spec_from_file_location('target_constants', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--raw', type=Path, required=True)
    ap.add_argument('--pre', type=Path, required=True)
    ap.add_argument('--post', type=Path, required=True)
    ap.add_argument('--repo', type=Path, required=True)
    ap.add_argument('--output', type=Path, required=True)
    ap.add_argument('--plugin', type=Path, required=True, help='Existing LLVM-matched plugin; no automatic plugin build')
    args = ap.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    sys.path.insert(0, str(args.raw/'python/mozbuild'))
    from mozbuild.util import ReadOnlyNamespace
    ns = lambda **kwargs: ReadOnlyNamespace(**kwargs)
    # Version construction/comparison is not the contract under test. This
    # identity constructor suffices for the non-Xcode compiler in this control.
    Version = str
    env = os.environ.copy()
    repo = args.repo.resolve()
    llvm_dir = env.get('WASM_POSIX_LLVM_DIR') or env.get('LLVM_BIN')
    if not llvm_dir: raise RuntimeError('Run inside scripts/dev-shell.sh (LLVM_BIN missing)')
    llvm = Path(llvm_dir)
    sdk = repo/'sdk/.build/bin/kandelo-cc'
    plugin = args.plugin.resolve()
    if not plugin.is_file(): raise RuntimeError('Select an existing LLVM-matched plugin')
    env.update(WASM_POSIX_INVOKED_AS='wasm32posix-cc', WASM_POSIX_SDK_ROOT=str(repo/'sdk'),
               WASM_POSIX_SYSROOT=str(repo/'sysroot'), WASM_POSIX_LLVM_DIR=str(llvm),
               WASM_POSIX_CALLTYPES_PLUGIN=str(plugin))
    rows = []
    def run(command, source=None):
        cp = subprocess.run([str(x) for x in command], input=source, text=True,
                            capture_output=True, env=env)
        if cp.returncode: raise RuntimeError(cp.stderr)
        return cp.stdout
    def preprocess(cache, compiler, language, source):
        return run(list(compiler)+['-E', '-x', 'c++' if language == 'C++' else 'c', '-'], source)
    def die(message): raise ValueError(message)
    for label, tree in [('before', args.pre), ('after', args.post)]:
        c = constants(tree/'python/mozbuild/mozbuild/configure/constants.py')
        scope = dict(namespace=ns, CPU=c.CPU, CPU_bitness=c.CPU_bitness, Kernel=c.Kernel,
                     OS=c.OS, Abi=c.Abi, Endianness=c.Endianness, CompilerType=c.CompilerType,
                     CPU_preprocessor_checks=c.CPU_preprocessor_checks,
                     kernel_preprocessor_checks=c.kernel_preprocessor_checks,
                     OS_preprocessor_checks=c.OS_preprocessor_checks,
                     try_preprocess=preprocess, FatalCheckError=ValueError, Version=Version,
                     log=logging.getLogger('target-control'), dedent=textwrap.dedent,
                     quote=lambda x: x, die=die,
                     check_cmd_output=lambda *cmd: run(cmd))
        names=['split_triplet','target_variables','target_is_unix','target_has_linux_kernel']
        if label == 'after': names += ['target_is_kandelo']
        functions(tree/'build/moz.configure/init.configure', names, scope)
        functions(args.raw/'build/moz.configure/toolchain.configure',
                  ['get_compiler_info','same_arch_different_bits','check_compiler'], scope)
        functions(tree/'build/moz.configure/rust.configure',
                  ['rust_supported_targets','detect_rustc_target'], scope)
        triple='wasm32-unknown-kandelo'
        sub=subprocess.run(['sh',str(tree/'build/autoconf/config.sub'),triple],capture_output=True,text=True)
        try: target=scope['split_triplet'](triple,allow_wasi=True); admitted=True
        except ValueError: target=None; admitted=False
        assert admitted == (label=='after')
        assert (sub.returncode==0) == (label=='after')
        rows.append({'name':label+' Kandelo target admission','admitted':admitted,
                     'configSubExit':sub.returncode,'configSubStdout':sub.stdout.strip(),
                     'configSubStderr':sub.stderr.strip()})
        plain=scope['get_compiler_info'](None,[str(sdk)],'C')
        inherited=scope['get_compiler_info'](None,[str(sdk),'-D__linux__=1'],'C')
        explicit=scope['get_compiler_info'](None,[str(sdk),'-D__kandelo__=1'],'C')
        poisoned=scope['get_compiler_info'](None,[str(sdk),'-D__kandelo__=1','-D__linux__=1'],'C')
        assert plain.kernel is None and inherited.kernel=='Linux'
        assert explicit.kernel == ('Kandelo' if label=='after' else None)
        assert poisoned.kernel=='Linux'
        rows.append({'name':label+' actual SDK compiler detection',
                     'plain':vars(plain),'inheritedLinux':vars(inherited),
                     'explicitKandelo':vars(explicit),'KandeloPlusLinux':vars(poisoned)})
        supported=scope['rust_supported_targets'](os.environ.get('RUSTC','rustc'))
        key=('wasm32','little',None if label=='after' else 'GNU')
        assert any(x.rust_target=='wasm32-unknown-unknown' for x in supported[key])
        if label=='after':
            assert all(x.target.os is None and x.target.kernel is None for x in supported[key])
        rows.append({'name':label+' generic Rust codegen mapping',
                     'candidateKey':key,'rustTarget':'wasm32-unknown-unknown'})
        if label=='after':
            vars_target=scope['target_variables'](target)
            assert vars_target.OS_ARCH==vars_target.OS_TARGET=='Kandelo'
            assert scope['target_is_unix'](target) is True
            assert scope['target_is_kandelo'](target) is True
            assert scope['target_has_linux_kernel'](target) is None
            assert target.cpu=='wasm32' and target.bitness==32 and target.endianness=='little'
            checked=scope['check_compiler'](None,[str(sdk),'-D__kandelo__=1'],'C',target,None)
            assert not any(flag.startswith('--target=') for flag in checked.flags), checked
            rust_target=scope['detect_rustc_target'](target,explicit,None,supported)
            assert rust_target=='wasm32-unknown-unknown'
            for bad in ['x86_64-unknown-kandelo','wasm64-unknown-kandelo','wasm32-unknown-kandelo-linux']:
                try: scope['split_triplet'](bad,allow_wasi=True)
                except ValueError: pass
                else: raise AssertionError('Accepted '+bad)
            rows.append({'name':'explicit target state/SDK target preservation',
                         'target':vars(target),'variables':vars(vars_target),
                         'flags':checked.flags,'rustTarget':rust_target})
    # Other supported platform canonicalization is unchanged byte-for-result.
    for triple in ['x86_64-pc-linux-gnu','aarch64-unknown-linux-musl',
                   'aarch64-apple-darwin','x86_64-unknown-freebsd','wasm32-unknown-wasi']:
        results=[]
        for tree in [args.pre,args.post]:
            cp=subprocess.run(['sh',str(tree/'build/autoconf/config.sub'),triple],capture_output=True,text=True)
            results.append((cp.returncode,cp.stdout,cp.stderr))
        assert results[0]==results[1],triple
        rows.append({'name':'unchanged config.sub '+triple,'result':results[1]})
    cfg=run([os.environ.get('RUSTC','rustc'),'--print','cfg','--target','wasm32-unknown-unknown'])
    assert 'target_os="unknown"' in cfg and 'target_os="linux"' not in cfg
    (args.output/'rust-generic-cfg.txt').write_text(cfg)
    report={'scope':'Exact pinned configure function-body controls + actual SDK preprocessing/config.sub/rustc target-list; not complete configure, compile, link, engine or guest proof.',
            'rows':rows,'allAssertionsPassed':True,
            'inputSha256':{str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in [sdk,llvm/'clang',plugin]},
            'versionConstructorScope':'Version identity constructor; Xcode/compiler version conversion not under test'}
    (args.output/'configure-controls.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report,indent=2))
if __name__=='__main__': main()
