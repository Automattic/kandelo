"""Replace all twelve known-incomplete WebKit resource cases, retaining lineage.

Raw campaigns are immutable. Select no case based on its timing or footprint.
"""
from pathlib import Path
import hashlib
import json
import shutil
import sys

primary, correction, output = map(Path, sys.argv[1:])
plans = [json.loads((directory / 'plan.json').read_text()) for directory in [primary, correction]]
runs = [json.loads((directory / 'runs.json').read_text()) for directory in [primary, correction]]
assert len(runs[0]) == len(plans[0]['trials']) == 96
assert len(runs[1]) == len(plans[1]['trials']) == 12
for plan, records in zip(plans, runs):
    assert all(record['exit'] == 0 for record in records)
    assert [record['id'] for record in records] == [trial['id'] for trial in plan['trials']]
    for file, digest in plan['inputs'].items():
        assert hashlib.sha256(Path(file).read_bytes()).hexdigest() == digest, file
for key in ['fixture', 'profile', 'kernel']:
    assert plans[0][key] == plans[1][key]
replacement = {record['id']: record for record in runs[1]}
excluded = [record for record in runs[0] if record['host'] == 'webkit' and record['mode'] == 'resource']
assert set(replacement) == {record['id'] for record in excluded}
assert all(record['host'] == 'webkit' and record['mode'] == 'resource' for record in runs[1])
assert plans[1]['declaredAt'] < min(record['start'] for record in excluded)
inputs = dict(plans[0]['inputs'])
for name, digest in plans[1]['inputs'].items():
    assert name not in inputs or inputs[name] == digest, name
    inputs[name] = digest
output.mkdir()
selected = []
for record in runs[0]:
    directory = correction if record['id'] in replacement else primary
    chosen = dict(replacement.get(record['id'], record), originCampaign=str(directory.resolve()))
    shutil.copytree(directory / record['id'], output / record['id'])
    shutil.copyfile(directory / (record['id'] + '.log'), output / (record['id'] + '.log'))
    selected.append(chosen)
plan = dict(plans[0], output=str(output.resolve()), inputs=inputs,
    collectedParents=108, excludedResourceParents=12,
    scope=plans[0]['scope'] + ' WebKit resource cases uniformly replaced by a predeclared complete-XPC correction; 108 parents collected, 96 analyzed, 12 incomplete tree-only resource parents excluded. All original results retained.',
    sourceCampaigns=[str(primary.resolve()), str(correction.resolve())],
    sourcePlanSha256=[hashlib.sha256((directory / 'plan.json').read_bytes()).hexdigest() for directory in [primary, correction]],
    webkitResourceCorrection=plans[1]['scope'])
(output / 'plan.json').write_text(json.dumps(plan, indent=2) + '\n')
(output / 'runs.json').write_text(json.dumps(selected, indent=2) + '\n')
(output / 'excluded-runs.json').write_text(json.dumps(excluded, indent=2) + '\n')
print('Analyzable parents:', len(selected), 'retained excluded resource parents:', len(excluded))
