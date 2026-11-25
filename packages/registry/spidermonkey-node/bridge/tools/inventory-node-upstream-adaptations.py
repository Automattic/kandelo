#!/usr/bin/env python3
"""Record actual production inputs; an inventory does not certify behavior."""
import argparse
import ast
import hashlib
import json
from pathlib import Path
import re
import tomllib


def inventory(root):
    registry = root / 'packages/registry'
    bridge = registry / 'spidermonkey-node/bridge'
    def identity(path):
        data = path.read_bytes()
        return {'path': str(path.relative_to(root)), 'bytes': len(data),
                'sha256': hashlib.sha256(data).hexdigest()}
    builder = bridge / 'build-bridge.py'
    tree = ast.parse(builder.read_text())
    names = next(ast.literal_eval(n.value) for n in ast.walk(tree)
                 if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'names'
                                                     for t in n.targets))
    contracts = bridge / 'contracts.json'
    groups = json.loads(contracts.read_text())['groups']
    by_name = {name: group for group in groups for name in group['files']}
    if set(by_name) != set(names) or sum(len(g['files']) for g in groups) != len(names):
        raise ValueError('reconcile maintenance contracts with actual bridge inputs')
    sources = [{**identity(bridge / 'src' / name),
                'owner': 'spidermonkey-node',
                'maintenanceContract': by_name[name]['id'],
                'why': by_name[name]['why'],
                'protectingContracts': by_name[name]['protectingContracts'],
                'testLimit': by_name[name]['testLimit']} for name in names]
    patches = []
    for owner, directory in [
        ('spidermonkey-core', registry / 'spidermonkey-core/base-patches'),
        ('spidermonkey-core', registry / 'spidermonkey-core/patches'),
        ('spidermonkey-node', registry / 'spidermonkey-node/patches'),
        ('spidermonkey-node', bridge / 'native-source-patches'),
    ]:
        for path in sorted(directory.glob('*.patch')):
            patches.append({**identity(path), 'owner': owner,
                            'touchedFiles': sorted(set(re.findall(r'^\+\+\+ b/(.+)$', path.read_text(), re.M)))})
    packages = []
    pending = ['node-browser-bundle', 'node-native-lifetime-tests']
    seen = set()
    while pending:
        name = pending.pop()
        if name in seen:
            continue
        seen.add(name)
        path = registry / name / 'package.toml'
        metadata = tomllib.loads(path.read_text())
        packages.append(identity(path))
        pending.extend(dep.rsplit('@', 1)[0] for dep in metadata.get('depends_on', []))
    return {'schema': 1, 'kind': 'source-maintenance-inventory', 'behaviorCertified': False,
            'engineSelectionAuthority': identity(registry / 'spidermonkey-core/build-spidermonkey-core.sh'),
            'bridgeSelectionAuthority': identity(builder),
            'bridgeMaintenanceAuthority': identity(contracts),
            'packages': packages, 'patches': patches, 'stagedBridgeInputs': sources,
            'nativeWasmHelpers': ['node-amaro', 'node-undici-llhttp'],
            'maintenanceProcedure': 'packages/registry/spidermonkey-node/MAINTENANCE.md'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repository', type=Path, default=Path(__file__).resolve().parents[5])
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    with args.output.open('x') as output:
        json.dump(inventory(args.repository.resolve()), output, indent=2)
        output.write('\n')
