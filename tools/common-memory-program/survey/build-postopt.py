#!/usr/bin/env python3
"""CC-04: ordinary Binaryen passes after opt-in VM instrumentation.

Use named runtime bindings; prohibit closed-world/GC type rewriting. Historical
instrumentation counts describe the input transform, while exported global
indices in the prototype report are refreshed for the optimized module.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys


def sha(data):
    return hashlib.sha256(data).hexdigest()


def uleb(data, at=0):
    value = shift = 0
    while True:
        byte = data[at]
        at += 1
        value |= (byte & 127) << shift
        if byte < 128:
            return value, at
        shift += 7
        if shift > 63:
            raise ValueError('oversized unsigned LEB')


def enc(value):
    out = bytearray()
    while True:
        byte, value = value & 127, value >> 7
        out.append(byte | (128 if value else 0))
        if not value:
            return bytes(out)


def name(data, at=0):
    length, at = uleb(data, at)
    end = at + length
    if end > len(data):
        raise ValueError('truncated Wasm name')
    return data[at:end].decode(), end


def inspect(data):
    if data[:8] != b'\0asm\x01\0\0\0':
        raise ValueError('expected core Wasm version 1')
    sections, custom, exports = [], {}, {}
    at = 8
    while at < len(data):
        section = data[at]
        length, start = uleb(data, at + 1)
        end = start + length
        if end > len(data):
            raise ValueError('truncated Wasm section')
        payload = data[start:end]
        sections.append((section, payload))
        if section == 0:
            key, body = name(payload)
            if key in custom:
                raise ValueError(f'duplicate custom section: {key}')
            custom[key] = payload[body:]
        elif section == 7:
            count, pos = uleb(payload)
            for _ in range(count):
                key, pos = name(payload, pos)
                kind = payload[pos]
                index, pos = uleb(payload, pos + 1)
                exports[key] = (kind, index)
            if pos != len(payload):
                raise ValueError('unexpected export section suffix')
        at = end
    return sections, custom, exports


def refresh(before, after, level, version):
    _, old_custom, old_exports = inspect(before)
    sections, custom, exports = inspect(after)
    if {k: v[0] for k, v in old_exports.items()} != {k: v[0] for k, v in exports.items()}:
        raise ValueError('optimizer changed named exports or their kinds')
    key = 'kandelo.common-memory.prototype'
    # Normal fork metadata binds by named exports/imports. Preserve its exact
    # payloads, ABI admission and every other Kandelo custom contract.
    for contract in old_custom:
        if contract.startswith('kandelo.') and contract != key:
            if custom.get(contract) != old_custom[contract]:
                raise ValueError(f'optimizer changed contract: {contract}')
    if custom.get(key) != old_custom[key]:
        raise ValueError('optimizer changed prototype report unexpectedly')
    report = json.loads(custom[key])
    original = {k: report[k] for k in ['rootGlobal', 'scratchGlobal']}
    for field, export in [('rootGlobal', '__vm_root'), ('scratchGlobal', '__vm_scratch')]:
        kind, index = exports[export]
        if kind != 3:
            raise ValueError(f'{export} is no longer an exported global')
        report[field] = index
    report['postOptimization'] = {
        'level': level, 'optimizer': version, 'inputSha256': sha(before),
        'inputGlobalIndices': original,
        'instrumentationStatisticsDescribeInputTransform': True,
        'definedFunctionsAfter': next(uleb(body)[0] for section, body in sections if section == 10),
    }
    payload = json.dumps(report, separators=(',', ':')).encode()
    result = bytearray(after[:8])
    for section, body in sections:
        if section == 0 and name(body)[0] == key:
            encoded_name = key.encode()
            body = enc(len(encoded_name)) + encoded_name + payload
        result += bytes([section]) + enc(len(body)) + body
    return bytes(result), report


def main():
    source, out = map(lambda p: Path(p).resolve(), sys.argv[1:3])
    reference = sys.argv[3] if len(sys.argv) > 3 else 'baseline'
    out.mkdir(parents=True, exist_ok=False)
    manifest = json.loads((source / 'manifest.json').read_text())
    version = subprocess.check_output(['wasm-opt', '--version'], text=True).strip()
    base = manifest['variants'][reference]
    result = {
        'scope': 'Opt-in post-VM ordinary Binaryen levels; no closed-world or GC type passes',
        'optimizer': version, 'reference': reference,
        'sources': {str(Path(__file__).resolve()): sha(Path(__file__).read_bytes()),
                    str(source / 'manifest.json'): sha((source / 'manifest.json').read_bytes())},
        'variants': {'baseline': manifest['variants']['baseline'], reference: base},
        'pairReferences': {}, 'runs': [],
    }
    def save():
        (out / 'manifest.json').write_text(json.dumps(result, indent=2) + '\n')
    save()
    for level in ['O2', 'O3', 'Os']:
        mode = 'post-' + level.lower()
        artifacts = {}
        result['variants'][mode] = {'ids': [*base.get('ids', []), 'CC-04'], 'artifacts': artifacts}
        for kind, artifact in base['artifacts'].items():
            original = Path(artifact['path']).read_bytes()
            if sha(original) != artifact['sha256']:
                raise ValueError(f'input identity changed: {kind}')
            raw = out / f'{kind}-{mode}.unrefreshed.wasm'
            # The appended VM helpers already use SIMD, threads and bulk
            # memory. The prototype does not merge their target_features;
            # hand-authored input fixtures may have no feature section at all.
            # Declare these existing requirements, preserving failed preflights.
            args = ['wasm-opt', '--enable-simd', '--enable-threads',
                    '--enable-bulk-memory', '--enable-bulk-memory-opt',
                    '-' + level, artifact['path'], '-o', str(raw)]
            run = subprocess.run(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            (out / f'{kind}-{mode}.log').write_text(run.stdout)
            result['runs'].append({'kind': kind, 'mode': mode, 'args': args, 'exit': run.returncode})
            save()
            if run.returncode:
                raise RuntimeError(f'{kind}/{mode} failed; raw failure evidence retained')
            optimized, report = refresh(original, raw.read_bytes(), level, version)
            path = out / f'{kind}-{mode}.wasm'
            path.write_bytes(optimized)
            (out / f'{kind}-{mode}.json').write_text(json.dumps(report, indent=2) + '\n')
            artifacts[kind] = {'path': str(path), 'sha256': sha(optimized), 'bytes': len(optimized)}
            save()
        result['pairReferences'][mode] = reference
        save()
    print(json.dumps({'output': str(out), 'variants': list(result['variants']), 'optimizer': version}))


if __name__ == '__main__':
    main()
