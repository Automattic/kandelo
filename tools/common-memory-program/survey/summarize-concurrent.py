#!/usr/bin/env python3
"""Analyze two-request batch latency after reproducing the strict paired summary."""
from pathlib import Path
import json
import math
import statistics as stats
import subprocess
import sys
import tempfile

matrix, output = map(Path, sys.argv[1:3])
summary = json.loads((matrix / 'summary.json').read_text())
with tempfile.TemporaryDirectory() as temporary:
    checked = Path(temporary) / 'summary.json'
    subprocess.run([sys.executable, str(Path(__file__).with_name('summarize-paired.py')),
                    str(matrix / 'node'), str(matrix / 'browser'), str(checked)],
                   check=True, capture_output=True, text=True)
    if json.loads(checked.read_text()) != summary:
        raise SystemExit('strict paired summary does not reproduce')
inputs = json.loads((matrix / 'node/inputs.json').read_text())
rows = []
for row in json.loads((matrix / 'node/runs.json').read_text()):
    result = matrix / 'node' / Path(row['output']).name / 'result.json'
    rows.append({**row, 'host': 'node', 'run': json.loads(result.read_text())})
for path in (matrix / 'browser').glob('*.json'):
    row = json.loads(path.read_text())
    if 'cohort' in row:
        rows.append({**row, 'host': path.name.split('-')[0]})
assert len(rows) == summary['controls']
for row in rows:
    trial = row['run']['trial']
    assert trial['passed'] and trial['serverExit'] == 0 and len(trial['throughput']) == 14
    for workload in ['compute', 'includes']:
        samples = [s for s in trial['throughput'] if s['workload'] == workload]
        assert len(samples) == 7 and sorted(s['round'] for s in samples) == list(range(7))
        for sample in samples:
            assert sample['requests'] == 2 and len(set(sample['pids'])) == 2
            assert sample['elapsedMs'] > 0 and math.isclose(
                sample['requestsPerSecond'], 2000 / sample['elapsedMs'], rel_tol=1e-10)

report = {
    'scope': 'median completion latency for a batch of two concurrently admitted requests on two real FPM workers; not a saturation throughput claim',
    'controls': len(rows), 'concurrentBatches': len(rows) * 14, 'hosts': {},
}
for host in ['node', 'chromium', 'firefox', 'webkit']:
    report['hosts'][host] = {}
    for candidate, pair in summary['hosts'][host]['pairs'].items():
        reference = pair['reference']
        report['hosts'][host][candidate] = {}
        for workload in ['compute', 'includes']:
            for label in ['vm-file', 'vm-shared']:
                ratios, native, reference_native, drift = [], [], [], []
                for cohort in [0, 1]:
                    group = [r for r in rows if r['host'] == host and
                             r['candidate'] == candidate and r['cohort'] == cohort]

                    def metric(row):
                        return stats.median(s['elapsedMs'] for s in row['run']['trial']['throughput']
                                            if s['workload'] == workload)

                    def selected(mode):
                        return next(r for r in group if r['mode'] == mode and r['label'] == label)

                    def ordinary(mode):
                        return [metric(r) for r in group if r['label'] == 'native-file' and
                                (not inputs.get('nativeArtifacts') or r['mode'] == mode)]

                    value, base = metric(selected(candidate)), metric(selected(reference))
                    own, other = ordinary(candidate), ordinary(reference)
                    assert len(own) == 2 and len(other) == 2
                    ratios.append(value / base)
                    native.append(value / stats.geometric_mean(own))
                    reference_native.append(base / stats.geometric_mean(other))
                    drift.append(max(own) / min(own))
                report['hosts'][host][candidate][workload + ':' + label] = {
                    'candidateOverReference': stats.geometric_mean(ratios), 'cohorts': ratios,
                    'candidateOverOwnOrdinary': stats.geometric_mean(native),
                    'ownOrdinaryCohorts': native,
                    'referenceOverOwnOrdinary': stats.geometric_mean(reference_native),
                    'nativeBracketDrift': drift,
                }
loads = [r[key][0] for r in rows for key in ['loadBefore', 'loadAfter'] if r.get(key)]
report['recordedOneMinuteLoadRange'] = [min(loads), max(loads)] if loads else None
output.write_text(json.dumps(report, indent=2) + '\n')
print(f"Validated {len(rows)} parents and {report['concurrentBatches']} two-request batches.")
