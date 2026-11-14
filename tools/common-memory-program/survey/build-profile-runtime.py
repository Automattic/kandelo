#!/usr/bin/env python3
"""Provision the upstream target profile runtime privately through the SDK.

Use the exact upstream PROFILE_SOURCES list and real compile/link feature
probes, without giving Kandelo a Linux/WASI identity or changing a shared SDK.
"""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

source, out = map(lambda p: Path(p).resolve(), sys.argv[1:3])
out.mkdir(parents=True, exist_ok=False)
profile = source / 'compiler-rt/lib/profile'
cmake = (profile / 'CMakeLists.txt').read_text()
match = re.search(r'set\(PROFILE_SOURCES\s+(.*?)\s*\)', cmake, re.S)
if not match:
    raise ValueError('upstream PROFILE_SOURCES list not found')
files = match[1].split()
if len(files) != 19 or len(set(files)) != len(files) or not all((profile / name).is_file() for name in files):
    raise ValueError('unexpected upstream profile source inventory')
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
manifest = {
    'scope': 'Private upstream LLVM21.1.7 Wasm profile runtime, normal Kandelo SDK',
    'source': str(source), 'sources': {str(profile / f): sha(profile / f) for f in files},
    'upstreamCmakeSha256': sha(profile / 'CMakeLists.txt'),
    'scriptSha256': sha(__file__), 'commands': [], 'features': {}, 'objects': {},
}


def save():
    (out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')


def run(label, args, required=True):
    result = subprocess.run(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    (out / (label + '.log')).write_text(result.stdout)
    manifest['commands'].append({'label': label, 'args': args, 'exit': result.returncode})
    save()
    if required and result.returncode:
        raise RuntimeError(f'{label} failed; exact command and output retained')
    return result


manifest['compiler'] = subprocess.check_output(['wasm32posix-cc', '--version'], text=True)
save()
probes = {
    'ATOMICS': 'int main(void){volatile unsigned long n=1;__sync_synchronize();__sync_val_compare_and_swap(&n,1,0);__sync_add_and_fetch(&n,1);__sync_sub_and_fetch(&n,1);return 0;}',
    'FCNTL_LCK': '#include <fcntl.h>\nint main(void){struct flock f;f.l_type=F_WRLCK;return fcntl(-1,F_SETLKW,&f);}',
    'FLOCK': '#include <sys/file.h>\nint main(void){return flock(-1,LOCK_EX);}',
    'UNAME': '#include <sys/utsname.h>\nint main(void){struct utsname n;return uname(&n);}',
}
flags = []
for feature, text in probes.items():
    path = out / (feature.lower() + '.c')
    path.write_text(text + '\n')
    result = run('probe-' + feature.lower(), ['wasm32posix-cc', '-O2', str(path), '-o', str(out / (feature.lower() + '.wasm'))], required=False)
    supported = result.returncode == 0
    manifest['features'][feature] = supported
    if supported:
        flags.append('-DCOMPILER_RT_HAS_' + feature + '=1')
    save()
objects = []
for name in files:
    path = profile / name
    output = out / (name + '.o')
    cxx = name.endswith('.cpp')
    args = ['wasm32posix-c++' if cxx else 'wasm32posix-cc', '-O2', '-c',
            '-I' + str(source / 'compiler-rt/include'), '-I' + str(profile.parent),
            *flags, *(['-fno-exceptions', '-fno-rtti', '-nostdinc++'] if cxx else []),
            str(path), '-o', str(output)]
    run('compile-' + name, args)
    objects.append(str(output))
    manifest['objects'][name] = {'sha256': sha(output), 'bytes': output.stat().st_size}
    save()
archive = out / 'libclang_rt.profile.a'
run('archive', ['wasm32posix-ar', 'rcs', str(archive), *objects])
manifest['archive'] = {'path': str(archive), 'sha256': sha(archive), 'bytes': archive.stat().st_size}
save()
print(json.dumps({'output': str(out), 'features': manifest['features'], 'archive': manifest['archive']}))
