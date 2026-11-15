#!/usr/bin/env python3
"""Summarize adjacent candidate/reference pairs, retaining cohort variation."""
import json
from collections import Counter
from pathlib import Path
import statistics as stats
import sys

node, browser, output = map(Path, sys.argv[1:4])
inputs = json.loads((node / 'inputs.json').read_text())
other = json.loads((browser / 'inputs.json').read_text())
if any(inputs.get(key) != other.get(key) for key in ['inputs', 'plan', 'expectedArtifacts', 'nativeArtifacts', 'hostProfiles', 'hostProfileArtifacts']):
    raise SystemExit('Node/browser frozen inputs or plans differ')
matched_native = bool(inputs.get('nativeArtifacts'))
profiles = inputs.get('hostProfiles')
if profiles is not None and not profiles:
    raise SystemExit('empty host profile bindings')
if profiles:
    if not matched_native or set(profiles) != set(inputs['expectedArtifacts']['vm']):
        raise SystemExit('incomplete host profile bindings or own ordinary controls')
    for profile in profiles.values():
        if not isinstance(profile, str) or not Path(profile).is_absolute():
            raise SystemExit('invalid host profile path')
        for name in ['node-kernel-host.mjs', 'node-kernel-worker-entry.mjs', 'worker-entry.mjs',
                     'browser-kernel-host.mjs', 'browser-kernel-worker-entry.mjs', 'worker-entry-browser.mjs']:
            if str(Path(profile) / name) not in inputs['inputs']:
                raise SystemExit('host profile bundle missing from frozen inputs')
        declared = inputs.get('hostProfileArtifacts', {}).get(profile)
        if not declared:
            raise SystemExit('missing declared host profile identity')
        for name, artifact in declared.items():
            expected_path = str(Path(profile) / name)
            if artifact['path'] != expected_path or inputs['inputs'].get(expected_path) != artifact['sha256']:
                raise SystemExit('host profile identity differs from frozen bundle')
plan_keys = list(inputs['plan'][0])
planned = Counter(json.dumps(r, sort_keys=True) for r in inputs['plan'])
if len(planned) != len(inputs['plan']):
    raise SystemExit('duplicate planned control')
rows = []
for r in json.loads((node / 'runs.json').read_text()):
    if r['exit'] != 0:
        raise SystemExit('failed Node control')
    result = json.loads((node / Path(r['output']).name / 'result.json').read_text())
    rows.append({**r, 'host': 'node', 'run': result, 'version': result['runtime']})
for p in browser.glob('*.json'):
    r = json.loads(p.read_text())
    if 'cohort' in r:
        rows.append({**r, 'host': p.name.split('-')[0]})
if len(rows) != len(inputs['plan']) * 4:
    raise SystemExit('incomplete control inventory')
for host in ['node', 'chromium', 'firefox', 'webkit']:
    actual = Counter(json.dumps({k: r[k] for k in plan_keys}, sort_keys=True) for r in rows if r['host'] == host)
    if actual != planned:
        raise SystemExit(f'{host} plan inventory mismatch')
files, artifacts = set(), {}
for r in rows:
    if not profiles and 'hostProfile' in r:
        raise SystemExit('control host profile has no frozen binding')
    if profiles and r.get('hostProfile') != profiles[r['mode']]:
        raise SystemExit('control host profile does not match frozen binding')
    run = r['run']
    t = run['trial']
    if r.get('error') or not run['destroyed'] or not t['passed'] or run.get('error') or t.get('error') or run['stderr'] or run['diagnostics']:
        raise SystemExit('failed control')
    if t['serverExit'] != 0 or t['rounds'] != 7 or t['warmup'] != 64 or len(t['samples']) != 436 or len(t['throughput']) != 14:
        raise SystemExit('incomplete warmup/workload/shutdown')
    if t['connectionAdmission'] != 'single-worker-turn':
        raise SystemExit('unexpected admission fixture')
    if t['label'] != r['label']:
        raise SystemExit('control label mismatch')
    if r['host'] == 'node' and run['flags']:
        raise SystemExit('unexpected Node engine flags')
    if r['host'] != 'node' and (r['pageErrors'] or not run['crossOriginIsolated']):
        raise SystemExit('browser boundary failure')
    if r.get('launchArgs'):
        raise SystemExit('unexpected browser engine flags')
    files.add(json.dumps(t['files'], sort_keys=True))
    ordinary = r['label'] == 'native-file'
    key = ('native:' + r['mode'] if matched_native else 'native') if ordinary else r['mode']
    artifacts.setdefault(key, set()).add(t['artifactSha256'])
    if inputs.get('expectedArtifacts'):
        expected = inputs['expectedArtifacts']['native' if ordinary else 'vm'][r['mode'] if matched_native or not ordinary else 'native']
        if t['artifactSha256'] != expected:
            raise SystemExit(f'artifact does not match frozen binding: {key}')
if len(files) != 1 or any(len(v) != 1 for v in artifacts.values()):
    raise SystemExit('workload or artifact identity mismatch')


def summarize(values):
    return {'geomean': stats.geometric_mean(values), 'min': min(values), 'max': max(values), 'values': values}


def median(row, workload, metric):
    return stats.median(s[metric] for s in row['run']['trial']['samples'] if s['phase'] == 'warm' and s['workload'] == workload)


