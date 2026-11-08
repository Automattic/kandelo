#!/usr/bin/env python3
"""Give the engine its exact immutable resolver key, or a fresh manual build ID.

Manual recipe invocation has no resolver content key. A fresh build-instance
nonce deliberately prevents old independent manual builds sharing a cache ID.
It is never described as a resolver recipe key or a reproducible source hash.
"""
import argparse
import json
import os
from pathlib import Path
import re
import secrets


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    key = os.environ.get('WASM_POSIX_DEP_BUILD_KEY_SHA256')
    if key is not None:
        if re.fullmatch(r'[0-9a-f]{64}', key) is None:
            parser.error('WASM_POSIX_DEP_BUILD_KEY_SHA256 must be the exact lowercase SHA-256 resolver key')
        kind = 'resolver-cache-key'
        identity = 'kandelo-sm-resolver:' + key
    elif 'WASM_POSIX_DEP_NAME' in os.environ:
        parser.error('resolver recipe environment has no WASM_POSIX_DEP_BUILD_KEY_SHA256; rebuild/use the matching resolver, do not substitute a manual identity')
    else:
        kind = 'manual-build-instance'
        identity = 'kandelo-sm-manual:' + secrets.token_hex(32)
    text = ('// Generated actual engine build identity; never edit.\n'
            '#ifndef KANDELO_NODE_ENGINE_BUILD_ID_H\n'
            '#define KANDELO_NODE_ENGINE_BUILD_ID_H\n'
            '#define KANDELO_ENGINE_BUILD_ID ' + json.dumps(identity) + '\n'
            '#define KANDELO_ENGINE_BUILD_ID_SOURCE ' + json.dumps(kind) + '\n'
            '#endif\n')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(text)


if __name__ == '__main__':
    main()
