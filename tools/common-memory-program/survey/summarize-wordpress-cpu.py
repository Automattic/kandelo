#!/usr/bin/env python3
"""Separate, instrumented Node process-CPU diagnostic; never a browser rank."""
from collections import Counter
import json
import math
from pathlib import Path
import re
import statistics as stats
import sys

folder, output = map(Path, sys.argv[1:3])
if output.exists():
    raise SystemExit('choose a fresh CPU summary path')
frozen = json.loads((folder / 'inputs.json').read_text())
if frozen.get('diagnostic') != 'process-cpu':
    raise SystemExit('not a declared process-CPU diagnostic')
plan, settings = frozen['plan'], frozen['settings']
if settings['warmup'] < 1 or settings['rounds'] < 5:
    raise SystemExit('short CPU correctness probe is not a warm diagnostic matrix')
keys = list(plan[0])
rows = json.loads((folder / 'runs.json').read_text())
planned = Counter(json.dumps(t, sort_keys=True) for t in plan)
actual = Counter(json.dumps({k: r[k] for k in keys}, sort_keys=True) for r in rows)
if len(planned) != len(plan) or actual != planned or {t['cohort'] for t in plan} != {0, 1}:
    raise SystemExit('incomplete or duplicate CPU control plan')
paths = {'home': '/', 'article': '/?p=1', 'admin': '/wp-admin/', 'posts': '/?rest_route=/wp/v2/posts&per_page=1'}
for row in rows:
    base = folder / Path(row['output']).name
    r = row['run'] = json.loads((base / 'result.json').read_text())
    cpu = row['cpu'] = json.loads((base / 'cpu-records.json').read_text())
    t, options = r['trial'], frozen['appOptions'][row['mode']]
    if row['exit'] != 0 or row.get('signal') or row.get('error') or row.get('diagnostic') != 'process-cpu':
        raise SystemExit('failed or undeclared CPU control')
    if not cpu.get('passed') or cpu.get('error') or not t['passed'] or not r['destroyed'] or r.get('error') or t.get('error') or r.get('destroyError') or r.get('timeout') or r['stderr'] or r['diagnostics']:
        raise SystemExit('application, CPU alignment or teardown failure')
    if row['appOptions'] != options or row['hostProfile'] != frozen['hostProfiles'][row['mode']] or r['profile'] != row['hostProfile']:
        raise SystemExit('case/profile binding mismatch')
    if r['flags'] != ['--import', 'tsx/esm'] or r['runtime'] != cpu['runtime']:
        raise SystemExit('unexpected Node flags/runtime')
    native = row['label'] == 'native-file'
    expected = frozen['expectedArtifacts']['native' if native else 'vm'][row['mode']]
    if r['artifactSha256'] != expected or t['artifactSha256'] != expected or r['imageSha256'] != frozen['imageSha256'] or r['kernelSha256'] != frozen['kernelSha256']:
        raise SystemExit('artifact/image/kernel mismatch')
    if t['backend'] != settings['backend'] or t['label'] != row['label'] or t['seed'] != row['seed'] or t['warmup'] != settings['warmup'] or t['rounds'] != settings['rounds'] or t['probeRequests'] or t.get('timestampPolicy'):
        raise SystemExit('collection settings mismatch or mixed policy diagnostic')
    if re.findall(r'^opcache.validate_timestamps=([01])$', t['phpIni'], re.M) != [str(int(options['validateTimestamps']))]:
        raise SystemExit('timestamp policy mismatch')
    required = Counter((phase, i, work) for phase, count in [('warmup', settings['warmup']), ('warm', settings['rounds'])] for i in range(count) for work in paths)
    if Counter((s['phase'], s['round'], s['workload']) for s in t['samples']) != required or len(cpu['samples']) != len(t['samples']):
        raise SystemExit('incomplete CPU/page inventory')
    for sample, measured in zip(t['samples'], cpu['samples']):
        record = cpu['records'][measured['fetchSequence']]
        if any(measured.get(k) != value for k, value in sample.items()) or record['overlapped'] or record.get('error') or record['status'] != 200 or record['url'] != paths[sample['workload']] or record['bytes'] != sample['bytes']:
            raise SystemExit('CPU interval is not an unambiguous page request')
        if record['cpu'] != {'user': measured['cpuUserUs'], 'system': measured['cpuSystemUs']} or record['elapsedMs'] != measured['fetchWallMs']:
            raise SystemExit('CPU interval/sample mismatch')
        if any(not math.isfinite(measured[k]) or measured[k] < 0 for k in ['cpuUserUs', 'cpuSystemUs']) or measured['cpuUserUs'] + measured['cpuSystemUs'] <= 0 or measured['fetchWallMs'] <= 0 or sample['elapsedMs'] <= 0 or sample['bytes'] <= 0:
            raise SystemExit('invalid CPU, clock or payload')
    if not t['adminLogin'] or len(t['statuses']) != 8 or len({s['pid'] for s in t['statuses']}) != 2:
        raise SystemExit('admin/two-worker contract failed')
    shared = row['label'] == 'vm-shared'
    for status in t['statuses']:
        if status['file_cache_only'] != ('0' if shared else '1') or status['file_cache'] != ('' if shared else '/var/cache/opcache'):
            raise SystemExit('cache control mismatch')
        if shared and (not status['opcache_enabled'] or status['statistics']['num_cached_scripts'] <= 50):
            raise SystemExit('shared cache not populated')
    memory = t['memory'][-1]
    if memory['roots'] != (0 if native else 3) or memory['groups'] != (0 if native else 1) or (not native and memory['physicalAllocatedBytes'] > memory['physicalMaximumBytes']):
        raise SystemExit('address model/resource mismatch')

