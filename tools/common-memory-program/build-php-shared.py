#!/usr/bin/env python3
"""Unpublished PHP build through the normal recipe/SDK/dependency closure.

The SHM refusal is disabled in a private recipe copy. Optional --c-opt=O3
changes PHP C compilation only; dependencies and C++ flags stay unchanged.
Private profile generation/use and LTO likewise apply to PHP C compilation.
Normal packages, their cache generations and the shipping guard are never
changed. Translate the resulting CLI/FPM artifacts before using shared mode.
"""
import argparse
import hashlib
import json
import os
import fcntl
from pathlib import Path
import re
import shlex
import stat
import subprocess
import sys
import tomllib

root = Path(__file__).resolve().parents[2]
os.chdir(root)
if not os.environ.get("KANDELO_DEV_SHELL_TOOL_PATH"):
    raise SystemExit("run through scripts/dev-shell.sh")
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('output')
parser.add_argument('--c-opt', choices=['O2', 'O3'], default='O2')
parser.add_argument('--programs-only', action='store_true',
                    help='prepare only CLI/FPM and sessions metadata; omit optional shared-extension builds/outputs')
parser.add_argument('--lto', choices=['none', 'full', 'thin'], default='none',
                    help='private PHP C LTO; prebuilt dependencies/C++ and normal pre-fork Binaryen remain unchanged')
parser.add_argument('--c-tail-calls', action='store_true',
                    help='private PHP C -mtail-call feature without selecting TAILCALL dispatch')
parser.add_argument('--portable-tailcalls', action='store_true',
                    help='private standard-Wasm TAILCALL adaptation; requires generated CALL-specialized headers')
parser.add_argument('--vm-generated', type=Path,
                    help='CC05 completed Kandelo PHP generator manifest; use with --vm-key')
parser.add_argument('--vm-key', choices=[kind + '-' + spec for kind in ['call', 'switch', 'goto']
                                       for spec in ['specialized', 'generic']])
profile_options = parser.add_mutually_exclusive_group()
profile_options.add_argument('--profile-generate-resource', type=Path,
                             help='private Clang resource overlay containing the target profile runtime')
profile_options.add_argument('--profile-use', type=Path, help='merged target LLVM profile for PHP C translation units')
args = parser.parse_args()
if bool(args.vm_generated) != bool(args.vm_key):
    parser.error('--vm-generated and --vm-key must be supplied together')
if args.portable_tailcalls and (not args.vm_generated or args.vm_key != 'call-specialized'):
    parser.error('portable tailcalls require generated CALL-specialized headers')
if (args.c_tail_calls or args.portable_tailcalls) and (
        args.c_opt != 'O2' or args.lto != 'none' or args.profile_generate_resource or args.profile_use):
    parser.error('screen target tailcalls independently before compiler combinations')
vm_dispatch = None
if args.vm_generated:
    if args.c_opt != 'O2' or args.lto != 'none' or args.profile_generate_resource or args.profile_use:
        parser.error('screen opcode dispatch independently before combining compiler changes')
    generator_path = args.vm_generated.resolve(strict=True)
    generator = json.loads(generator_path.read_text())
    if not generator.get('complete') or set(generator['variants']) != {
        kind + '-' + spec for kind in ['call', 'switch', 'goto'] for spec in ['specialized', 'generic']
    }:
        parser.error('requires a completed six-variant generator manifest')
    selected = generator['variants'][args.vm_key]
    if not selected.get('passed') or not selected.get('destroyed') or selected['code'] != 0:
        parser.error('selected generator variant did not pass and tear down')
    if {Path(item['path']).name for item in selected['outputs']} != {
        'zend_vm_execute.h', 'zend_vm_opcodes.h', 'zend_vm_opcodes.c', 'zend_vm_handlers.h'
    }:
        parser.error('requires all four upstream generated files, including handler definitions')
    # All declared files, including the actual generator runtime, must still
    # match. Copy the complete upstream generated set into a fresh build.
    for item in [*generator['inputs'], *selected['inputs'], *selected['outputs']]:
        p = Path(item['path'])
        if p.stat().st_size != item['bytes'] or hashlib.sha256(p.read_bytes()).hexdigest() != item['sha256']:
            parser.error('generator input/output changed: ' + str(p))
    vm_dispatch = {'key': args.vm_key, 'manifest': str(generator_path),
                   'manifestSha256': hashlib.sha256(generator_path.read_bytes()).hexdigest(),
                   'kind': selected['kind'], 'specialized': selected['specialized'],
                   'inputs': selected['inputs'], 'outputs': selected['outputs']}
if args.lto != 'none' and (args.profile_generate_resource or args.profile_use):
    parser.error('characterize LTO and PGO separately before enabling their combination')
