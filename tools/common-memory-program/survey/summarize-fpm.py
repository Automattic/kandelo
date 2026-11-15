#!/usr/bin/env python3
"""Keep fresh-parent cohorts distinct and normalize against ordinary brackets."""
import json
from pathlib import Path
import statistics as stats
import sys

node, browser, output = map(Path, sys.argv[1:4])
modes = ['baseline', 'baseline-conditional', 'scalar', 'scalar-conditional']
rows = []
for mode in modes:
    for run in json.loads((node / mode / 'runs.json').read_text()):
        if run['exit'] != 0:
            raise SystemExit(f'failed Node control: {mode} {run}')
        relative = node / mode / Path(run['output']).name / 'result.json'
        result = json.loads(relative.read_text())
        rows.append({**run, 'mode': mode, 'host': 'node', 'run': result, 'version': result['runtime']})
    for path in sorted((browser / mode).glob('*.json')):
        result = json.loads(path.read_text())
        rows.append({**result, 'mode': mode, 'host': path.name.split('-')[0]})
if len(rows) != 128:
    raise SystemExit(f'expected 128 controls, got {len(rows)}')
files, identities, admissions = set(), {}, set()
for row in rows:
    run = row['run']
    trial = run['trial']
    if not trial['passed'] or not run['destroyed'] or run.get('error') or trial.get('error') or run['stderr'] or run['diagnostics']:
        raise SystemExit(f'failed control: {row["host"]} {row["mode"]} {row["label"]}')
    if trial['serverExit'] != 0 or trial['rounds'] != 7 or trial['warmup'] != 64 or len(trial['samples']) != 436 or len(trial['throughput']) != 14:
        raise SystemExit('incomplete control')
    if row['host'] == 'node' and run['flags']:
        raise SystemExit('unexpected Node flags')
    if row['host'] != 'node' and (row['pageErrors'] or not run['crossOriginIsolated']):
        raise SystemExit('browser boundary failure')
    files.add(json.dumps(trial['files'], sort_keys=True))
    admissions.add(trial['connectionAdmission'])
    key = 'native' if row['label'] == 'native-file' else row['mode']
    identities.setdefault(key, set()).add(trial['artifactSha256'])
if len(files) != 1 or admissions != {'single-worker-turn'} or any(len(v) != 1 for v in identities.values()):
    raise SystemExit('source/artifact/admission mismatch')


def summary(values):
    return {'geomean': stats.geometric_mean(values), 'min': min(values), 'max': max(values), 'cohorts': values}


def median(row, workload, metric):
    return stats.median(s[metric] for s in row['run']['trial']['samples'] if s['phase'] == 'warm' and s['workload'] == workload)


report = {'schema': 1, 'scope': 'Opt-in outlined FPM diagnostic; 2 fresh-parent cohorts per variant/cache, ordinary brackets, 64 warmup rounds, default engines',
          'controls': len(rows), 'samples': sum(len(r['run']['trial']['samples']) for r in rows),
          'artifactSha256': {k: next(iter(v)) for k, v in identities.items()}, 'hosts': {}}
for host in ['node', 'chromium', 'firefox', 'webkit']:
    selected = [r for r in rows if r['host'] == host]
    if len(selected) != 32:
        raise SystemExit('host inventory mismatch')
    h = {'versions': sorted({r['version'] for r in selected}), 'modes': {}}
    for mode in modes:
        bymode = [r for r in selected if r['mode'] == mode]
        m = {'workloads': {}, 'resources': {}}
        for label in ['native-file', 'vm-file', 'vm-shared']:
            trials = [r['run']['trial'] for r in bymode if r['label'] == label]
            m['resources'][label] = {'listenerReadyMs': summary([t['listenerReadyMs'] for t in trials]),
                'firstRequestMs': summary([t['samples'][0]['elapsedMs'] for t in trials]),
                'memory': [t['memory'] for t in trials], 'kernelPages': [t['kernelPages'] for t in trials]}
        for workload in ['empty', 'compute', 'includes']:
            w = {}
            for label in ['native-file', 'vm-file', 'vm-shared']:
                matching = [r for r in bymode if r['label'] == label]
                w[label] = {metric: summary([median(r, workload, metric) for r in matching]) for metric in ['elapsedMs', 'guest_ms']}
                if label == 'native-file':
                    continue
                for metric in ['elapsedMs', 'guest_ms']:
                    ratios, envelope, drift, relative = [], [], [], []
                    for cohort in [0, 1]:
                        cohort_rows = [r for r in bymode if r['cohort'] == cohort]
                        brackets = [median(r, workload, metric) for r in cohort_rows if r['label'] == 'native-file']
                        value = median(next(r for r in cohort_rows if r['label'] == label), workload, metric)
                        ratios.append(value / stats.geometric_mean(brackets))
                        envelope.extend(value / b for b in brackets)
                        drift.append(max(brackets) / min(brackets))
                        reference = [r for r in selected if r['mode'] == 'baseline' and r['cohort'] == cohort]
                        reference_brackets = [median(r, workload, metric) for r in reference if r['label'] == 'native-file']
                        reference_value = median(next(r for r in reference if r['label'] == label), workload, metric)
                        relative.append(ratios[-1] / (reference_value / stats.geometric_mean(reference_brackets)))
                    w[label][metric].update(relativeToNative=summary(ratios), nativeBracketEnvelope={'min': min(envelope), 'max': max(envelope)},
                                            nativeBracketDrift=drift, nativeNormalizedRelativeToBaseline=summary(relative))
            m['workloads'][workload] = w
        h['modes'][mode] = m
    report['hosts'][host] = h
output.write_text(json.dumps(report, indent=2) + '\n')
for host, h in report['hosts'].items():
    print(host)
    for mode in modes:
        print(' ', mode)
        for workload in ['empty', 'compute', 'includes']:
            w = h['modes'][mode]['workloads'][workload]
            print('   ', workload, *[f'{label}: {w[label]["elapsedMs"]["geomean"]:.3f}ms, {w[label]["elapsedMs"]["relativeToNative"]["geomean"]:.2f}x native, {w[label]["elapsedMs"]["nativeNormalizedRelativeToBaseline"]["geomean"]:.3f}x baseline' for label in ['vm-file', 'vm-shared']])
