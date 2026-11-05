#!/usr/bin/env python3
"""Select unchanged c-ares error naming from the exact audited Node pin."""
from pathlib import Path
import argparse, hashlib, json
root = Path(__file__).resolve().parent
spec = json.loads((root / 'sources.json').read_text())['dnsRecords']['sources']['nativeHeader']
raw = (root / spec['path']).read_bytes()
if hashlib.sha256(raw).hexdigest() != spec['sha256']:
    raise ValueError('DNS native header identity mismatch')
text = raw.decode()
start = text.index('inline const char* ToErrorCodeString(int status) {')
end = text.index('\n}', start) + 2
constant = 'constexpr int DNS_ESETSRVPENDING = -1000;'
assert constant in text
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
args.output.write_text('// Generated from pinned src/cares_wrap.h, unchanged selected definitions.\n'
    '#ifndef KANDELO_NODE_DNS_CONSTANTS_H\n#define KANDELO_NODE_DNS_CONSTANTS_H\n'
    '#include <ares.h>\nnamespace kandelo::dns {\n' + constant + '\n' + text[start:end] +
    '\n}  // namespace kandelo::dns\n#endif\n')
