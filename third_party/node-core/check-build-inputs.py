#!/usr/bin/env python3
"""Check the engine's declared Node core source/verification inputs.

This is a conservative, source-only package preflight, not a dynamic read
tracer or a complete SDK/toolchain closure proof. Root production files,
manifest references, unity fragments and literal generator/shell paths
must all be keyed. Docs and standalone controls are deliberately outside this set.
"""
import argparse
import ast
import json
from pathlib import Path, PurePosixPath
import re
import sys
import tomllib

CORE = 'third_party/node-core'
RECIPE = 'packages/registry/spidermonkey/build.toml'
BUILD = 'packages/registry/spidermonkey/build-spidermonkey.sh'
PRODUCTION_SUFFIXES = {'.js', '.cpp', '.cc', '.h', '.py', '.json'}


def repository_path(value):
    if not isinstance(value, str) or not value or '\\' in value:
        raise ValueError(f'Invalid repository input path: {value!r}')
    path = PurePosixPath(value)
    if path.is_absolute() or '..' in path.parts or str(path) != value:
        raise ValueError(f'Noncanonical repository input path: {value!r}')
    return value


def inspect(repo):
    repo = repo.resolve()
    root = repo / CORE
    required = {}

    def require(relative, reason):
        relative = repository_path(relative)
        path = repo / relative
        if not path.resolve().is_relative_to(repo) or not path.is_file():
            raise ValueError(f'Missing or escaping {reason}: {relative}')
        required.setdefault(relative, set()).add(reason)

    def require_tree(relative, reason):
        relative = repository_path(relative)
        path = repo / relative
        if not path.resolve().is_relative_to(repo) or not path.is_dir():
            raise ValueError(f'Missing or escaping {reason}: {relative}')
        # Directory staging consumes every nested input, including headers that
        # have no literal reference in the embedding generator or manifest.
        for child in sorted(path.rglob('*')):
            if not child.resolve().is_relative_to(repo):
                raise ValueError(f'Escaping {reason}: {child.relative_to(repo)}')
            if child.is_symlink() and child.is_dir():
                raise ValueError(f'Review linked directory in {reason}: {child.relative_to(repo)}')
            if child.is_file():
                require(str(child.relative_to(repo)), reason)
            elif not child.is_dir():
                raise ValueError(f'Missing {reason}: {child.relative_to(repo)}')

    # All root production owners are conservative inputs, including helpers
    # used through computed names that a literal-read scan would miss.
    for path in sorted(root.iterdir()):
        if path.is_file() and (path.suffix in PRODUCTION_SUFFIXES or path.name == 'LICENSE'):
            require(f'{CORE}/{path.name}', 'core production owner')

    def literal_core_path(node):
        if isinstance(node, ast.Name) and node.id in ('root', 'ROOT'):
            return ''
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div):
            parent = literal_core_path(node.left)
            if parent is not None and isinstance(node.right, ast.Constant) and isinstance(node.right.value, str):
                return (parent + '/' if parent else '') + node.right.value
        return None

    for script in sorted(root.glob('*.py')):
        for node in ast.walk(ast.parse(script.read_text())):
            relative = literal_core_path(node)
            if relative:
                relative = repository_path(relative)
                # Intermediate directory expressions do not denote file reads.
                if not (root / relative).is_dir():
                    require(f'{CORE}/{relative}', 'literal generator path')

    manifest = json.loads((root / 'sources.json').read_text())

    def references(value):
        if isinstance(value, dict):
            if isinstance(value.get('path'), str) or ('path' in value and 'sha256' in value):
                relative = repository_path(value['path'])
                require(f'{CORE}/{relative}', 'manifest reference')
            for child in value.values():
                references(child)
        elif isinstance(value, list):
            for child in value:
                references(child)

    references(manifest)
    tree = ast.parse((root / 'generate-native-embedding.py').read_text())
    fragments = [statement for statement in tree.body
                 if isinstance(statement, ast.Assign) and any(
                     isinstance(target, ast.Name) and target.id == 'FRAGMENTS'
                     for target in statement.targets)]
    if len(fragments) != 1:
        raise ValueError('Review native embedding FRAGMENTS declaration')
    values = ast.literal_eval(fragments[0].value)
    if not isinstance(values, (tuple, list)) or not values:
        raise ValueError('Native embedding FRAGMENTS must be a nonempty literal sequence')
    for value in values:
        require(f'{CORE}/{repository_path(value)}', 'unity fragment')

    require(BUILD, 'engine build script')
    shell = (repo / BUILD).read_text()
    for relative in re.findall(r'\$REPO_ROOT/(third_party/node-core/[^"\s$]+)', shell):
        if (repo / relative).is_dir():
            require_tree(relative, 'literal engine build input')
        else:
            require(relative, 'literal engine build input')

    recipe = tomllib.loads((repo / RECIPE).read_text())
    inputs = recipe['inputs']
    if not isinstance(inputs, list) or not inputs:
        raise ValueError('Engine recipe must declare nonempty inputs')
    declared = []
    for value in inputs:
        if isinstance(value, str) and value.startswith('cargo:'):
            continue  # Resolver-owned crate expansion, not a filesystem path.
        declared.append(repository_path(value))

    exact = set(declared)
    directories = tuple(entry for entry in declared if (repo / entry).is_dir())

    def covered(relative):
        return relative in exact or any(relative.startswith(entry + '/') for entry in directories)

    missing = sorted(relative for relative in required if not covered(relative))
    return {
        'scope': 'Conservative core production files, manifest references, unity fragments and literal generator/engine shell paths;not dynamic SDK/toolchain closure or runtime conformance',
        'requiredFileCount': len(required),
        'requiredFiles': {key: sorted(value) for key, value in sorted(required.items())},
        'missingDeclaredInputs': missing,
        'ok': not missing,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo-root', type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument('--quiet', action='store_true', help='Print one line on success;retain failure details')
    args = parser.parse_args()
    try:
        report = inspect(args.repo_root)
    except (ValueError, OSError, SyntaxError, KeyError, TypeError) as error:
        print(json.dumps({'ok': False, 'error': str(error)}, indent=2))
        return 1
    if args.quiet and report['ok']:
        print(f"Node core build inputs: {report['requiredFileCount']} files covered")
    else:
        print(json.dumps(report, indent=2))
    return 0 if report['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
