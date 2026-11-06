#!/usr/bin/env python3
"""Focused exact-native/component cp comparisons, retaining every nonpass."""
from pathlib import Path
import argparse
import hashlib
import json
import os
import subprocess


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--node', type=Path, required=True)
    parser.add_argument('--component', type=Path, required=True)
    parser.add_argument('--adapter', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    args.out.mkdir(parents=True, exist_ok=False)
    env = os.environ.copy()
    env.update(KANDELO_CP_ADAPTER=str(args.adapter.resolve()),
               KANDELO_CP_COMPONENT=str(args.component.resolve()))
    report = {'scope': 'Actual portable native cp walk + actual host POSIX worker; native Node fs/Dir/path/errors/values/callbackify are explicit dependencies. Does not validate production JSAPI, weak unrun GC, primary account projection, guest mounts or four hosts.',
              'target': 'Node.js v26.13.0',
              'sourceCommit': '18b32a3b1552e199a01f1a8d9fd64aa756d3b75b',
              'native': {'path': str(args.node), 'sha256': sha(args.node)},
              'component': {'path': str(args.component), 'sha256': sha(args.component)},
              'adapter': {'path': str(args.adapter), 'sha256': sha(args.adapter)},
              'controls': {}, 'results': []}
    groups = [
        ('copy-directory-controls.cjs', ['tree', 'options', 'errors', 'links', 'validation',
         'timestamps', 'filterThrow', 'cloneForce', 'special', 'replace', 'freshRace', 'errorSetter', 'defaults']),
        ('copy-directory-job-controls.cjs', ['callable', 'noncallable', 'getterThrow', 'callbackThrow']),
    ]
    for script, cases in groups:
        report['controls'][script] = sha(root / 'tests/nodejs' / script)
        for case in cases:
            results = {}
            for mode in ['native', 'candidate']:
                command = [str(args.node.resolve()), '--expose-internals',
                           str(root / 'tests/nodejs' / script), mode, case]
                process = subprocess.Popen(command, cwd=root, env=env, stdout=subprocess.PIPE,
                                           stderr=subprocess.PIPE, text=True)
                timed_out = False
                try:
                    stdout, stderr = process.communicate(timeout=10)
                except subprocess.TimeoutExpired:
                    timed_out = True
                    process.kill()
                    stdout, stderr = process.communicate()
                prefix = args.out / (case + '.' + mode)
                prefix.with_suffix('.' + mode + '.out').write_text(stdout)
                prefix.with_suffix('.' + mode + '.err').write_text(stderr)
                try:
                    value = json.loads(stdout)
                except ValueError:
                    value = None
                results[mode] = {'command': command, 'deadlineSeconds': 10,
                                 'exitCode': process.returncode, 'timedOut': timed_out,
                                 'reaped': process.poll() is not None, 'value': value,
                                 'stdoutSha256': hashlib.sha256(stdout.encode()).hexdigest(),
                                 'stderrSha256': hashlib.sha256(stderr.encode()).hexdigest()}
            matches = results['native']['value'] == results['candidate']['value'] and all(
                result['exitCode'] == 0 for result in results.values())
            report['results'].append({'case': case, 'matches': matches, 'variants': results})
            print(json.dumps({'case': case, 'matches': matches}), flush=True)
    report['matchingGroups'] = sum(item['matches'] for item in report['results'])
    report['nonpassingGroups'] = len(report['results']) - report['matchingGroups']
    (args.out / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    # The evidence report records nonpasses; the process status does not hide them.
    return 0 if report['nonpassingGroups'] == 0 else 1


if __name__ == '__main__':
    raise SystemExit(main())
