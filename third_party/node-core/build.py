#!/usr/bin/env python3
"""Bundle pinned, unmodified Node sources without network or npm."""
from pathlib import Path
import hashlib
import json
import sys

root = Path(__file__).resolve().parent
manifest = json.loads((root / 'sources.json').read_text())
entries = []
for name, item in manifest['modules'].items():
    raw = (root / item['path']).read_bytes()
    if hashlib.sha256(raw).hexdigest() != item['sha256']:
        raise ValueError(f'Node source hash mismatch: {name}')
    source = raw.decode()
    if name == 'internal/assert/utils':
        # This engine has no Node error-source binding. Preserve the default
        # assertion failure when no expression is available, rather than feed
        # an undefined message into the upstream message validator.
        old = 'messageArgs = [getErrMessage(fn)];'
        if source.count(old) != 1:
            raise ValueError('review the assertion diagnostic adaptation')
        source = source.replace(old, 'const expression = getErrMessage(fn);\n'
                                '      messageArgs = expression === undefined ? [] : [expression];')
    entries.append(json.dumps(name) + ': function(module, exports, require, primordials, internalBinding) {\n' + source + '\n}')
license_text = (root / 'LICENSE').read_text().split('The Node.js license applies', 1)[0]
bundle = '/* Node.js ' + manifest['version'] + '\n' + license_text + '\n*/\n'
bundle += (root / 'adapter.js').read_text().replace('/* UPSTREAM_MODULES */', ',\n'.join(entries))
dest = root / 'node-core.js'
if '--check' in sys.argv:
    if dest.read_text() != bundle:
        raise SystemExit('Node core bundle needs regeneration')
else:
    dest.write_text(bundle)
