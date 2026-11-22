#!/usr/bin/env python3
"""Inventory actual Node embedding inputs; this does not certify behavior.

Read the authoritative engine projection and bridge staging list rather than
maintaining a second source selection. No source, registry or cache mutation.
"""
import argparse
import ast
import hashlib
import json
from pathlib import Path
import re
import tomllib


def inventory(root):
    def identity(path):
        data = path.read_bytes()
        return {'path': str(path.relative_to(root)), 'bytes': len(data),
                'sha256': hashlib.sha256(data).hexdigest()}

    registry = root / 'packages/registry'
    manifest_path = registry / 'spidermonkey-core/engine-patches.json'
    manifest = json.loads(manifest_path.read_text())
    core_metadata = tomllib.loads((registry / 'spidermonkey-core/package.toml').read_text())
    if manifest['sourceSha256'] != core_metadata['source']['sha256']:
        raise ValueError('Engine source and patch projection identities differ')
    patches = []
    for entry in manifest['patches']:
        path = root / manifest['sourcePatchDirectory'] / entry['patch']
        item = identity(path)
        if item['sha256'] != entry['sha256']:
            raise ValueError('Unreviewed engine patch bytes: ' + str(path))
        patches.append({**item, 'owner': 'spidermonkey-core',
                        'chain': 'base-engine-section-projection',
                        'sections': entry['sections'],
                        'active': any(section['include'] for section in entry['sections'])})

    chains = [
        ('spidermonkey-core', registry / 'spidermonkey-core/patches', 'producer-engine'),
        ('spidermonkey-node', registry / 'spidermonkey-node/patches', 'normal-node'),
        ('spidermonkey-node-bridge', registry / 'spidermonkey/node-upstream/native-source-patches', 'native-source'),
    ]
    for owner, directory, chain in chains:
        for path in sorted(directory.glob('*.patch')):
            text = path.read_text()
            touched = sorted(set(re.findall(r'^\+\+\+ b/(.+)$', text, re.M)))
            patches.append({**identity(path), 'owner': owner, 'chain': chain,
                            'active': True, 'touchedFiles': touched,
                            'purposeKey': re.sub(r'^\d+-', '', path.stem),
                            'reviewNotes': str((directory / 'README.md').relative_to(root))
                                if (directory / 'README.md').exists() else
                                str((registry / owner / 'README.md').relative_to(root))})

    builder = registry / 'spidermonkey-node-bridge/build-bridge.py'
    assignments = [node for node in ast.walk(ast.parse(builder.read_text()))
                   if isinstance(node, ast.Assign)
                   and any(isinstance(target, ast.Name) and target.id == 'names'
                           for target in node.targets)
                   and isinstance(node.value, ast.List)]
    if len(assignments) != 1:
        raise ValueError('Review changed bridge staging algorithm before inventorying it')
    names = ast.literal_eval(assignments[0].value)
    if len(names) != len(set(names)) or not all(isinstance(name, str) for name in names):
        raise ValueError('Duplicate or nonliteral bridge input')
    contracts_path = root / 'packages/registry/spidermonkey-node-bridge/contracts.json'
    contracts = json.loads(contracts_path.read_text())
    if contracts['schema'] != 1:
        raise ValueError('Review changed bridge maintenance contract schema')
    by_name = {}
    for contract in contracts['groups']:
        for name in contract['files']:
            if name in by_name:
                raise ValueError('Duplicate bridge maintenance role: ' + name)
            by_name[name] = contract
    if set(by_name) != set(names):
        raise ValueError('Review changed bridge staging roles: ' +
                         repr({'unclassified': sorted(set(names) - set(by_name)),
                               'unstaged': sorted(set(by_name) - set(names))}))
    by_patch = {}
    for contract in contracts['patchGroups']:
        for chain, members in contract['members'].items():
            for name in members:
                key = (chain, name)
                if key in by_patch:
                    raise ValueError('Duplicate patch maintenance role: ' + repr(key))
                by_patch[key] = contract
    active = {(row['chain'], Path(row['path']).name)
              for row in patches if row['active']}
    if set(by_patch) != active:
        raise ValueError('Review changed active patch roles: ' +
                         repr({'unclassified': sorted(active - set(by_patch)),
                               'unselected': sorted(set(by_patch) - active)}))
    for row in patches:
        if row['active']:
            contract = by_patch[(row['chain'], Path(row['path']).name)]
            operation = re.sub(r'^\d+-', '', Path(row['path']).stem).replace('-', ' ')
            row.update(maintenanceContract=contract['id'],
                       why=operation + ': ' + contract['why'],
                       protectingContracts=contract['protectingContracts'],
                       testLimit=contract['testLimit'],
                       selectionScope='Only selected complete sections for projected base patches; other active chains use the complete patch.')
        else:
            row.update(maintenanceContract='preserved-excluded-engine-shell-history',
                       why='Preserve the original shell-only patch history; authoritative engine projection excludes every section from this native runtime.',
                       protectingContracts=[],
                       testLimit='Not compiled or offered as a fallback; no runtime qualification claim.')
    bridge = []
    for name in names:
        if Path(name).name != name:
            raise ValueError('Review new bridge input layout: ' + name)
        contract = by_name[name]
        bridge.append({**identity(registry / 'spidermonkey/node-upstream' / name),
                       'owner': 'spidermonkey-node-bridge',
                       'maintenanceContract': contract['id'], 'why': contract['why'],
                       'protectingContracts': contract['protectingContracts'],
                       'testLimit': contract['testLimit']})

    packages = []
    package_names = ['node-core-source', 'spidermonkey-core', 'spidermonkey-node-bridge',
                 'spidermonkey-node', 'spidermonkey-node-features', 'node',
                 'node-amaro', 'node-libffi', 'kandelo-ffi-adapter',
                 'node-browser-bundle', 'libuv', 'libcxx', 'v8-tracing']
    node = tomllib.loads((registry / 'node/package.toml').read_text())
    dependencies = {name.split('@', 1)[0] for name in node['depends_on']}
    if 'node-undici-llhttp' in dependencies:
        package_names.append('node-undici-llhttp')
    for name in package_names:
        directory = registry / name
        metadata = tomllib.loads((directory / 'package.toml').read_text())
        build = directory / 'build.toml'
        packages.append({'name': name, 'version': metadata['version'],
                         'source': metadata.get('source'),
                         'dependsOn': metadata.get('depends_on', []),
                         'buildRevision': tomllib.loads(build.read_text()).get('revision')
                            if build.exists() else None,
                         'recipeInputs': [identity(directory / 'package.toml')]
                            + ([identity(build)] if build.exists() else [])})
    native_helpers = []
    for package, adapter, preparation, upstream in [
        ('node-amaro', 'node_amaro.cc', 'prepare-native-amaro.py', 'Amaro transformer Wasm'),
        ('node-undici-llhttp', 'node_undici_llhttp.cc', 'prepare-native-undici.py', 'Undici llhttp Wasm'),
    ]:
        if package not in dependencies:
            continue
        native_helpers.append({
            'package': package, 'upstreamHelper': upstream,
            'executionRoute': 'temporary native guest dynamic library',
            'adapter': identity(registry / 'spidermonkey-node' / adapter),
            'preparation': identity(registry / 'spidermonkey-node' / preparation),
            'helperInputs': [identity(path) for path in sorted((registry / package).rglob('*'))
                             if path.is_file()],
            'migration': 'Restore the original upstream Wasm path after equivalent guest Wasm and lifetime qualification on all four hosts; retire native adapter, ABI and package.',
            'migrationRecord': 'packages/registry/spidermonkey-node/MAINTENANCE.md#temporary-native-versions-of-wasm-helpers',
            'runtimeQualifiedByInventory': False,
        })
    return {'schema': 1, 'kind': 'source-maintenance-inventory',
            'behaviorCertified': False,
            'coverageStatus': 'Per-adaptation regression mapping and final-artifact qualification must accompany this inventory before shipping.',
            'engineSelectionAuthority': identity(manifest_path),
            'bridgeSelectionAuthority': identity(builder),
            'bridgeMaintenanceAuthority': identity(contracts_path),
            'packages': packages, 'patches': patches, 'stagedBridgeInputs': bridge,
            'nativeWasmHelpers': native_helpers,
            'excludedShellSectionsAreFallback': False,
            'maintenanceProcedure': 'packages/registry/spidermonkey-node/MAINTENANCE.md'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repository', type=Path, default=Path(__file__).resolve().parents[4])
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    value = inventory(args.repository.resolve())
    # A new evidence path is intentional: never overwrite a release inventory.
    with args.output.open('x') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')
    print(json.dumps({'output': str(args.output), 'patches': len(value['patches']),
                      'stagedBridgeInputs': len(value['stagedBridgeInputs']),
                      'behaviorCertified': False}))


if __name__ == '__main__':
    main()
