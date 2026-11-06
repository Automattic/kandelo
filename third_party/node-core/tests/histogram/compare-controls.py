#!/usr/bin/env python3
"""Compare real native owners; numeric tolerance does not apply to CBOR/ints."""
from pathlib import Path
import hashlib
import json
import math
import subprocess
import sys

owner, node, output = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
fixture = Path(__file__).with_name('native-control.js')


def run(command):
    try:
        result = subprocess.run([str(x) for x in command], capture_output=True,
                                text=True, timeout=60)
    except subprocess.TimeoutExpired as error:
        print((error.stdout or b'').decode(errors='replace'), file=sys.stderr)
        print((error.stderr or b'').decode(errors='replace'), file=sys.stderr)
        raise
    if result.stderr:
        print(result.stderr, file=sys.stderr)
    if result.returncode:
        result.check_returncode()
    return result.stdout


def parse(text):
    return dict((key, json.loads(value)) for key, value in
                (line.split('\t', 1) for line in text.splitlines()))


# Shared schema-aware comparator also used by the public N-API control.
exec(Path(__file__).with_name('compare-values.py').read_text())


native_version = run([node, '--version']).strip()
assert native_version == 'v26.13.0', native_version
local = run([owner, '--local'])
(output / 'local.log').write_text(local)
actual_text, expected_text = run([owner]), run([node, fixture])
(output / 'owner.tsv').write_text(actual_text)
(output / 'native.tsv').write_text(expected_text)
actual, expected = parse(actual_text), parse(expected_text)
compare(actual, expected)


# Small, standalone CBOR writer to exercise the actual import parser. The
# controls include valid evolution, malformed data and a >32-bit count. This
# writer is fixture-only and is not part of the histogram implementation.
def uint(n, major=0):
    if n < 24:
        return bytes([major * 32 + n])
    size = 1 if n < 256 else 2 if n < 65536 else 4 if n < 2**32 else 8
    return bytes([major * 32 + {1: 24, 2: 25, 4: 26, 8: 27}[size]]) + n.to_bytes(size, 'big')


def array(values):
    return uint(len(values), 4) + b''.join(uint(v) for v in values)


def mapping(pairs):
    return uint(len(pairs), 5) + b''.join(uint(k) + v for k, v in pairs)


# Derive a layout's real counts_len and index from a native exported map. The
# scalar decoder keeps the malformed case definitions readable and independent
# of the numerical owner implementation.
def decode_at(data, offset=0):
    first = data[offset]; offset += 1
    major, n = first >> 5, first & 31
    if major == 7 and n == 27:
        return data[offset - 1:offset + 8], offset + 8
    if n >= 24:
        size = {24: 1, 25: 2, 26: 4, 27: 8}[n]
        n = int.from_bytes(data[offset:offset + size], 'big'); offset += size
    if major in (4, 5):
        values = []
        for _ in range(n * (2 if major == 5 else 1)):
            value, offset = decode_at(data, offset); values.append(value)
        return values, offset
    return n, offset


decoded, _ = decode_at(bytes.fromhex(expected['one.export']))
fields = dict(zip(decoded[::2], decoded[1::2]))
layout = [(0, uint(2)), (1, uint(1)), (2, uint(1000000)), (3, uint(2)),
          (9, uint(fields[9]))]
idx = fields[10][0]
cases = {
    'empty-input': b'',
    'truncated-map': b'\xa2\x00\x02',
    'valid-empty': mapping(layout),
    'large-count': mapping(layout + [(4, uint(2**32 + 3)), (10, array([idx, 2**32 + 3]))]),
    'large-count-over-safe-number': mapping(layout + [(4, uint(2**53 + 3)), (10, array([idx, 2**53 + 3]))]),
    'int64-count-limit': mapping(layout + [(10, array([idx, 2**63 - 1]))]),
    'count-overflow': mapping(layout + [(10, array([idx, 2**63 - 1, 1, 1]))]),
    'unsigned-count-over-int64': mapping(layout + [(10, array([idx, 2**63]))]),
    'version-1-unknown': mapping([(0, uint(1))] + layout[1:] + [(99, array([1, 2]))]),
    'version-2-unknown': mapping(layout + [(99, array([1, 2]))]),
    'future-version': mapping([(0, uint(3))] + layout[1:]),
    'duplicate-version': mapping(layout + [(0, uint(2))]),
    'bad-counts-len': mapping(layout[:-1] + [(9, uint(fields[9] + 1))]),
    'offset-outside': mapping(layout + [(7, uint(fields[9]))]),
    'offset-wrap': mapping(layout + [(7, uint(2**32))]),
    'wrong-total': mapping(layout + [(4, uint(3)), (10, array([idx, 2]))]),
    'duplicate-index': mapping(layout + [(10, array([idx, 1, 0, 1]))]),
    'index-outside': mapping(layout + [(10, array([fields[9], 1]))]),
    'odd-count-array': mapping(layout + [(10, array([idx]))]),
    'giant-count-array': mapping(layout + [(10, uint(2**60, 4))]),
    'missing-version-unknown': mapping(layout[1:] + [(99, array([1]))]),
    'version-1-unknown-ewma': mapping([(0, uint(1))] + layout[1:] + [(11, mapping([(99, uint(0))]))]),
    'version-2-unknown-ewma': mapping(layout + [(11, mapping([(99, uint(0))]))]),
    'duplicate-ewma-key': mapping(layout + [(11, mapping([(0, uint(0)), (0, uint(0))]))]),
    'unknown-nested-limit': mapping(layout + [(99, b'\x81' * 100 + uint(0))]),
    'trailing-bytes': mapping(layout) + b'\x01\x02\x03',
    'top-level-array': array([1, 2]),
}
results = {}
for name, data in cases.items():
    actual_case = parse(run([owner, '--import', data.hex()]))
    expected_case = parse(run([node, fixture, '--import', data.hex()]))
    compare(actual_case, expected_case, name)
    results[name] = {'bytes': data.hex(), 'valid': 'invalid' not in actual_case}
(output / 'import-controls.json').write_text(json.dumps(results, indent=2) + '\n')
report = {
    'nativeVersion': native_version,
    'nativePath': str(node.resolve()),
    'nativeSha256': hashlib.sha256(node.read_bytes()).hexdigest(),
    'comparedRows': len(expected),
    'importControls': len(cases),
    'numericTolerance': {'fields': 'stats/cdf/meanCI/pair and QRDE quantiles/densities only',
        'relative': 2e-11, 'absolute': 2e-12},
    'integerAndCborComparison': 'exact public binary64 Number equality; lossless BigInt and CBOR string equality',
    'localControls': local.strip(),
    'scope': 'portable host owner only; no guest engine or product validation',
}
(output / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
