"""Small throwaway repositories, never the user's index or remote."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / 'scripts'))
from agent_integration import engine, gitops as g
from agent_integration.manifest import digest


class Fixture:
    def __init__(self):
        self.temp = tempfile.TemporaryDirectory(prefix='kandelo-integrate-test-')
        self.directory = Path(self.temp.name).resolve()
        self.root = self.directory / 'target'
        self.source = self.directory / 'source'
        self.root.mkdir()
        self.git('init', '-q', '-b', 'work')
        self.git('config', 'user.name', 'Integration Test')
        self.git('config', 'user.email', 'integration@example.invalid')
        self.git('config', 'commit.gpgsign', 'false')
        self.write('.gitignore', '.context/\n')
        self.write('owned.txt', 'before\n')
        self.write('notes.md', '# Reviewed change\n')
        self.write('unrelated.txt', 'unrelated\n')
        self.write('protected/keep.txt', 'protected\n')
        self.git('add', '.')
        self.git('commit', '-qm', 'Test: Base')
        self.base = self.git('rev-parse', 'HEAD').decode().strip()
        self.git('update-ref', 'refs/remotes/origin/main', self.base)
        subprocess.run(['git', 'clone', '-q', str(self.root), str(self.source)], check=True)
        for key, value in [('user.name', 'Integration Test'), ('user.email', 'integration@example.invalid'), ('commit.gpgsign', 'false')]:
            self.sgit('config', key, value)
        (self.source / 'owned.txt').write_text('after\n')
        (self.source / 'notes.md').write_text('# Reviewed change\n\nSource-only integration. Runtime remains unestablished.\n')
        (self.source / 'added.txt').write_text('new file\n')
        self.sgit('add', '.')
        self.sgit('commit', '-qm', 'Test: Reviewed source and notes')
        source_commit = self.sgit('rev-parse', 'HEAD').decode().strip()
        patch = self.sgit('diff', '--binary', '--no-renames', self.base, 'HEAD')
        self.write('.context/reviewed.patch', patch)
        self.write('.context/report.json', '{"scope":"source review; no runtime claim"}\n')
        owned = ['added.txt', 'notes.md', 'owned.txt']
        self.manifest = {
            'version': 1, 'id': 'reviewed-change', 'base_commit': self.base,
            'main': {'ref': 'refs/remotes/origin/main', 'commit': self.base},
            'source': {'root': str(self.source), 'commit': source_commit, 'ref': 'HEAD',
                       'identities': {n: digest((self.source / n).read_bytes()) for n in owned}},
            'owned_paths': owned, 'protected_paths': ['protected'],
            'patch': {'path': '.context/reviewed.patch', 'sha256': digest(patch),
                      'before': {n: digest((self.root / n).read_bytes()) if (self.root / n).exists() else None for n in owned},
                      'after': {n: digest((self.source / n).read_bytes()) for n in owned}},
            'inputs': [], 'target_pins': [], 'seals': [],
            'evidence': [{'path': '.context/report.json', 'sha256': digest((self.root / '.context/report.json').read_bytes()),
                          'dimension': 'inventory', 'scope': 'reviewed fixture only', 'outcome': 'unsupported',
                          'source_commit': source_commit, 'reused': False}],
            'checks': [{'id': 'content', 'argv': [sys.executable, '-c', "from pathlib import Path; assert Path('owned.txt').read_text() == 'after\\n'"],
                        'cwd': '.', 'dimension': 'source', 'scope': 'exact fixture text', 'timeout_seconds': 10}],
            'checkpoint': {'scope': 'fixture source and documentation only', 'blockers': ['runtime conformance not established']},
            'commit': {'authorized': True, 'message': 'Test: Reviewed integration'},
            'push': {'authorized': True, 'remote': 'local-test', 'ref': 'refs/heads/checkpoint', 'expected': None},
        }
        self.spec = self.root / '.context/manifest.json'
        self.persist()

    def git(self, *args):
        return g.git(self.root, *args)

    def sgit(self, *args):
        return g.git(self.source, *args)

    def write(self, name, value):
        p = self.root / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(value.encode() if isinstance(value, str) else value)
        return p

    def persist(self):
        self.spec.write_text(json.dumps(self.manifest, indent=2) + '\n')

    def create(self, commit=False, push=False):
        self.persist()
        return engine.create(self.root, self.spec, commit, push)

    def report(self, state, outcome='pass', code=0, job='test-job-1', phase='finished', reused=False):
        check = self.manifest['checks'][0]
        log = self.write('.context/check.log', 'Fixture check output\n')
        report = {'version': 1, 'source_binding': state['source_binding'], 'check_id': check['id'],
                  'argv': check['argv'], 'cwd': check['cwd'], 'job_id': job, 'state': phase,
                  'outcome': None if phase == 'waiting' else outcome, 'exit_code': None if phase == 'waiting' else code,
                  'log': {'path': str(log.relative_to(self.root)), 'sha256': None if phase == 'waiting' else digest(log.read_bytes())},
                  'reused': reused}
        raw = json.dumps(report, indent=2).encode() + b'\n'
        filename = self.write('.context/result-' + digest(raw) + '.json', raw)
        return filename, digest(raw), report

    def finish_check(self, op, state, **kwargs):
        filename, sha, report = self.report(state, **kwargs)
        engine.record_report(op, state, filename, sha)
        return filename, sha, report

    def cli(self, *args):
        return subprocess.run([sys.executable, str(REPO / 'scripts/agent-integrate'), '--root', str(self.root), *map(str, args)],
                              cwd=REPO, capture_output=True, text=True)

    def close(self):
        self.temp.cleanup()
