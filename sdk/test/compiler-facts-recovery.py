#!/usr/bin/env python3
"""Focused host-plugin regression; no sysroot, guest objects or SDK rebuild.

Run inside scripts/dev-shell.sh. The SDK plugin build.sh builds the native
component unless --plugin (or documented WASM_POSIX_CALLTYPES_PLUGIN) selects
an already built matching component. --baseline-plugin additionally judges the
old crash and exact valid LLVM IR/fact preservation against that component.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

CASES = {
    'valid-holes': 'void f(){} struct S { void(*a)(); int b; void(*c)(); }; S s={.c=f};',
    'reference-hole': 'void f(){} struct S { void(*a)(); int& b; void(*c)(); }; S s={.c=f};',
    'bad-member': 'void f(){} struct S { void(*a)(); int b; void(*c)(); }; S s={.a=f,.b=unknown,.c=f};',
    'bad-type': 'void f(){} struct S { void(*a)(); int b; void(*c)(); }; S s={.a=3,.c=f};',
    'deleted-default': 'void f(){} struct D { D()=delete; }; struct S { void(*a)(); D b; void(*c)(); }; S s={.c=f};',
    'incomplete': 'void f(){} struct X; struct S { void(*a)(); X b; void(*c)(); }; S s={.c=f};',
    'fatal-before': 'void f(){} struct S { void(*a)(); int b; void(*c)(); };\n#include "kandelo-intentionally-absent.h"\nS s={.c=f};',
    'fatal-after': 'void f(){} struct S { void(*a)(); int b; void(*c)(); }; S s={.c=f};\n#include "kandelo-intentionally-absent.h"',
    'nested-reference': 'void f(){} struct R { int& r; }; struct S { void(*a)(); R b; void(*c)(); }; S s={.c=f};',
    'unknown-base': 'void f(){} struct S { void(*a)(); int b; void(*c)(); }; void g(){ S s={.c=f, .b=missing()}; }',
    'union-bad-function': 'void f(){} union U { void(*f)(); int x; }; U u={.f=3};',
    'union-reference': 'void f(){} struct R { int& r; }; union U { void(*f)(); R x; }; U u={.x={}};',
}
VALID = '''extern "C" int callback(int x){return x+1;}
struct Dispatch { int reserved; int(*callback)(int); };
Dispatch dispatch={.callback=callback};
extern "C" int invoke(int(*f)(int)){return f(7);}
'''


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def crashed(result):
    return (result.returncode < 0 or 'PLEASE submit a bug report' in result.stderr or
            'frontend command failed' in result.stderr)


def ast_flags(plugin):
    return ['-Xclang', '-load', '-Xclang', str(plugin),
            '-Xclang', '-add-plugin', '-Xclang', 'kandelo-fncasts']


def run(command, output):
    result = subprocess.run(command, capture_output=True, text=True, timeout=60)
    output.write_text(result.stdout + result.stderr)
    return result


def check(args, scratch):
    repo = Path(__file__).resolve().parents[2]
    tool_dir = (os.environ.get('WASM_POSIX_LLVM_DIR') or os.environ.get('LLVM_BIN') or
                (str(Path(os.environ['LLVM_PREFIX']) / 'bin') if os.environ.get('LLVM_PREFIX') else None))
    require(tool_dir, 'Use scripts/dev-shell.sh with the declared LLVM tools')
    clang = Path(tool_dir) / 'clang++'
    require(clang.is_file(), 'Missing declared clang++: ' + str(clang))
    plugin = args.plugin or os.environ.get('WASM_POSIX_CALLTYPES_PLUGIN')
    if plugin:
        plugin = Path(plugin).resolve()
    else:
        plugin = scratch / ('KandeloCallTypes.dylib' if sys.platform == 'darwin' else 'KandeloCallTypes.so')
        build = subprocess.run(['bash', str(repo / 'sdk/src/plugin/build.sh'), str(plugin)],
                               capture_output=True, text=True, timeout=300)
        (scratch / 'plugin-build.log').write_text(build.stdout + build.stderr)
        require(build.returncode == 0, 'Native plugin build failed: ' + build.stderr)
    require(plugin.is_file(), 'Missing native plugin: ' + str(plugin))
    common = [str(clang), '--target=wasm32-unknown-unknown', '-std=c++20',
              '-nostdinc', '-nostdinc++', '-fsyntax-only']
    rows = []
    baseline_crashes = []
    for name, text in CASES.items():
        source = scratch / (name + '.cpp')
        source.write_text(text + '\n')
        reference = run([*common, str(source)], scratch / (name + '.clang.log'))
        candidate = run([*common, *ast_flags(plugin), str(source)], scratch / (name + '.plugin.log'))
        require(reference.returncode == (0 if name == 'valid-holes' else 1), name + ': unexpected diagnostic control')
        require(not crashed(candidate), name + ': plugin crashed')
        require((candidate.returncode, candidate.stdout, candidate.stderr) ==
                (reference.returncode, reference.stdout, reference.stderr), name + ': plugin changed diagnostics')
        rows.append({'case': name, 'exit': candidate.returncode, 'diagnosticsExactMatch': True})
        if args.baseline_plugin:
            baseline = run([*common, *ast_flags(args.baseline_plugin), str(source)],
                           scratch / (name + '.baseline.log'))
            if crashed(baseline):
                baseline_crashes.append(name)
    if args.baseline_plugin:
        require('reference-hole' in baseline_crashes, 'Baseline did not reproduce the reported recovery crash')
    source = scratch / 'valid-facts.cpp'
    source.write_text(VALID)
    ir_common = [str(clang), '-std=c++20', '-S', '-emit-llvm', '-O1', '-nostdinc', '-nostdinc++',
                 '-Xclang', '-fsanitize=cfi-icall', '-Xclang', '-fsanitize-trap=cfi-icall',
                 '-Xclang', '-flto-unit', '-Xclang', '-fwhole-program-vtables']
    ir = scratch / 'valid-facts.ll'
    result = run([*ir_common, *ast_flags(plugin), '-fpass-plugin=' + str(plugin),
                  str(source), '-o', str(ir)], scratch / 'valid-facts.log')
    require(result.returncode == 0, 'Native IR/facts control failed: ' + result.stderr)
    text = ir.read_text()
    require('!"kandelo.calltypes"' in text, 'Missing compiler facts metadata')
    require(r'G\09callback\09Dispatch\0A' in text, 'Missing known function/record fact')
    require(r'Q\09callback\09_ZTSFiiE\0A' in text, 'Missing address-taken type fact')
    require(r'S\09invoke\090\09i32->i32\09icall\09_ZTSFiiE\0A' in text, 'Missing indirect-call type fact')
    require('call i1 @llvm.type.test' not in text, 'CFI check was not consumed by the facts owner')
    exact_ir = None
    if args.baseline_plugin:
        old_ir = scratch / 'valid-facts.baseline.ll'
        baseline = run([*ir_common, *ast_flags(args.baseline_plugin),
                        '-fpass-plugin=' + str(args.baseline_plugin), str(source), '-o', str(old_ir)],
                       scratch / 'valid-facts.baseline.log')
        require(baseline.returncode == 0, 'Baseline valid facts failed')
        exact_ir = ir.read_bytes() == old_ir.read_bytes()
        require(exact_ir, 'Valid native IR/facts changed')
    return {'scope': 'Native SDK plugin component and syntax-only wasm recovery AST; native host LLVM IR/facts. No guest object/runtime or broad SDK rebuild.',
            'pass': len(rows) + 1, 'fail': 0, 'cases': rows,
            'baselineCrashes': baseline_crashes, 'validIrAndFactsExactMatch': exact_ir,
            'clangPath': str(clang), 'clangSha256': digest(clang),
            'pluginSha256': digest(plugin), 'validNativeIrSha256': digest(ir),
            'pluginSourceSha256': digest(repo / 'sdk/src/plugin/KandeloFnCasts.cpp')}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plugin', type=Path)
    parser.add_argument('--baseline-plugin', type=Path)
    parser.add_argument('--keep-dir', type=Path)
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    scratch = args.keep_dir or Path(tempfile.mkdtemp(prefix='kandelo-calltypes-recovery-'))
    if args.keep_dir:
        scratch.mkdir(parents=True, exist_ok=False)
    try:
        report = check(args, scratch)
        if args.report:
            args.report.write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report, indent=2))
    finally:
        if not args.keep_dir:
            shutil.rmtree(scratch)


if __name__ == '__main__':
    main()
