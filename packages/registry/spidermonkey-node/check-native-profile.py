#!/usr/bin/env python3
"""Reject an upstream configuration that silently omitted required owners."""
import ast
from pathlib import Path
import sys

document = ast.literal_eval(Path(sys.argv[1]).read_text())
variables = document['variables']
profile = sys.argv[2]
if profile not in ('default', 'features'):
    raise SystemExit('ERROR: unknown native Node build profile: ' + profile)
expected = {'target_arch': 'wasm32', 'node_use_bundled_v8': 'false',
            'v8_enable_inspector': 0, 'node_use_node_snapshot': 'false',
            'node_use_openssl': 'true', 'node_use_sqlite': 'true',
            'openssl_version': 0x3050009f,
            'node_use_ffi': 'true', 'node_use_amaro': 'true',
            'node_use_v8_platform': 'true',
            'node_use_quic': 'true' if profile == 'features' else 'false',
            'node_use_dtls': 'true' if profile == 'features' else 'false'}
errors = [f'{key}: expected {value!r}, got {variables.get(key)!r}'
          for key, value in expected.items() if variables.get(key) != value]
if errors:
    raise SystemExit('ERROR: incomplete native Node profile; implement the missing target backends: ' + '; '.join(errors))
