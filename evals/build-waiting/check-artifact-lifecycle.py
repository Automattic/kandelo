#!/usr/bin/env python3
"""Real browsers in ordinary Git worktrees; no IDE or shared-registry changes.

Run through scripts/dev-shell.sh. The fixture repository, registry, logs and
barriers all belong to a new .context directory and never touch peers' jobs.
"""
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import time

REPO = Path(__file__).resolve().parents[2]
(REPO / '.context').mkdir(exist_ok=True)
evidence = Path(tempfile.mkdtemp(prefix='artifact-lifecycle-', dir=REPO / '.context'))
print(f'Evidence: {evidence}', flush=True)
registry = evidence / 'registry'
env = dict(os.environ, KANDELO_AGENT_JOBS_DIR=str(registry),
           GIT_AUTHOR_NAME='fixture', GIT_COMMITTER_NAME='fixture',
           GIT_AUTHOR_EMAIL='fixture@example.com', GIT_COMMITTER_EMAIL='fixture@example.com',
           GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM='1')
checkout = evidence / 'checkout'
checkout.mkdir()

def git(*args):
    subprocess.run(['git', '-C', str(checkout), *args], env=env, check=True, capture_output=True)

git('init', '-q', '-b', 'trunk')
(checkout / 'package.json').write_text('{"type":"module"}')
git('add', 'package.json')
git('commit', '-q', '-m', 'fixture')
first, peer = evidence / 'first', evidence / 'peer'
for path in [first, peer]:
    git('worktree', 'add', '-q', '-b', path.name, str(path))

cli = REPO / 'apps/browser-demos/node_modules/@playwright/test/cli.js'
fixture = REPO / 'apps/browser-demos/playwright-test.ts'
children, logs = [], []

def prepare(path):
    for name in ['scripts/agent-job', 'scripts/validation_artifacts.py',
                 'tests/playwright-run.ts', 'tests/playwright-run-teardown.ts']:
        target = path / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(REPO / name, target)
    (path / 'playwright.config.ts').write_text('''import {playwrightRun} from './tests/playwright-run';
export default {...playwrightRun(import.meta.dirname), testDir: import.meta.dirname,
 testMatch: 'case.spec.ts', workers: 1, reporter: [['list']],
 use: {silentAudio:true, browserName:'chromium', channel:'chromium',
       launchOptions: {args:['--mute-audio']}}};
''')
    (path / 'case.spec.ts').write_text(f'''import {{test, expect}} from {json.dumps(str(fixture))};
import {{writeFileSync, readFileSync, existsSync}} from 'node:fs';
test('owned evidence', async ({{page}}, info) => {{
 await page.goto('about:blank');
 const path = info.outputPath('owned.txt');
 writeFileSync(path, process.env.CASE_LABEL);
 writeFileSync(process.env.CASE_BARRIER + '.ready', JSON.stringify({{
   id:process.env.KANDELO_PLAYWRIGHT_RUN_ID, path, tmp:process.env.TMPDIR,
   workspace:process.env.KANDELO_VALIDATION_WORKTREE_ID,
 }}));
 await expect.poll(() => existsSync(process.env.CASE_BARRIER + '.release'), {{timeout:60000}}).toBe(true);
 expect(readFileSync(path,'utf8')).toBe(process.env.CASE_LABEL);
 await info.attach('owner', {{path}});
}});
''')


def start(path, label):
    child_env = dict(env, CASE_LABEL=label, CASE_BARRIER=str(evidence / label))
    for key in ['KANDELO_PLAYWRIGHT_RUN_ID', 'KANDELO_PLAYWRIGHT_STORAGE_ROOT',
                'PLAYWRIGHT_HTML_OUTPUT_DIR', 'PLAYWRIGHT_BLOB_OUTPUT_DIR',
                'PLAYWRIGHT_JSON_OUTPUT_FILE', 'PLAYWRIGHT_JUNIT_OUTPUT_FILE']:
        child_env.pop(key, None)
    log = (evidence / f'{label}.log').open('w')
    logs.append(log)
    child = subprocess.Popen(['node', str(cli), 'test', '-c', 'playwright.config.ts'],
        cwd=path, env=child_env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    children.append(child)
    deadline = time.monotonic() + 45
    ready = evidence / f'{label}.ready'
    while not ready.exists():
        if child.poll() is not None or time.monotonic() > deadline:
            raise RuntimeError(f'{label} did not reach its barrier; see {label}.log')
        time.sleep(.05)
    return child, json.loads(ready.read_text())


def command(path, *args, expected=0):
    result = subprocess.run(['python3', 'scripts/agent-job', *args], cwd=path, env=env,
                            capture_output=True, text=True, timeout=30)
    assert result.returncode == expected, result.stdout + result.stderr
    return result


def complete(child, label):
    (evidence / f'{label}.release').touch()
    assert child.wait(timeout=30) == 0, f'see {label}.log'


def payload_bytes(info):
    record = json.loads((registry / 'artifacts' / (info['id'] + '.json')).read_text())
    return sum(path.stat().st_size for root in record['roots']
               for path in (Path(record['worktree']) / root).rglob('*') if path.is_file())

try:
    prepare(first)
    prepare(peer)
    a, a_info = start(first, 'first')
    b, b_info = start(peer, 'peer')
    refused = command(first, 'cleanup', expected=1)
    assert 'active writers' in refused.stderr
    assert Path(a_info['path']).exists() and Path(b_info['path']).exists()
    complete(a, 'first')
    before_release = payload_bytes(a_info)
    # A completed browser's evidence can be released while the peer runs.
    command(first, 'release', a_info['id'])
    assert not Path(a_info['path']).exists() and not Path(a_info['tmp']).exists()
    assert payload_bytes(a_info) == 0
    assert Path(b_info['path']).read_text() == 'peer'
    git('worktree', 'remove', '--force', str(first))
    git('worktree', 'add', '-q', str(first), 'first')
    prepare(first)
    c, c_info = start(first, 'reused')
    assert c_info['workspace'] != a_info['workspace']
    complete(c, 'reused')
    before_removal = payload_bytes(c_info)
    git('worktree', 'remove', '--force', str(first))
    assert not Path(c_info['path']).exists() and not Path(c_info['tmp']).exists()
    assert payload_bytes(c_info) == 0
    command(peer, 'gc', '--dry-run')
    command(peer, 'gc')
    assert Path(b_info['path']).read_text() == 'peer'
    complete(b, 'peer')
    command(peer, 'cleanup')
    assert not Path(b_info['path']).exists() and not Path(b_info['tmp']).exists()
    git('worktree', 'remove', '--force', str(peer))
    result = {'active_cleanup_refused':True, 'finished_release_preserved_live_peer':True,
              'worktree_removal_removed_all_new_payload':True, 'reused_path_has_new_identity':True,
              'orphan_collection_preserved_live_peer':True, 'plain_git_cleanup':True,
              'bytes_before_release':before_release, 'bytes_after_release':0,
              'bytes_before_worktree_removal':before_removal, 'bytes_after_worktree_removal':0}
    (evidence / 'result.json').write_text(json.dumps(result, indent=2)+'\n')
    print(json.dumps(result), flush=True)
finally:
    for label in ['first', 'peer', 'reused']:
        (evidence / f'{label}.release').touch()
    for child in children:
        try:
            child.wait(timeout=30)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGTERM)  # only the browser run we started
            child.wait(timeout=10)
    for log in logs:
        log.close()
