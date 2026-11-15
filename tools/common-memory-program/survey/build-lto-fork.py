#!/usr/bin/env python3
"""Private multi-file SDK/LTO fork mechanism; raw and PHP-like pre-O2 paths."""
from pathlib import Path
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys

if not os.environ.get('KANDELO_DEV_SHELL_TOOL_PATH'):
    raise SystemExit('run through scripts/dev-shell.sh')
out = Path(sys.argv[1]).resolve()
if sys.argv[2:] not in ([], ['--lto-link-lowering']):
    raise SystemExit('usage: build-lto-fork.py FRESH_DIR [--lto-link-lowering]')
lowering = ['-Wl,--mllvm=-wasm-enable-sjlj', '-Wl,--mllvm=-wasm-use-legacy-eh=false',
            '-Wl,--mllvm=-exception-model=wasm'] if sys.argv[2:] else []
out.mkdir(parents=True, exist_ok=False)
source = Path(__file__).parent
for p in [Path(__file__), *sorted(source.glob('lto-fork*.[ch]'))]:
    shutil.copy2(p, out / p.name)
commands = []
manifest = {'scope': 'CC-02 real multi-file indirect-callback/fork feasibility, not performance',
            'variants': {}, 'failures': [], 'ltoBackendLinkFlags': lowering,
            'flags': {'none': [], 'full': ['-flto=full'], 'thin': ['-flto=thin']}}

def save():
    (out / 'commands.json').write_text(json.dumps(commands, indent=2) + '\n')
    (out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')

def run(label, args):
    args = list(map(str, args))
    result = subprocess.run(args, capture_output=True, text=True)
    (out / (label + '.log')).write_text(result.stdout + result.stderr)
    commands.append({'label': label, 'args': args, 'exit': result.returncode})
    save()
    result.check_returncode()
    return result.stdout

def identity(path):
    raw = path.read_bytes()
    return {'path': str(path), 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}

def audit(path):
    raw = path.read_bytes()
    assert raw[:8] == b'\0asm\x01\0\0\0'
    def leb(offset):
        value, shift = 0, 0
        while True:
            byte = raw[offset]; offset += 1
            value |= (byte & 127) << shift
            if byte < 128: return value, offset
            shift += 7
            assert shift < 35
    offset, custom, code = 8, [], None
    while offset < len(raw):
        section = raw[offset]; size, start = leb(offset + 1); end = start + size
        assert end <= len(raw)
        if section == 10: code = hashlib.sha256(raw[start:end]).hexdigest()
        if section == 0:
            size, data = leb(start)
            name = raw[data:data + size].decode(); payload = raw[data + size:end]
            if name.startswith('kandelo.calltypes'):
                custom.append({'name': name, 'bytes': len(payload), 'sha256': hashlib.sha256(payload).hexdigest(),
                               **({'boundCodeSha256': payload.hex()} if name.endswith('code-sha256') else {})})
        offset = end
    return {'codeSha256': code, 'compilerSections': custom,
            'hashMatches': any(x.get('boundCodeSha256') == code for x in custom)}

host = subprocess.check_output(['rustc', '-vV'], text=True).split('host: ')[1].splitlines()[0]
instrument = Path('tools/common-memory-program/instrument/target') / host / 'debug/common-memory-program-instrument'
run('translator-build', ['cargo', 'build', '--manifest-path', 'tools/common-memory-program/instrument/Cargo.toml', '--target', host])
helper_manifest = json.loads(Path('.scratch/common-memory-survey-object-regions-1/manifest.json').read_text())
helper = helper_manifest['originalHelper']['path']
manifest['helper'] = identity(Path(helper))
for mode, flags in manifest['flags'].items():
    try:
        objects = []
        for unit in ('main', 'actions', 'dispatch'):
            obj = out / f'{mode}-{unit}.o'
            run(f'{mode}-{unit}', ['sdk/bin/wasm32posix-cc', '-O2', '-pthread', *flags,
                                  '-c', out / f'lto-fork-{unit}.c', '-o', obj])
            objects.append(obj)
        linked = out / f'{mode}-linked.wasm'
        run(f'{mode}-link', ['sdk/bin/wasm32posix-cc', '-O2', '-pthread', *flags,
                           *(lowering if mode != 'none' else []), *objects, '-o', linked])
        for preparation in ('raw', 'preopt'):
            key = f'{mode}-{preparation}'
            try:
                before = linked
                if preparation == 'preopt':
                    before = out / f'{key}.wasm'
                    run(key + '-opt', ['wasm-opt', '-O2', linked, '-o', before])
                wat = out / f'{key}.wat'
                run(key + '-dis', ['wasm-dis', before, '-o', wat])
                text = wat.read_text()
                indirect = len(re.findall(r'\(call_indirect\b', text))
                assert indirect > 0, 'fixture lost all indirect calls'
                report = run(key + '-sinks', ['scripts/run-wasm-fork-instrument.sh', before, '--sink-report'])
                native, virtual = out / f'{key}-native.wasm', out / f'{key}-vm.wasm'
                run(key + '-fork', ['scripts/run-wasm-fork-instrument.sh', before, '-o', native])
                run(key + '-stamp', ['cargo', 'run', '-p', 'xtask', '--target', host, '--quiet', '--', 'stamp-abi-contract', native])
                translated = json.loads(run(key + '-vm', [instrument, native, helper, virtual, '--outline-accesses']))
                manifest['variants'][key] = {'native': identity(native), 'vm': identity(virtual),
                    'beforeFork': identity(before), 'metadata': audit(before), 'indirectCallSites': indirect,
                    'definedFunctions': len(re.findall(r'^\s*\(func\s+\$', text, re.M)),
                    'analysisSource': next((line for line in report.splitlines() if line.startswith('source\t')), 'not-found'),
                    'translation': translated}
                save()
            except Exception as error:
                manifest['failures'].append({'mode': mode, 'preparation': preparation, 'error': str(error)}); save()
    except Exception as error:
        manifest['failures'].append({'mode': mode, 'error': str(error)}); save()
manifest['sources'] = {p.name: identity(p) for p in out.glob('lto-fork*.[ch]')}
save()
print(json.dumps({'variants': list(manifest['variants']), 'failures': manifest['failures']}))
if manifest['failures'] or len(manifest['variants']) != 6:
    raise SystemExit(1)