base = Path(args.output).resolve()
c_opt = args.c_opt
profile, extra_cflags, extra_link_flags = {}, [], []
if args.profile_generate_resource:
    overlay = args.profile_generate_resource.resolve(strict=True)
    archive = overlay / 'lib/wasm32-unknown-unknown/libclang_rt.profile.a'
    if not archive.is_file() or not (overlay / 'include').is_dir():
        raise SystemExit('private profile overlay must contain target runtime and resource headers')
    extra_cflags = ['-resource-dir=' + str(overlay), '-fprofile-instr-generate']
    profile = {'mode': 'generate', 'resourceOverlay': str(overlay),
               'runtimeSha256': hashlib.sha256(archive.read_bytes()).hexdigest()}
elif args.profile_use:
    data = args.profile_use.resolve(strict=True)
    if not data.is_file():
        raise SystemExit('profile-use input must be a merged regular file')
    extra_cflags = ['-fprofile-instr-use=' + str(data), '-Werror=profile-instr-out-of-date', '-Werror=profile-instr-unprofiled']
    profile = {'mode': 'use', 'path': str(data), 'sha256': hashlib.sha256(data.read_bytes()).hexdigest()}
if args.lto != 'none':
    extra_cflags.append('-flto=' + args.lto)
    # LLVM bitcode is lowered by LLD's backend, beyond clang's -mllvm
    # arguments. Give that backend the same SDK SjLj/modern-EH settings;
    # otherwise PHP's real setjmp/longjmp calls remain undefined at link.
    extra_link_flags = ['-Wl,--mllvm=-wasm-enable-sjlj', '-Wl,--mllvm=-wasm-use-legacy-eh=false',
                        '-Wl,--mllvm=-exception-model=wasm']
if args.c_tail_calls or args.portable_tailcalls:
    extra_cflags.append('-mtail-call')
# These tokens flow through upstream generated make/shell recipes. Keep
# experimental path operands literal rather than permitting shell syntax.
if any(not re.fullmatch(r'[A-Za-z0-9_./=:-]+', flag) for flag in extra_cflags):
    raise SystemExit('private compiler flags/paths must contain only simple literal characters')
if root / ".scratch" not in base.parents or base.exists():
    raise SystemExit("choose a fresh directory under this workspace .scratch")
base.mkdir(parents=True)
(base / 'builder-source.py').write_bytes(Path(__file__).read_bytes())
if args.portable_tailcalls:
    helper = root / 'tools/common-memory-program/survey/portable-tailcalls.py'
    parents = {str(Path(item['path']).parent) for item in vm_dispatch['outputs']}
    if len(parents) != 1:
        raise SystemExit('portable adaptation requires one complete generated header directory')
    destination = base / 'portable-generated'
    subprocess.run(['python3', str(helper), next(iter(parents)), str(destination)], check=True)
    upstream = vm_dispatch['outputs']
    vm_dispatch = {
        **vm_dispatch, 'generatorKind': vm_dispatch['kind'], 'kind': 'TAILCALL',
        'portable': {
            'helperPath': str(helper), 'helperSha256': hashlib.sha256(helper.read_bytes()).hexdigest(),
            'scope': 'Standard Wasm calling convention with real target-feature selection; tail dispatch and single-step CALL macro/lookup separation',
        },
        'upstreamOutputs': upstream,
        'outputs': [
            {'path': str(destination / Path(item['path']).name),
             'bytes': (destination / Path(item['path']).name).stat().st_size,
             'sha256': hashlib.sha256((destination / Path(item['path']).name).read_bytes()).hexdigest()}
            for item in upstream
        ],
    }
work, out = base / "work", base / "out"
work.mkdir()
out.mkdir()
recipe = root / "packages/registry/php/build-php.sh"
manifest = tomllib.loads((recipe.parent / "package.toml").read_text())
source = recipe.read_text()
patched = source
for old, new in [
    ('SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"', "SCRIPT_DIR=" + shlex.quote(str(recipe.parent))),
    ("#if defined(__wasm__) /* kandelo-opcache-file-cache-only */",
     "#if 0 /* unpublished common-memory experiment; shipping recipe retains its guard */"),
]:
    if patched.count(old) != 1:
        raise SystemExit(f"normal recipe anchor changed: {old}")
    patched = patched.replace(old, new, 1)
