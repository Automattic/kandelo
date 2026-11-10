#!/usr/bin/env python3
"""Two real overlapping runners; use through scripts/dev-shell.sh.

Artifacts stay in a fresh .scratch directory. No existing server is reused or
stopped. Baseline mode confines the old shared output defaults to this fixture.
"""
import argparse
import json
import os
import re
from pathlib import Path
import socket
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--baseline-ref', help='replay the config and policy from this git revision')
parser.add_argument('--project', default='chromium', choices=['chromium', 'firefox', 'webkit'])
args = parser.parse_args()
(ROOT / '.scratch').mkdir(exist_ok=True)
scratch = Path(tempfile.mkdtemp(prefix='concurrent-validation-', dir=ROOT / '.scratch'))
print(f'Evidence: {scratch}', flush=True)

def write(name, content):
    p = scratch / name
    p.write_text(content)
    return p

def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]

def await_file(path, process):
    deadline = time.monotonic() + 60
    while not path.exists():
        if process.poll() is not None or time.monotonic() > deadline:
            raise RuntimeError(f'runner did not reach barrier: {path}')
        time.sleep(.05)

base = ROOT / 'apps/browser-demos/playwright.config.ts'
if args.baseline_ref:
    # Replay the checked-in pre-change config in this private fixture; never
    # restore files in the working tree or disturb a peer's output directory.
    def original(path):
        return subprocess.check_output(['git', 'show', f'{args.baseline_ref}:{path}'], cwd=ROOT, text=True)
    policy = write('baseline-policy.ts', original('apps/browser-demos/playwright-server-policy.ts'))
    source = original('apps/browser-demos/playwright.config.ts')
    def absolute_import(match):
        name = match.group(1)
        target = policy if name == './playwright-server-policy' else (base.parent / name).resolve()
        return 'from ' + json.dumps(str(target))
    source = re.sub(r'from \"(\.[^\"]+)\"', absolute_import, source)
    source = source.replace('from "@playwright/test"', 'from ' + json.dumps(str(ROOT / 'apps/browser-demos/node_modules/@playwright/test/index.mjs')))
    base = write('baseline-config.ts', source)
fixture = ROOT / 'apps/browser-demos/playwright-test.ts'
server = write('server.mjs', '''import http from 'node:http';
http.createServer((req,res) => res.end(process.env.RUN_LABEL)).listen(Number(process.argv[2]), '127.0.0.1');
''')
config = write('playwright.config.ts', f'''import base from {json.dumps(str(base))};
const port = new URL(base.use.baseURL).port;
export default {{...base, globalSetup: undefined, testDir: {json.dumps(str(scratch))},
 testMatch: 'collision.spec.ts', testIgnore: [], workers: 1,
 reporter: [['list'], ['html', {{open: 'never'}}], ['blob'], ['json'], ['junit']],
 webServer: {{...base.webServer, command: `node {server} ${{port}}`, cwd: {json.dumps(str(scratch))}}},
 projects: [base.projects.find(project => project.name === {json.dumps(args.project)})],
}};
''')
write('collision.spec.ts', f'''import {{test, expect}} from {json.dumps(str(fixture))};
import {{writeFileSync, existsSync, readFileSync}} from 'node:fs';
const label = process.env.RUN_LABEL;
test(`private evidence ${{label}}`, async ({{page}}, info) => {{
 await page.goto('/');
 expect(await page.locator('body').innerText()).toBe(label);
 const evidence = info.outputPath('owned.txt');
 writeFileSync(evidence, label);
 writeFileSync(process.env.BARRIER + '.port', new URL(info.project.use.baseURL).port);
 writeFileSync(process.env.BARRIER + '.ready', evidence);
 await expect.poll(() => existsSync(process.env.BARRIER + '.release'), {{timeout: 45000}}).toBe(true);
 expect(readFileSync(evidence, 'utf8')).toBe(label);
 await info.attach('owner', {{path: evidence}});
}});
''')
# Playwright infers ESM from the nearest package.json.
write('package.json', '{"type":"module"}')
pw = ROOT / 'apps/browser-demos/node_modules/@playwright/test/cli.js'
logs = []
children = []
def start(label, port=None):
    env = dict(os.environ, RUN_LABEL=label, BARRIER=str(scratch / label))
    for key in ['KANDELO_PLAYWRIGHT_RUN_ID', 'KANDELO_PLAYWRIGHT_PORT',
                'PLAYWRIGHT_HTML_OUTPUT_DIR', 'PLAYWRIGHT_BLOB_OUTPUT_DIR',
                'PLAYWRIGHT_JSON_OUTPUT_FILE', 'PLAYWRIGHT_JUNIT_OUTPUT_FILE']:
        env.pop(key, None)
    if port is not None:
        env['KANDELO_PLAYWRIGHT_PORT'] = str(port)
    log = open(scratch / f'{label}.log', 'w')
    logs.append(log)
    p = subprocess.Popen(['node', str(pw), 'test', '-c', str(config)], cwd=scratch, env=env, stdout=log, stderr=subprocess.STDOUT)
    children.append(p)
    return p

