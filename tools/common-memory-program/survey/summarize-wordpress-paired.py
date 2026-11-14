#!/usr/bin/env python3
"""Validate own-compiler/profile/policy WordPress controls before timing ranks."""
from collections import Counter
import json
import math
from pathlib import Path
import re
import statistics as stats
import sys

node, browser, output = map(Path, sys.argv[1:4])
if output.exists():
    raise SystemExit('choose a fresh summary path')
frozen = json.loads((node / 'inputs.json').read_text())
if frozen.get('diagnostic'):
    raise SystemExit('diagnostic is not uninstrumented WordPress timing')
if json.loads((browser / 'inputs.json').read_text()) != frozen:
    raise SystemExit('Node/browser plans, settings or frozen identities differ')
settings, plan = frozen['settings'], frozen['plan']
if settings['warmup'] < 1 or settings['rounds'] < 5:
    raise SystemExit('short correctness run is not a warm timing matrix')
keys = list(plan[0])
planned = Counter(json.dumps(t, sort_keys=True) for t in plan)
if len(planned) != len(plan) or {t['cohort'] for t in plan} != {0, 1}:
    raise SystemExit('duplicate or incomplete launch cohorts')
runs = json.loads((node / 'runs.json').read_text())
if any(r['exit'] != 0 or r.get('signal') or r.get('error') for r in runs):
    raise SystemExit('failed Node control')
rows = [{**r, 'host': 'node', 'run': json.loads((node / Path(r['output']).name / 'result.json').read_text())} for r in runs]
browser_status = json.loads((browser / 'run.json').read_text())
if browser_status['exit'] != 0 or browser_status.get('signal') or browser_status.get('error'):
    raise SystemExit('failed browser collection')
for host in ['chromium', 'firefox', 'webkit']:
    for p in sorted(browser.glob(host + '-*.json')):
        rows.append({**json.loads(p.read_text()), 'host': host})
for host in ['node', 'chromium', 'firefox', 'webkit']:
    actual = Counter(json.dumps({k: r[k] for k in keys}, sort_keys=True) for r in rows if r['host'] == host)
    if actual != planned:
        raise SystemExit(f'{host}: missing, duplicate or unplanned control')

for r in rows:
    result, options = r['run'], frozen['appOptions'][r['mode']]
    trial = result['trial']
    if r.get('diagnostic') or result.get('diagnostic'):
        raise SystemExit('diagnostic result mixed into timing')
    if r.get('error') or result.get('error') or trial.get('error') or not trial['passed'] or not result['destroyed'] or result.get('destroyError') or result.get('timeout') or result['diagnostics'] or result['stderr']:
        raise SystemExit('failed application or teardown')
    if r['protocol'] != 'wordpress-matched-cases-v1' or r['appOptions'] != options or r['hostProfile'] != frozen['hostProfiles'][r['mode']]:
        raise SystemExit('case/protocol/profile binding differs')
    if r['host'] == 'node':
        if result['profile'] != r['hostProfile'] or result['flags'] != ['--import', 'tsx/esm']:
            raise SystemExit('unexpected Node profile or flags')
    elif r['events'] or r.get('launchArgs') or not result['crossOriginIsolated']:
        raise SystemExit('browser boundary, page or launch failure')
    kind = 'native' if r['label'] == 'native-file' else 'vm'
    expected = frozen['expectedArtifacts'][kind][r['mode']]
    if trial['artifactSha256'] != expected or result['artifactSha256'] != expected or result['imageSha256'] != frozen['imageSha256'] or result['kernelSha256'] != frozen['kernelSha256']:
        raise SystemExit('artifact, image or kernel identity differs')
    if trial.get('timestampPolicy') or trial['probeRequests']:
        raise SystemExit('diagnostic work mixed into timing')
    if trial['warmup'] != settings['warmup'] or trial['rounds'] != settings['rounds'] or trial['backend'] != settings['backend'] or trial['seed'] != r['seed'] or trial['label'] != r['label']:
        raise SystemExit('collection settings differ')
    timestamps = re.findall(r'^opcache.validate_timestamps=([01])$', trial['phpIni'], re.M)
    if timestamps != [str(int(options['validateTimestamps']))]:
        raise SystemExit('PHP timestamp setting differs from case')
    expected_samples = Counter((phase, i, w) for phase, count in [('warmup', settings['warmup']), ('warm', settings['rounds'])] for i in range(count) for w in ['home', 'article', 'admin', 'posts'])
    actual_samples = Counter((s['phase'], s['round'], s['workload']) for s in trial['samples'])
    if actual_samples != expected_samples or any(not math.isfinite(s['elapsedMs']) or s['elapsedMs'] <= 0 or s['bytes'] <= 0 for s in trial['samples']):
        raise SystemExit('incomplete samples or invalid clock/payload')
    if not trial['adminLogin'] or len(trial['statuses']) != 8 or len({s['pid'] for s in trial['statuses']}) != 2:
        raise SystemExit('admin or two-worker contract failed')
    shared = r['label'] == 'vm-shared'
    for status in trial['statuses']:
        if status['file_cache_only'] != ('0' if shared else '1') or status['file_cache'] != ('' if shared else '/var/cache/opcache'):
            raise SystemExit('cache mode differs')
        if shared and (not status['opcache_enabled'] or status['statistics']['num_cached_scripts'] <= 50):
            raise SystemExit('shared OPcache is not populated')
    memory = trial['memory'][-1]
    if kind == 'native':
        if memory['roots'] != 0 or memory['groups'] != 0:
            raise SystemExit('ordinary control used a VM group')
    elif memory['roots'] != 3 or memory['groups'] != 1 or memory['physicalAllocatedBytes'] > memory['physicalMaximumBytes']:
        raise SystemExit('VM group resource contract failed')