if args.programs_only:
    start = '# Build ext/curl as a normal shared PHP extension.'
    stop = '# Copy to bin/ with .wasm extension (needed for Vite browser demos)'
    publish = '# Publish through the resolver-owned output without mutating the checkout.'
    sessions = 'source "$REPO_ROOT/scripts/install-local-binary.sh"\nif [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then\n    WASM_POSIX_INSTALL_LOCAL_MIRROR=0 install_local_runtime_file php "$SCRIPT_DIR/sessions.json" sessions.json'
    for anchor in [start, stop, publish, sessions]:
        if patched.count(anchor) != 1:
            raise SystemExit('normal program/extension separation anchor changed')
    patched = patched[:patched.index(start)] + '# Private main-program experiment: optional shared-extension outputs omitted.\n\n' + patched[patched.index(stop):]
    install = '''# Install main programs only into this private unpublished output.
source "$REPO_ROOT/scripts/install-local-binary.sh"
for artifact in php.wasm php-fpm.wasm; do
    WASM_POSIX_INSTALL_LOCAL_MIRROR=0 \\
    WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto \\
        install_local_binary php "$BIN_DIR/$artifact" "$artifact"
done

'''
    patched = patched[:patched.index(publish)] + install + patched[patched.index(sessions):]
if c_opt != 'O2':
    old = 'CFLAGS="-O2 -gline-tables-only $REPRODUCIBLE_PREFIX_MAPS -DZEND_USE_ASM_ARITHMETIC=0"'
    if patched.count(old) != 1:
        raise SystemExit('normal PHP CFLAGS anchor changed')
    new = old.replace('-O2', '-' + c_opt, 1)
    patched = patched.replace(old, new, 1)
if extra_cflags:
    # Configure normally, then apply experimental flags to actual PHP C
    # compile/link rules. In particular profile-use must not reinterpret
    # unrelated autoconf main functions as stale PHP profiles.
    anchor = 'echo "==> Building PHP CLI..."'
    if patched.count(anchor) != 1:
        raise SystemExit('normal PHP make-stage anchor changed')
    flags_patch = '''python3 - <<'KANDELO_PHP_PROFILE_FLAGS'
from pathlib import Path
p = Path('Makefile')
lines = p.read_text().splitlines(keepends=True)
prefix = 'CFLAGS_CLEAN = '
assert sum(line.startswith(prefix) for line in lines) == 1
flags = FLAGS_LITERAL
p.write_text(''.join(line.rstrip('\\n') + ' ' + ' '.join(flags) + '\\n' if line.startswith(prefix) else line for line in lines))
KANDELO_PHP_PROFILE_FLAGS

'''.replace('FLAGS_LITERAL', repr(extra_cflags))
    patched = patched.replace(anchor, flags_patch + anchor, 1)
if extra_link_flags:
    anchor = 'echo "==> Building PHP CLI..."'
    if patched.count(anchor) != 1:
        raise SystemExit('normal PHP make-stage anchor changed')
    link_patch = '''python3 - <<'KANDELO_PHP_LTO_LINK_FLAGS'
from pathlib import Path
p = Path('Makefile')
lines = p.read_text().splitlines(keepends=True)
prefix = 'EXTRA_LDFLAGS_PROGRAM = '
assert sum(line.startswith(prefix) for line in lines) == 1
flags = FLAGS_LITERAL
p.write_text(''.join(line.rstrip('\\n') + ' ' + ' '.join(flags) + '\\n' if line.startswith(prefix) else line for line in lines))
KANDELO_PHP_LTO_LINK_FLAGS

'''.replace('FLAGS_LITERAL', repr(extra_link_flags))
    patched = patched.replace(anchor, link_patch + anchor, 1)
if vm_dispatch:
    anchor = 'echo "==> Building PHP CLI..."'
    if patched.count(anchor) != 1:
        raise SystemExit('normal PHP make-stage anchor changed')
    vm_patch = '''python3 - <<'KANDELO_PHP_VM_GENERATED'
from pathlib import Path
import hashlib, shutil
selection = SELECTION_LITERAL
for item in selection['inputs']:
    target = Path('Zend') / Path(item['path']).name
    assert hashlib.sha256(target.read_bytes()).hexdigest() == item['sha256'], str(target)
for item in selection['outputs']:
    source = Path(item['path'])
    assert hashlib.sha256(source.read_bytes()).hexdigest() == item['sha256'], str(source)
    shutil.copyfile(source, Path('Zend') / source.name)
# Upstream's cross-build generator command must remain empty. A host PHP
# must not silently regenerate the selected headers with default arguments.
php_lines = [line for line in Path('Makefile').read_text().splitlines() if line.startswith('PHP =')]
assert len(php_lines) == 1 and php_lines[0].split('=', 1)[1].strip() == '', php_lines
KANDELO_PHP_VM_GENERATED

'''.replace('SELECTION_LITERAL', repr(vm_dispatch))
    patched = patched.replace(anchor, vm_patch + anchor, 1)
