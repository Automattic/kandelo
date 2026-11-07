#!/usr/bin/env python3
"""Replay fixed-log contamination, then check two agent-job Vitest logs.

Run through scripts/dev-shell.sh. The unsafe shared filename lives only in
our fresh scratch directory, never at a real /tmp/integ.log.
"""
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
(ROOT / '.context').mkdir(exist_ok=True)
scratch = Path(tempfile.mkdtemp(prefix='concurrent-logs-', dir=ROOT / '.context'))
print(f'Evidence: {scratch}', flush=True)
vitest = ROOT / 'host/node_modules/vitest/vitest.mjs'
api = ROOT / 'host/node_modules/vitest/dist/index.js'
job = ROOT / 'scripts/agent-job'
env = dict(os.environ, KANDELO_AGENT_JOBS_DIR=str(scratch / 'jobs'))

def await_file(path, child=None):
    deadline = time.monotonic() + 45
    while not path.exists():
        if (child and child.poll() is not None) or time.monotonic() > deadline:
            raise RuntimeError(f'Vitest did not reach {path}')
        time.sleep(.05)

for label in ['a', 'b']:
    work = scratch / label
    work.mkdir()
    (work / 'package.json').write_text('{"type":"module"}')
    (work / 'vitest.config.mjs').write_text('export default {test:{include:["cases.test.mjs"],testTimeout:30000}}')
    (work / 'cases.test.mjs').write_text(f'''import {{test, expect}} from {json.dumps(str(api))};
import {{writeFileSync, existsSync}} from 'node:fs';
import {{setTimeout}} from 'node:timers/promises';
test('session-{label}', async () => {{
 writeFileSync('ready', '');
 const deadline = Date.now() + 25000;
 while (!existsSync('release') && Date.now() < deadline) await setTimeout(25);
 expect(existsSync('release')).toBe(true);
 console.log('OWNER-{label}');
}});
''')

# Both streams really open the same file, as in the A/B transcript.
children = []
try:
    for label in ['a', 'b']:
        with (scratch / 'integ.log').open('w') as log:
            child = subprocess.Popen(['node', str(vitest), 'run'], cwd=scratch / label,
                                     stdout=log, stderr=subprocess.STDOUT)
        children.append(child)
        await_file(scratch / label / 'ready', child)
    for label, child in zip(['a', 'b'], children):
        (scratch / label / 'release').touch()
        assert child.wait(timeout=40) == 0
    shared = (scratch / 'integ.log').read_text()
    assert f'RUN' in shared and str(scratch / 'b') in shared
    print('Before: session a reads session b\'s Vitest RUN path from the shared log', flush=True)
finally:
    for label in ['a', 'b']:
        (scratch / label / 'release').touch()
    for child in children:
        if child.poll() is None:
            child.terminate()
        child.wait(timeout=10)

jobs = []
for label in ['a', 'b']:
    for name in ['ready', 'release']:
        (scratch / label / name).unlink()
    # Exercise preservation through a nested dev shell, matching agent use.
    command = f'cd {shlex.quote(str(scratch / label))} && node {shlex.quote(str(vitest))} run > "$KANDELO_AGENT_SCRATCH_DIR/integ.log" 2>&1'
    started = subprocess.check_output([str(job), 'start', '--', str(ROOT / 'scripts/dev-shell.sh'),
                                       'bash', '-c', command], cwd=ROOT, env=env, text=True)
    ident = started.splitlines()[0]
    jobs.append((label, ident))
    await_file(scratch / label / 'ready')
for label, ident in jobs:
    (scratch / label / 'release').touch()
for label, ident in jobs:
    result = subprocess.run([str(job), 'wait', ident, '--timeout', '45'], cwd=ROOT, env=env,
                            capture_output=True, text=True)
    (scratch / f'{label}-wait.log').write_text(result.stdout + result.stderr)
    assert result.returncode == 0, result.stdout + result.stderr
    meta = json.loads((scratch / 'jobs/jobs' / ident / 'meta.json').read_text())
    private = Path(meta['payload_dir']) / 'scratch'
    text = (private / 'integ.log').read_text()
    assert str(scratch / label) in text
    assert f'OWNER-{label}' in text
    assert f'OWNER-{"b" if label == "a" else "a"}' not in text
    assert private.stat().st_mode & 0o777 == 0o700
print('After: 2 overlapping agent jobs retained only their own Vitest output', flush=True)
