#!/usr/bin/env python3
"""Summarize complete Node/browser WordPress cohorts, retaining parent variation."""
import json
from pathlib import Path
import statistics as stats
import sys

folder, output = map(Path, sys.argv[1:3])
inputs = json.loads((folder / 'inputs.json').read_text())
node = (folder / 'runs.json').exists()
if node:
    runs = json.loads((folder / 'runs.json').read_text())
    if len(runs) != len(inputs['plan']) or any(r['exit'] != 0 for r in runs):
        raise SystemExit('incomplete or failed WordPress Node plan')
    rows = [{**r, 'host': 'node', 'result': json.loads((folder / Path(r['output']).name / 'result.json').read_text())} for r in runs]
else:
    status = json.loads((folder / 'run.json').read_text())
    if status['exit'] != 0:
        raise SystemExit('failed WordPress browser matrix')
    rows = []
    for host in ['chromium', 'firefox', 'webkit']:
        for p in sorted(folder.glob(host + '-*.json')):
            r = json.loads(p.read_text())
            if r.get('error') or r['events'] or not r['run']['crossOriginIsolated']:
                raise SystemExit('browser page/boundary failure')
            rows.append({**r, 'host': host, 'result': r['run']})
expected_hosts = ['node'] if node else ['chromium', 'firefox', 'webkit']
for host in expected_hosts:
    selected = [r for r in rows if r['host'] == host]
    if len(selected) != len(inputs['plan']):
        raise SystemExit('incomplete host inventory')
    for trial in inputs['plan']:
        if sum(all(r.get(k) == v for k, v in trial.items()) for r in selected) != 1:
            raise SystemExit('missing/duplicate planned control')
identities, warmups, rounds, settings, flags = {}, set(), set(), set(), set()
expected = inputs.get('identities')
for r in rows:
    result = r['result']; trial = result['trial']
    if not trial['passed'] or not result['destroyed'] or result.get('error') or trial.get('error') or result['diagnostics'] or result.get('timeout') or result.get('destroyError'):
        raise SystemExit('failed application/teardown check')
    if not trial['adminLogin'] or len(trial['statuses']) != 8 or len({s['pid'] for s in trial['statuses']}) != 2:
        raise SystemExit('incomplete admin/two-worker checks')
    if trial['probeRequests'] or len(trial['samples']) != 4 * (trial['warmup'] + trial['rounds']):
        raise SystemExit('incomplete or mixed resource/timing samples')
    samples = {(s['phase'], s['round'], s['workload']) for s in trial['samples']}
    required = {(phase, i, name) for phase, count in [('warmup', trial['warmup']), ('warm', trial['rounds'])]
                for i in range(count) for name in ['home', 'article', 'admin', 'posts']}
    if samples != required or any(s['elapsedMs'] <= 0 or s['bytes'] <= 0 for s in trial['samples']):
        raise SystemExit('missing workload/round or invalid latency/payload')
    shared = r['label'] == 'vm-shared'
    for status in trial['statuses']:
        if status['file_cache_only'] != ('0' if shared else '1') or status['file_cache'] != ('' if shared else '/var/cache/opcache'):
            raise SystemExit('cache control mismatch')
        if shared and (not status['opcache_enabled'] or status['statistics']['num_cached_scripts'] <= 50):
            raise SystemExit('shared cache not populated')
    memory = trial['memory'][-1]
    if r['label'] == 'native-file':
        if memory['roots'] != 0:
            raise SystemExit('ordinary control used virtual addressing')
    elif memory['groups'] != 1 or memory['roots'] != 3 or memory['physicalAllocatedBytes'] > memory['physicalMaximumBytes']:
        raise SystemExit('VM group/resource control mismatch')
    warmups.add(trial['warmup']); rounds.add(trial['rounds'])
    if node:
        flags.add(tuple(result['flags']))
    elif r.get('launchArgs'):
        raise SystemExit('unexpected browser launch arguments')
    settings.add((result.get('imageSha256'), result.get('kernelSha256')))
    if trial['backend'] != inputs['backend'] or trial['label'] != r['label']:
        raise SystemExit('backend/cache mismatch')
    key = 'native' if r['label'] == 'native-file' else r['mode']
    artifact = trial['artifactSha256']
    if result.get('artifactSha256') != artifact:
        raise SystemExit('trial/outer artifact mismatch')
    if expected and (artifact != expected['artifacts'][key] or result.get('imageSha256') != expected['imageSha256'] or result.get('kernelSha256') != expected['kernelSha256']):
        raise SystemExit('frozen image/kernel/artifact identity mismatch')
    identities.setdefault(key, set()).add(artifact)