failures = []
try:
    # Separate servers expose only the output/report collision.
    a = start('output-a', free_port())
    await_file(scratch / 'output-a.ready', a)
    a_path = Path((scratch / 'output-a.ready').read_text())
    b = start('output-b', free_port())
    await_file(scratch / 'output-b.ready', b)
    retained = a_path.exists()
    for label in ['output-a', 'output-b']:
        (scratch / f'{label}.release').touch()
    exits = [a.wait(timeout=60), b.wait(timeout=60)]
    print(f'Output pair: first attachment retained={retained}; exits={exits}', flush=True)
    if not retained or exits != [0, 0]:
        failures.append('shared output cleanup corrupted the first run')
    if not args.baseline_ref:
        roots = [Path((scratch / f'{label}.ready').read_text()).parents[2]
                 for label in ['output-a', 'output-b']]
        assert roots[0] != roots[1]
        for label, root in zip(['output-a', 'output-b'], roots):
            assert (root / 'html/index.html').exists()
            assert list((root / 'blob').glob('*.zip'))
            report = json.loads((root / 'report.json').read_text())
            assert f'private evidence {label}' in json.dumps(report)
            assert f'private evidence {label}' in (root / 'junit.xml').read_text()
        print('All four file reporters retained separate reports', flush=True)
    # Both configs choose their default server port. Baseline pins a fresh
    # port so it cannot attach to a user or peer on the historical default.
    port = free_port() if args.baseline_ref else None
    c = start('server-a', port)
    await_file(scratch / 'server-a.ready', c)
    d = start('server-b', port)
    try:
        await_file(scratch / 'server-b.ready', d)
    except RuntimeError:
        failures.append('second server run did not reach its own page')
    for label in ['server-a', 'server-b']:
        (scratch / f'{label}.release').touch()
    exits = [c.wait(timeout=60), d.wait(timeout=60)]
    print(f'Default-server pair exits={exits}', flush=True)
    if exits != [0, 0]:
        failures.append('server identity mismatch')
    if not args.baseline_ref:
        owner = start('pinned-owner')
        await_file(scratch / 'pinned-owner.ready', owner)
        occupied = int((scratch / 'pinned-owner.port').read_text())
        refused = start('pinned-refused', occupied)
        refused_exit = refused.wait(timeout=45)
        (scratch / 'pinned-owner.release').touch()
        assert owner.wait(timeout=60) == 0
        assert refused_exit != 0
        assert 'already used' in (scratch / 'pinned-refused.log').read_text()
        assert not (scratch / 'pinned-refused.ready').exists()
        print('Occupied explicit port: refused loudly; owner passed', flush=True)
finally:
    # Release barriers even on a failed baseline. Terminate only our runners.
    for label in ['output-a', 'output-b', 'server-a', 'server-b', 'pinned-owner', 'pinned-refused']:
        (scratch / f'{label}.release').touch()
    for child in children:
        try:
            child.wait(timeout=60)
        except subprocess.TimeoutExpired:
            child.terminate()
            child.wait(timeout=10)
    for log in logs:
        log.close()

assert not failures, '; '.join(failures)