script = base / "experimental-recipe.sh"
script.write_text(patched)
host = subprocess.check_output(["rustc", "-vV"], text=True).split("host: ")[1].splitlines()[0]
driver = root / "target" / host / "debug/xtask"
# Match CacheUseLock's shared flock for the whole private build, not just
# the short dependency-path queries. Children do not inherit the descriptor.
cache_root = Path(os.environ.get('KANDELO_SOURCE_CACHE_ROOT', str(Path.home() / '.cache/kandelo/source-only')))
if not cache_root.is_absolute() or not cache_root.is_dir():
    raise SystemExit('the selected source cache must already be provisioned at an absolute path')
cache_lock = os.open(cache_root / '.kandelo-cache-gc.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o644)
if not stat.S_ISREG(os.fstat(cache_lock).st_mode):
    raise SystemExit('source cache use lock must be a regular file')
try:
    fcntl.flock(cache_lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
except BlockingIOError:
    print('private PHP build: waiting for cache collection to finish', flush=True)
    fcntl.flock(cache_lock, fcntl.LOCK_SH)
env = {**os.environ, "WASM_POSIX_DEP_NAME": "php", "WASM_POSIX_DEP_WORK_DIR": str(work),
       "WASM_POSIX_DEP_OUT_DIR": str(out), "WASM_POSIX_KEEP_BUILD_DIR": "1",
       "WASM_POSIX_INSTALL_LOCAL_MIRROR": "0"}
env.pop("WASM_POSIX_RESOLUTION_POLICY", None)
deps = {}
for dependency in manifest["depends_on"]:
    name = dependency.split("@")[0]
    path = subprocess.check_output([str(driver), "build-deps", "--arch", "wasm32", "path", name],
                                   text=True, env={**os.environ, "WASM_POSIX_RESOLUTION_POLICY": "source-only-v1"}).strip()
    if not Path(path).is_dir():
        raise SystemExit(f"unresolved declared dependency: {name}: {path}")
    if not Path(path).resolve().is_relative_to(cache_root.resolve()):
        raise SystemExit(f'declared dependency lies outside the locked source cache: {name}: {path}')
    env["WASM_POSIX_DEP_" + name.upper().replace("-", "_") + "_DIR"] = path
    deps[name] = path
receipt = {"head": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(),
           "builderSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
           "normalRecipeSha256": hashlib.sha256(source.encode()).hexdigest(),
           "experimentalRecipeSha256": hashlib.sha256(patched.encode()).hexdigest(),
           "phpTargetTailCalls": bool(args.c_tail_calls or args.portable_tailcalls),
           "phpCOptimization": c_opt,
           "phpCLto": args.lto,
           "phpVmDispatch": vm_dispatch,
           "programsOnly": args.programs_only,
           "phpCProfile": profile,
           "extraPhpCFlags": extra_cflags,
           "extraPhpLinkFlags": extra_link_flags,
           "phpCProfileFlagsStage": "make-CFLAGS_CLEAN-after-normal-configure" if profile else "none",
           "phpCFlagsStage": "make-CFLAGS_CLEAN-after-normal-configure" if extra_cflags else "none",
           "sourceCacheRoot": str(cache_root),
           "compilerScope": "PHP C compile/link flags (including normal SDK link glue); dependency/C++ flags and pre-fork Binaryen/fork stages unchanged",
           "phpVersion": manifest["version"], "dependencies": deps,
           "scope": ("unpublished normal-recipe CLI/FPM-only experiment; optional shared extensions not built" if args.programs_only else "unpublished normal-recipe CLI/FPM and optional shared-extension build")
                    + "; shared-OPcache guard disabled, declared PHP C optimization/profile/LTO; no cache/index/image publication",
           "complete": False}
(base / "build-inputs.json").write_text(json.dumps(receipt, indent=2) + "\n")
subprocess.run(["bash", str(script)], env=env, check=True)
if vm_dispatch:
    for item in vm_dispatch['outputs']:
        generated = work / 'source/Zend' / Path(item['path']).name
        if hashlib.sha256(generated.read_bytes()).hexdigest() != item['sha256']:
            raise SystemExit('selected generated header changed during build: ' + str(generated))
# The normal resolver stamps newly built artifacts after the recipe returns.
# This private recipe invocation owns that same post-build step explicitly.
for artifact in sorted(out.iterdir()):
    if artifact.is_file() and artifact.suffix in (".wasm", ".so"):
        subprocess.run([str(driver), "stamp-abi-contract", str(artifact)], env=env, check=True)
receipt["complete"] = True
receipt["artifacts"] = {p.name: {"bytes": p.stat().st_size, "sha256": hashlib.sha256(p.read_bytes()).hexdigest()}
                        for p in out.iterdir() if p.is_file()}
(base / "build-inputs.json").write_text(json.dumps(receipt, indent=2) + "\n")
print(out)