if (node and len(flags) != 1) or len(settings) != 1 or len(warmups) != 1 or len(rounds) != 1 or any(len(v) != 1 for v in identities.values()):
    raise SystemExit('flags, settings or artifact mismatch')
if next(iter(rounds)) < 5 or next(iter(warmups)) < 1:
    raise SystemExit('short correctness run is not a warm timing cohort')


def median(row, work):
    return stats.median(s['elapsedMs'] for s in row['result']['trial']['samples'] if s['phase'] == 'warm' and s['workload'] == work)


def summarize(values):
    return {'geomean': stats.geometric_mean(values), 'min': min(values), 'max': max(values), 'values': values}


modes = list(dict.fromkeys(r['mode'] for r in inputs['plan']))
report = {'schema': 2, 'scope': 'In-kernel HTTP WordPress; fresh engine parents, two reversed cohorts, ordinary brackets',
          'backend': inputs['backend'], 'trials': len(rows), 'samples': sum(len(r['result']['trial']['samples']) for r in rows),
          'warmupRounds': next(iter(warmups)), 'measuredRounds': next(iter(rounds)), 'flags': list(next(iter(flags))) if flags else [],
          'protocol': inputs['plan'][0].get('protocol', 'mode-major-v1'),
          'artifacts': {k: next(iter(v)) for k, v in identities.items()}, 'hosts': {}}
for host in expected_hosts:
    selected = [r for r in rows if r['host'] == host]
    h = {'versions': sorted({r['result']['runtime'] if node else r['version'] for r in selected}), 'modes': {}}
    if len(h['versions']) != 1:
        raise SystemExit('engine version changed within the matrix')
    for mode in modes:
        m = {'workloads': {}, 'resources': {}}
        for label in ['vm-file', 'vm-shared']:
            chosen = [r for r in selected if r['mode'] == mode and r['label'] == label]
            trials = [r['result']['trial'] for r in chosen]
            if len(chosen) != 2:
                raise SystemExit('mode/cache inventory mismatch')
            m['resources'][label] = {'listenerMs': summarize([t['listenerMs'] for t in trials]),
                                    'firstHomepageMs': summarize([t['firstHomepageMs'] for t in trials]),
                                    'memory': [t['memory'] for t in trials]}
        for work in ['home', 'article', 'admin', 'posts']:
            w = {}
            for label in ['vm-file', 'vm-shared']:
                values, bases, native, ratios, native_ratios, drift, envelope = [], [], [], [], [], [], []
                for cohort in [0, 1]:
                    group = [r for r in selected if r['cohort'] == cohort]
                    refs = [median(r, work) for r in group if r['label'] == 'native-file']
                    if len(refs) != 2:
                        raise SystemExit('ordinary bracket inventory mismatch')
                    value = median(next(r for r in group if r['mode'] == mode and r['label'] == label), work)
                    base = median(next(r for r in group if r['mode'] == 'baseline' and r['label'] == label), work)
                    values.append(value); bases.append(base); native.extend(refs)
                    ratios.append(value / base); native_ratios.append(value / stats.geometric_mean(refs))
                    drift.append(max(refs) / min(refs)); envelope.extend(value / n for n in refs)
                w[label] = {'latencyMs': summarize(values), 'baselineMs': summarize(bases), 'ordinaryMs': summarize(native),
                            'relativeToBaseline': summarize(ratios), 'relativeToOrdinary': summarize(native_ratios),
                            'ordinaryBracketDrift': drift, 'ordinaryEnvelope': {'min': min(envelope), 'max': max(envelope)}}
            m['workloads'][work] = w
        h['modes'][mode] = m
    report['hosts'][host] = h
output.write_text(json.dumps(report, indent=2) + '\n')
for host, h in report['hosts'].items():
    print(host, report['backend'], report['protocol'])
    for mode, m in h['modes'].items():
        print(' ', mode)
        for work, w in m['workloads'].items():
            print('  ', work, *[f'{label}: {w[label]["latencyMs"]["geomean"]:.1f}ms, {w[label]["relativeToBaseline"]["geomean"]:.3f}x baseline, {w[label]["relativeToOrdinary"]["geomean"]:.2f}x ordinary' for label in ['vm-file', 'vm-shared']])