def summarize(values):
    return {'geomean': stats.geometric_mean(values), 'values': values, 'min': min(values), 'max': max(values)}

def median(row, workload):
    return stats.median(s['elapsedMs'] for s in row['run']['trial']['samples'] if s['phase'] == 'warm' and s['workload'] == workload)

report = {'schema': 1, 'scope': 'Matched in-kernel HTTP WordPress; ordinary means untranslated Wasm; shared/ordinary includes cache-mode effects; no quiet-machine claim',
          'controls': len(rows), 'samples': sum(len(r['run']['trial']['samples']) for r in rows),
          'settings': settings, 'appOptions': frozen['appOptions'], 'hostProfiles': frozen['hostProfiles'], 'hosts': {},
          'parentResources': [{**{k: r[k] for k in ['host', 'candidate', 'reference', 'cohort', 'order', 'mode', 'label', 'hostProfile']},
                               **{k: r['run']['trial'][k] for k in ['listenerMs', 'firstHomepageMs', 'memory', 'statuses']}} for r in rows]}
for host in ['node', 'chromium', 'firefox', 'webkit']:
    selected = [r for r in rows if r['host'] == host]
    report['hosts'][host] = {}
    for candidate in dict.fromkeys(t['candidate'] for t in plan):
        matching = [r for r in selected if r['candidate'] == candidate]
        reference = matching[0]['reference']
        pair = {'reference': reference, 'workloads': {}}
        for work in ['home', 'article', 'admin', 'posts']:
            pair['workloads'][work] = {}
            for label in ['vm-file', 'vm-shared']:
                values, baselines, ratios, own_ratios, ref_ratios, ordinary_ratios, own_drift, ref_drift = [], [], [], [], [], [], [], []
                for cohort in [0, 1]:
                    group = [r for r in matching if r['cohort'] == cohort]
                    if len(group) != 8:
                        raise SystemExit('missing eight-control matched bracket')
                    def ordinary(mode):
                        return [median(r, work) for r in group if r['mode'] == mode and r['label'] == 'native-file']
                    def value(mode):
                        found = [r for r in group if r['mode'] == mode and r['label'] == label]
                        if len(found) != 1:
                            raise SystemExit('ambiguous candidate/reference')
                        return median(found[0], work)
                    own, other = ordinary(candidate), ordinary(reference)
                    if len(own) != 2 or len(other) != 2:
                        raise SystemExit('missing own ordinary brackets')
                    v, b = value(candidate), value(reference)
                    values.append(v); baselines.append(b); ratios.append(v / b)
                    own_ratios.append(v / stats.geometric_mean(own)); ref_ratios.append(b / stats.geometric_mean(other))
                    ordinary_ratios.append(stats.geometric_mean(own) / stats.geometric_mean(other))
                    own_drift.append(max(own) / min(own)); ref_drift.append(max(other) / min(other))
                pair['workloads'][work][label] = {'candidateMs': summarize(values), 'referenceMs': summarize(baselines),
                    'candidateOverReference': summarize(ratios), 'candidateOverOwnOrdinary': summarize(own_ratios),
                    'referenceOverOwnOrdinary': summarize(ref_ratios), 'ordinaryCandidateOverReference': summarize(ordinary_ratios),
                    'ownOrdinaryBracketDrift': own_drift, 'referenceOrdinaryBracketDrift': ref_drift}
        report['hosts'][host][candidate] = pair
output.write_text(json.dumps(report, indent=2) + '\n')
print(f"Validated {len(rows)} WordPress parents and {report['samples']} page samples with own ordinary controls.")
