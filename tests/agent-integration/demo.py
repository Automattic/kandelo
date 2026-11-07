#!/usr/bin/env python3
"""Integrate actual CLI docs/schema in isolated sparse clones; no manager emulation."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

from support import REPO
from agent_integration import gitops as g
from agent_integration.manifest import digest


FILES = ['docs/agent-integration.md', 'scripts/agent_integration/manifest-v1.schema.json',
         'scripts/agent_integration/result-v1.schema.json']


def cli(root, *args, expected=0):
    argv = [sys.executable, str(REPO / 'scripts/agent-integrate'), '--root', str(root), *map(str, args)]
    p = subprocess.run(argv, cwd=REPO, capture_output=True)
    if p.returncode != expected:
        raise RuntimeError(f'{argv!r}: expected {expected}, got {p.returncode}\n' + (p.stdout + p.stderr).decode())
    return p.stdout


def demonstrate(output):
    output.mkdir(parents=True, exist_ok=False)
    base = g.rev(REPO, 'HEAD')
    source, target = output / 'source', output / 'target'
    for root in (source, target):
        subprocess.run(['git', 'clone', '-q', '--shared', '--no-checkout', str(REPO), str(root)], check=True)
        for key, value in [('user.name', 'Isolated Integration Demo'), ('user.email', 'integration@example.invalid'),
                           ('commit.gpgsign', 'false')]:
            g.git(root, 'config', key, value)
        g.git(root, 'sparse-checkout', 'set', '--no-cone', '/scripts/agent-job',
              '/docs/agent-integration.md', '/scripts/agent_integration/*.schema.json')
        g.git(root, 'checkout', '-q', '-b', 'isolated-demo', base)
        with (root / '.git/info/exclude').open('a') as stream:
            stream.write('\n.context/\n')
    for name in FILES:
        dest = source / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes((REPO / name).read_bytes())
    # Make an actual reviewed change even after these files have landed.
    with (source / FILES[0]).open('a') as stream:
        stream.write('\n<!-- Isolated integration review: documentation scope only. -->\n')
    g.git(source, 'add', '--sparse', '--', *FILES)
    g.git(source, 'commit', '-qm', 'Docs: Describe reviewed integration evidence boundary')
    reviewed = g.rev(source, 'HEAD')
    owned = sorted(g.names(g.git(source, 'diff', '--no-renames', '--name-only', '-z', base, reviewed)))
    before = {}
    for name in owned:
        present = g.git(target, 'ls-tree', '--name-only', base, '--', name)
        before[name] = digest(g.git(target, 'show', base + ':' + name)) if present else None
    g.git(target, 'update-ref', 'refs/remotes/origin/main', base)
    context = target / '.context'
    context.mkdir()
    patch = g.git(source, 'diff', '--binary', '--no-renames', base, reviewed, '--', *FILES)
    (context / 'reviewed.patch').write_bytes(patch)
    (context / 'review.json').write_text(json.dumps({
        'scope': 'reviewed tooling documentation and schema only; no runtime claim',
        'source_commit': reviewed, 'files': owned}, indent=2) + '\n')
    (target / 'unrelated-demo.txt').write_text('unrelated staged work\n')
    g.git(target, 'add', '--sparse', '--', 'unrelated-demo.txt')
    (target / 'unrelated-demo.txt').write_text('unrelated unstaged work\n')
    argv = [sys.executable, '-m', 'json.tool', 'scripts/agent_integration/manifest-v1.schema.json']
    manifest = {
        'version': 1, 'id': 'real-docs-integration', 'base_commit': base,
        'main': {'ref': 'refs/remotes/origin/main', 'commit': base},
        'source': {'root': str(source), 'commit': reviewed, 'ref': 'HEAD',
                   'identities': {n: digest((source / n).read_bytes()) for n in owned}},
        'owned_paths': owned, 'protected_paths': ['scripts/agent-job'],
        'patch': {'path': '.context/reviewed.patch', 'sha256': digest(patch),
                  'before': before, 'after': {n: digest((source / n).read_bytes()) for n in owned}},
        'target_pins': [], 'inputs': [{'path': n, 'sha256': digest((target / n).read_bytes())}
                                     for n in FILES[1:] if n not in owned], 'seals': [],
        'evidence': [{'path': '.context/review.json', 'sha256': digest((context / 'review.json').read_bytes()),
                      'dimension': 'inventory', 'scope': 'reviewed tooling documentation/schema only', 'outcome': 'unsupported',
                      'source_commit': reviewed, 'reused': False}],
        'checks': [{'id': 'schema-json', 'argv': argv, 'cwd': '.', 'dimension': 'source',
                    'scope': 'manifest JSON syntax only; no CLI or runtime support claim', 'timeout_seconds': 30}],
        'checkpoint': {'scope': 'documentation/schema integration only',
                       'blockers': ['validation manager adapter pending', 'runtime conformance unestablished']}}
    spec = context / 'manifest.json'
    spec.write_text(json.dumps(manifest, indent=2) + '\n')
    (output / 'preflight.log').write_bytes(cli(target, 'preflight', spec))
    (output / 'apply-handoff.log').write_bytes(cli(target, 'run', spec, expected=3))
    handoff = json.loads(cli(target, 'handoff', manifest['id'], '--json'))
    (output / 'check-request.json').write_text(json.dumps(handoff, indent=2) + '\n')
    # This is a single manual demonstration check, not a runner or plan executor.
    # No manager API is assumed. Its integration remains a separate follow-up.
    with (context / 'schema-check.log').open('wb') as log:
        result = subprocess.run(argv, cwd=target, stdout=log, stderr=subprocess.STDOUT, timeout=30)
    if result.returncode:
        raise RuntimeError('schema check failed; see target/.context/schema-check.log')
    report = {'version': 1, 'source_binding': handoff['source_binding'], 'check_id': 'schema-json',
              'argv': argv, 'cwd': '.', 'job_id': 'manual-demo-check-1', 'state': 'finished',
              'outcome': 'pass', 'exit_code': 0, 'reused': False,
              'log': {'path': '.context/schema-check.log', 'sha256': digest((context / 'schema-check.log').read_bytes())}}
    raw = json.dumps(report, indent=2).encode() + b'\n'
    report_path = context / 'manual-check-result.json'
    report_path.write_bytes(raw)
    (output / 'checkpoint.log').write_bytes(cli(target, 'record', manifest['id'], '--report', report_path, '--sha256', digest(raw)))
    before_resume = (context / 'agent-integrations' / manifest['id'] / 'ledger.json').read_bytes()
    (output / 'resume.log').write_bytes(cli(target, 'resume', manifest['id']))
    assert before_resume == (context / 'agent-integrations' / manifest['id'] / 'ledger.json').read_bytes()
    assert g.rev(target, 'HEAD') == base
    assert g.git(target, 'show', ':unrelated-demo.txt') == b'unrelated staged work\n'
    assert (target / 'unrelated-demo.txt').read_bytes() == b'unrelated unstaged work\n'
    staged = g.names(g.git(target, 'diff', '--cached', '--no-renames', '--name-only', '-z'))
    assert staged == set(owned) | {'unrelated-demo.txt'}
    assert all((source / n).read_bytes() == (target / n).read_bytes() for n in FILES)
    status = cli(target, 'status', manifest['id'], '--json')
    (output / 'status.json').write_bytes(status)
    summary = {'scope': 'real tooling docs/schema change; manually observed source-only check',
               'base_commit': base, 'reviewed_source_commit': reviewed, 'owned_paths': owned,
               'source_binding': handoff['source_binding'], 'checkpoint_count': 1,
               'target_head_unchanged': True, 'unrelated_staged_and_unstaged_work_preserved': True,
               'validation_manager_adapter': 'pending', 'old_new_round_trip_comparison': 'pending manager integration',
               'artifacts': str(output)}
    (output / 'demonstration.json').write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True, help='new directory; never overwrites a prior run')
    args = parser.parse_args()
    demonstrate(args.output.resolve())