def metric(row, work, name):
    samples = [s for s in row['cpu']['samples'] if s['phase'] == 'warm' and s['workload'] == work]
    return stats.median((s['cpuUserUs'] + s['cpuSystemUs']) / 1000 if name == 'cpuMs' else s[name] for s in samples)

def summarize(values):
    return {'geomean': stats.geometric_mean(values), 'values': values, 'min': min(values), 'max': max(values)}

report = {'scope': 'Instrumented Node fetchInKernel intervals; process-wide user+system CPU, not PHP-only/per-function attribution. Background runtime work is included. Not browser evidence or uninstrumented latency. Shared/ordinary includes cache-mode effects. No quiet-machine claim.',
          'controls': len(rows), 'samples': sum(len(r['cpu']['samples']) for r in rows), 'settings': settings, 'pairs': {},
          'clockProbes': [{**{k: r[k] for k in ['candidate', 'cohort', 'order', 'mode', 'label']}, 'probes': r['cpu']['clockProbe']} for r in rows]}
for candidate in dict.fromkeys(t['candidate'] for t in plan):
    group = [r for r in rows if r['candidate'] == candidate]
    reference = group[0]['reference']
    pair = report['pairs'][candidate] = {'reference': reference, 'workloads': {}}
    for work in paths:
        pair['workloads'][work] = {}
        for label in ['vm-file', 'vm-shared']:
            pair['workloads'][work][label] = {}
            for name in ['cpuMs', 'fetchWallMs', 'elapsedMs']:
                values, baselines, ratios, own_ratios, ordinary_ratios, drift = [], [], [], [], [], []
                for cohort in [0, 1]:
                    selected = [r for r in group if r['cohort'] == cohort]
                    if len(selected) != 8:
                        raise SystemExit('missing own ordinary eight-control bracket')
                    own = [metric(r, work, name) for r in selected if r['mode'] == candidate and r['label'] == 'native-file']
                    other = [metric(r, work, name) for r in selected if r['mode'] == reference and r['label'] == 'native-file']
                    if len(own) != 2 or len(other) != 2:
                        raise SystemExit('ordinary bracket mismatch')
                    value = metric(next(r for r in selected if r['mode'] == candidate and r['label'] == label), work, name)
                    base = metric(next(r for r in selected if r['mode'] == reference and r['label'] == label), work, name)
                    values.append(value); baselines.append(base); ratios.append(value / base)
                    own_ratios.append(value / stats.geometric_mean(own)); ordinary_ratios.append(stats.geometric_mean(own) / stats.geometric_mean(other))
                    drift.append(max(own) / min(own))
                pair['workloads'][work][label][name] = {'candidate': summarize(values), 'reference': summarize(baselines),
                    'candidateOverReference': summarize(ratios), 'candidateOverOwnOrdinary': summarize(own_ratios),
                    'ordinaryCandidateOverReference': summarize(ordinary_ratios), 'ownOrdinaryBracketDrift': drift}
output.write_text(json.dumps(report, indent=2) + '\n')
print(f"Validated {len(rows)} Node CPU parents and {report['samples']} aligned page intervals; diagnostic only.")