report = {'schema': 2 if matched_native else 1, 'scope': 'Opt-in outlined FPM, adjacent fresh-parent candidate/reference controls; reverse pair/cache/candidate order in second cohort',
          'controls': len(rows), 'samples': sum(len(r['run']['trial']['samples']) for r in rows),
          'artifacts': {k: next(iter(v)) for k, v in artifacts.items()}, 'hosts': {}}
if profiles:
    report['hostProfiles'] = profiles
    report['hostProfileArtifacts'] = inputs['hostProfileArtifacts']
    report['ordinaryComparison'] = 'Each ordinary control uses its own mode host profile; ordinary ratios include compiler/host effects.'
candidates = list(dict.fromkeys(r['candidate'] for r in inputs['plan']))
for host in ['node', 'chromium', 'firefox', 'webkit']:
    selected = [r for r in rows if r['host'] == host]
    if len(selected) != len(inputs['plan']):
        raise SystemExit('host inventory mismatch')
    h = {'versions': sorted({r['version'] for r in selected}), 'pairs': {}}
    for candidate in candidates:
        matching = [r for r in selected if r['candidate'] == candidate]
        reference = matching[0]['reference']
        pair = {'reference': reference, 'workloads': {}, 'resources': {}}
        for label in ['vm-file', 'vm-shared']:
            pair['resources'][label] = {}
            for mode in [reference, candidate]:
                trials = [r['run']['trial'] for r in matching if r['label'] == label and r['mode'] == mode]
                pair['resources'][label][mode] = {'listenerReadyMs': summarize([t['listenerReadyMs'] for t in trials]),
                    'firstRequestMs': summarize([t['samples'][0]['elapsedMs'] for t in trials]),
                    'memory': [t['memory'] for t in trials], 'kernelPages': [t['kernelPages'] for t in trials]}
        for workload in ['empty', 'compute', 'includes']:
            w = {}
            for label in ['vm-file', 'vm-shared']:
                w[label] = {}
                for metric in ['elapsedMs', 'guest_ms']:
                    values, baselines, native_values, ratios, native_ratios, baseline_native_ratios, drift, envelope = [], [], [], [], [], [], [], []
                    reference_native_values, reference_drift, reference_envelope, compiler_ratios, overhead_ratios = [], [], [], [], []
                    for cohort in [0, 1]:
                        group = [r for r in matching if r['cohort'] == cohort]
                        if len(group) != (8 if matched_native else 6):
                            raise SystemExit('pair block inventory mismatch')
                        ordinary = [median(r, workload, metric) for r in group if r['label'] == 'native-file' and (not matched_native or r['mode'] == candidate)]
                        reference_ordinary = [median(r, workload, metric) for r in group if r['label'] == 'native-file' and (not matched_native or r['mode'] == reference)]
                        if len(ordinary) != 2 or len(reference_ordinary) != 2:
                            raise SystemExit('ordinary build bracket inventory mismatch')
                        value = median(next(r for r in group if r['mode'] == candidate and r['label'] == label), workload, metric)
                        base = median(next(r for r in group if r['mode'] == reference and r['label'] == label), workload, metric)
                        values.append(value); baselines.append(base); native_values.extend(ordinary)
                        ratios.append(value / base); native_ratios.append(value / stats.geometric_mean(ordinary))
                        baseline_native_ratios.append(base / stats.geometric_mean(reference_ordinary))
                        drift.append(max(ordinary) / min(ordinary)); envelope.extend(value / n for n in ordinary)
                        reference_native_values.extend(reference_ordinary)
                        reference_drift.append(max(reference_ordinary) / min(reference_ordinary))
                        reference_envelope.extend(base / n for n in reference_ordinary)
                        compiler_ratios.append(stats.geometric_mean(ordinary) / stats.geometric_mean(reference_ordinary))
                        overhead_ratios.append(native_ratios[-1] / baseline_native_ratios[-1])
                    w[label][metric] = {'candidateMs': summarize(values), 'referenceMs': summarize(baselines), 'nativeMs': summarize(native_values),
                        'candidateOverReference': summarize(ratios), 'candidateOverNative': summarize(native_ratios),
                        'referenceOverNative': summarize(baseline_native_ratios), 'nativeBracketDrift': drift,
                        'nativeEnvelope': {'min': min(envelope), 'max': max(envelope)}}
                    if matched_native:
                        w[label][metric].update({'referenceNativeMs': summarize(reference_native_values),
                            'referenceNativeBracketDrift': reference_drift,
                            'referenceNativeEnvelope': {'min': min(reference_envelope), 'max': max(reference_envelope)},
                            'nativeCandidateOverReference': summarize(compiler_ratios),
                            'relativeAddressingOverhead': summarize(overhead_ratios)})
            pair['workloads'][workload] = w
        h['pairs'][candidate] = pair
    report['hosts'][host] = h
output.write_text(json.dumps(report, indent=2) + '\n')
for host, h in report['hosts'].items():
    print(host)
    for candidate, pair in h['pairs'].items():
        print(' ', candidate, 'versus', pair['reference'])
        for workload, w in pair['workloads'].items():
            print('   ', workload, *[f'{label}: {w[label]["elapsedMs"]["candidateOverReference"]["geomean"]:.3f}x reference, {w[label]["elapsedMs"]["candidateOverNative"]["geomean"]:.2f}x native' for label in ['vm-file', 'vm-shared']])
