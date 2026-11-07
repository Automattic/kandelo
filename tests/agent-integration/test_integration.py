import copy
import json
import os
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

from support import Fixture
from agent_integration import cli, engine, gitops as g
from agent_integration.manifest import Invalid, digest, load, read_manifest


class IntegrationTests(unittest.TestCase):
    def setUp(self):
        self.f = Fixture()
        self.addCleanup(self.f.close)

    def preflight(self):
        self.f.persist()
        return engine.preflight(self.f.root, self.f.spec)

    def applied(self, commit=False, push=False):
        op, state = self.f.create(commit, push)
        self.assertEqual(engine.run_operation(op, state), 3)
        return op, state

    def test_preflight_is_read_only_and_complete(self):
        before = self.f.git('status', '--porcelain=v1', '-z')
        self.preflight()
        self.assertEqual(before, self.f.git('status', '--porcelain=v1', '-z'))
        self.assertFalse((self.f.root / '.context/agent-integrations').exists())

    def test_missing_and_unknown_fields(self):
        for key in ['version', 'base_commit', 'evidence', 'inputs', 'checks']:
            original = self.f.manifest.pop(key)
            with self.subTest(key=key), self.assertRaisesRegex(Invalid, 'missing required'):
                self.preflight()
            self.f.manifest[key] = original
        self.f.manifest['invented'] = True
        with self.assertRaisesRegex(Invalid, 'unknown field'):
            self.preflight()

    def test_version_and_noncanonical_identifiers(self):
        for field, bad in [('version', 2), ('base_commit', self.f.base.upper()), ('id', '../bad'), ('id', 'task\n')]:
            old = self.f.manifest[field]
            self.f.manifest[field] = bad
            with self.subTest(field=field, bad=bad), self.assertRaises(Invalid):
                self.preflight()
            self.f.manifest[field] = old

    def test_duplicate_json_keys_rejected(self):
        self.f.spec.write_text('{"version":1,"version":1}')
        with self.assertRaisesRegex(Invalid, 'duplicate JSON key'):
            read_manifest(self.f.spec)

    def test_unknown_node_family(self):
        state = self.f.write('.context/node-state.json', '{"families":{"fs":{}}}')
        self.f.manifest['adapter'] = {'kind': 'node', 'state': {'path': '.context/node-state.json', 'sha256': digest(state.read_bytes())}, 'families': ['filesystem']}
        with self.assertRaisesRegex(Invalid, 'unknown Node family'):
            self.preflight()
        self.f.manifest['adapter']['families'] = ['fs']
        self.preflight()

    def test_missing_or_changed_evidence_and_required_input(self):
        self.f.manifest['inputs'] = [{'path': '.context/missing', 'sha256': '0' * 64}]
        with self.assertRaisesRegex(Invalid, 'missing or changed'):
            self.preflight()
        self.f.manifest['inputs'] = []
        self.f.write('.context/report.json', '{}')
        with self.assertRaisesRegex(Invalid, 'missing or changed'):
            self.preflight()

    def test_target_pin_and_historical_evidence(self):
        self.f.manifest['target_pins'] = [{'path': 'unrelated.txt', 'sha256': '0' * 64}]
        with self.assertRaisesRegex(Invalid, 'missing or changed'):
            self.preflight()
        self.f.manifest['target_pins'] = []
        self.f.manifest['evidence'][0]['source_commit'] = self.f.base
        with self.assertRaisesRegex(Invalid, 'historical evidence'):
            self.preflight()
        self.f.manifest['evidence'][0]['reused'] = True
        self.preflight()

    def test_seal_member_hash_and_path_escape(self):
        member = self.f.write('.context/capsule/member.txt', 'sealed\n')
        seal = self.f.write('.context/capsule/SEAL.json', json.dumps({'version': 1, 'members': {'member.txt': digest(member.read_bytes())}}))
        self.f.manifest['seals'] = [{'path': '.context/capsule/SEAL.json', 'sha256': digest(seal.read_bytes())}]
        self.preflight()
        member.write_text('changed\n')
        with self.assertRaisesRegex(Invalid, 'missing or changed'):
            self.preflight()
        seal.write_text(json.dumps({'version': 1, 'members': {'../escape': '0' * 64}}))
        self.f.manifest['seals'][0]['sha256'] = digest(seal.read_bytes())
        with self.assertRaisesRegex(Invalid, 'unsafe path'):
            self.preflight()

    def test_unsafe_paths_and_protected_overlap(self):
        for name in ['../escape', '/tmp/escape', '.git/config', 'protected/keep.txt']:
            old = self.f.manifest['owned_paths'][0]
            self.f.manifest['owned_paths'][0] = name
            with self.subTest(name=name), self.assertRaises(Invalid):
                self.preflight()
            self.f.manifest['owned_paths'][0] = old

    def test_symlink_input_rejected(self):
        (self.f.root / '.context/link').symlink_to(self.f.root / 'unrelated.txt')
        self.f.manifest['inputs'] = [{'path': '.context/link', 'sha256': digest(b'unrelated\n')}]
        with self.assertRaisesRegex(Invalid, 'symlink'):
            self.preflight()

    def test_stale_patch_preimage(self):
        self.f.manifest['patch']['before']['owned.txt'] = '0' * 64
        with self.assertRaisesRegex(Invalid, 'preimage'):
            self.preflight()

    def test_staged_new_file_whitespace(self):
        self.f.write('added.txt', 'new file   \n')
        self.f.git('add', '--', 'added.txt')
        before = self.f.git('diff', '--cached', '--binary')
        with self.assertRaisesRegex(Invalid, 'whitespace in new file'):
            self.preflight()
        self.assertEqual(before, self.f.git('diff', '--cached', '--binary'))

    def test_patch_whitespace_and_unowned_path_rejected(self):
        self.f.write('.context/reviewed.patch', (self.f.root / '.context/reviewed.patch').read_bytes().replace(b'+new file\n', b'+new file  \n'))
        self.f.manifest['patch']['sha256'] = digest((self.f.root / '.context/reviewed.patch').read_bytes())
        with self.assertRaisesRegex(Invalid, 'whitespace'):
            self.preflight()
        self.assertFalse((self.f.root / 'added.txt').exists())

    def test_dirty_owned_overlap_rejected(self):
        self.f.write('owned.txt', 'other agent work\n')
        with self.assertRaisesRegex(Invalid, 'dirty overlap'):
            self.preflight()

    def test_staged_owned_change_with_clean_worktree_rejected(self):
        self.f.write('owned.txt', 'staged change\n')
        self.f.git('add', '--', 'owned.txt')
        self.f.write('owned.txt', 'before\n')
        with self.assertRaisesRegex(Invalid, 'dirty overlap'):
            self.preflight()

    def test_owned_index_edit_during_operation_never_overwritten(self):
        op, state = self.applied()
        self.f.write('owned.txt', 'new staged change\n')
        self.f.git('add', '--', 'owned.txt')
        self.f.write('owned.txt', 'after\n')
        self.assertEqual(engine.run_operation(op, state), 2)
        self.assertEqual(self.f.git('show', ':owned.txt'), b'new staged change\n')

    def test_unowned_patch_change_rejected(self):
        (self.f.source / 'unrelated.txt').write_text('unreviewed extra change\n')
        self.f.sgit('add', '--', 'unrelated.txt')
        self.f.sgit('commit', '-qm', 'Test: Extra path outside ownership')
        self.f.manifest['source']['commit'] = self.f.sgit('rev-parse', 'HEAD').decode().strip()
        self.f.manifest['evidence'][0]['source_commit'] = self.f.manifest['source']['commit']
        data = self.f.sgit('diff', '--binary', '--no-renames', self.f.base, 'HEAD')
        self.f.write('.context/reviewed.patch', data)
        self.f.manifest['patch']['sha256'] = digest(data)
        with self.assertRaisesRegex(Invalid, 'patch paths must equal'):
            self.preflight()

    def test_unrelated_dirty_names_modes_and_symlinks_preserved(self):
        spaced = self.f.write('unrelated file with spaces.txt', 'precious\n')
        spaced.chmod(0o755)
        link = self.f.root / 'unrelated-link'
        link.symlink_to('unrelated file with spaces.txt')
        op, state = self.applied()
        self.f.finish_check(op, state)
        self.assertEqual(engine.run_operation(op, state), 0)
        self.assertEqual(spaced.read_text(), 'precious\n')
        self.assertEqual(spaced.stat().st_mode & 0o777, 0o755)
        self.assertTrue(link.is_symlink())
        self.assertEqual(os.readlink(link), 'unrelated file with spaces.txt')

    def test_unrelated_dirty_and_staged_work_preserved(self):
        self.f.write('unrelated.txt', 'staged work\n')
        self.f.git('add', '--', 'unrelated.txt')
        self.f.write('unrelated.txt', 'unstaged work\n')
        self.f.write('loose.txt', 'untracked work\n')
        index_before = g.index_entries(self.f.root, self.f.manifest['owned_paths'])
        op, state = self.applied()
        self.f.finish_check(op, state)
        self.assertEqual(engine.run_operation(op, state), 0)
        self.assertEqual(index_before, g.index_entries(self.f.root, self.f.manifest['owned_paths']))
        self.assertEqual((self.f.root / 'unrelated.txt').read_text(), 'unstaged work\n')
        self.assertEqual((self.f.root / 'loose.txt').read_text(), 'untracked work\n')

    def test_partial_application_resumes_exact_files(self):
        op, state = self.f.create()
        atomic = g.atomic
        count = 0
        def interrupted(filename, data):
            nonlocal count
            if filename.parent == self.f.root:
                count += 1
                if count == 2:
                    raise KeyboardInterrupt()
            return atomic(filename, data)
        with patch.object(g, 'atomic', side_effect=interrupted), self.assertRaises(KeyboardInterrupt):
            engine.run_operation(op, state)
        durable = load(op / 'ledger.json')
        self.assertEqual(durable['steps'][0]['state'], 'started')
        self.assertEqual((self.f.root / 'added.txt').read_text(), 'new file\n')
        with patch.object(g, 'atomic', wraps=atomic) as writes:
            self.assertEqual(engine.run_operation(op, durable), 3)
            changed = [str(c.args[0].relative_to(self.f.root)) for c in writes.call_args_list]
        self.assertNotIn('added.txt', changed)
        self.assertEqual((self.f.root / 'notes.md').read_bytes(), (self.f.source / 'notes.md').read_bytes())

    def test_uncertain_application_is_explicit_and_not_overwritten(self):
        op, state = self.f.create()
        self.f.write('owned.txt', 'unexpected\n')
        self.assertEqual(engine.run_operation(op, state), 2)
        self.assertEqual(state['steps'][0]['state'], 'uncertain')
        self.assertEqual((self.f.root / 'owned.txt').read_text(), 'unexpected\n')
        self.assertFalse((self.f.root / 'added.txt').exists())

    def test_transactional_ledger_survives_replace_failure(self):
        op, state = self.f.create()
        before = (op / 'ledger.json').read_bytes()
        state['checkpoint'] = {'incomplete': True}
        with patch.object(os, 'replace', side_effect=OSError('injected disk failure')):
            with self.assertRaises(OSError):
                engine.save(op, state)
        self.assertEqual((op / 'ledger.json').read_bytes(), before)
        self.assertIsNone(load(op / 'ledger.json')['checkpoint'])

    def test_duplicate_checkpoint_and_duplicate_result_prevented(self):
        op, state = self.applied()
        filename, sha, _ = self.f.finish_check(op, state)
        self.assertEqual(engine.run_operation(op, state), 0)
        checkpoint_bytes = (op / 'ledger.json').read_bytes()
        engine.record_report(op, state, filename, sha)
        self.assertEqual(engine.run_operation(op, state), 0)
        self.assertEqual((op / 'ledger.json').read_bytes(), checkpoint_bytes)
        self.assertEqual(sum(e['kind'] == 'step-complete' and e['step'] == 'checkpoint' for e in state['events']), 1)
        self.assertFalse(state['checkpoint']['finding_closure'])
        self.assertFalse(state['checkpoint']['broader_support_established'])

    def test_checkpoint_stage_reconciled_without_repeating_add(self):
        op, state = self.applied()
        self.f.finish_check(op, state)
        original = engine.finish
        def interrupted(op, state, step, **kwargs):
            if step['id'] == 'checkpoint':
                raise KeyboardInterrupt()
            return original(op, state, step, **kwargs)
        with patch.object(engine, 'finish', side_effect=interrupted), self.assertRaises(KeyboardInterrupt):
            engine.run_operation(op, state)
        durable = load(op / 'ledger.json')
        original_git = g.git
        def no_add(root, *args, **kwargs):
            self.assertNotEqual(args[0], 'add')
            return original_git(root, *args, **kwargs)
        with patch.object(g, 'git', side_effect=no_add):
            self.assertEqual(engine.run_operation(op, durable), 0)

    def test_main_and_source_ref_drift_reported_without_substitution(self):
        op, state = self.applied()
        self.f.finish_check(op, state)
        self.f.sgit('commit', '--allow-empty', '-qm', 'Test: Later source')
        later = self.f.sgit('rev-parse', 'HEAD').decode().strip()
        self.f.git('fetch', '-q', str(self.f.source), later)
        self.f.git('update-ref', 'refs/remotes/origin/main', later)
        self.assertEqual(engine.run_operation(op, state), 0)
        status = cli.current_status(op, state)
        self.assertTrue(status['drift']['main'])
        self.assertTrue(status['drift']['source'])
        self.assertEqual(status['source_commit'], self.f.manifest['source']['commit'])
        self.assertEqual(status['frozen_main']['commit'], self.f.base)

    def test_main_ref_drift_before_preflight_rejected(self):
        self.f.git('fetch', '-q', str(self.f.source), 'HEAD')
        self.f.git('update-ref', 'refs/remotes/origin/main', self.f.manifest['source']['commit'])
        with self.assertRaisesRegex(Invalid, 'main ref moved'):
            self.preflight()

    def test_noncanonical_main_ref_rejected(self):
        self.f.manifest['main']['ref'] = 'HEAD'
        with self.assertRaisesRegex(Invalid, 'fully qualified'):
            self.preflight()

    def test_postimage_drift_invalidates_evidence(self):
        op, state = self.applied()
        self.f.finish_check(op, state)
        self.f.write('owned.txt', 'changed after check\n')
        self.assertEqual(engine.run_operation(op, state), 2)
        self.assertFalse(cli.current_status(op, state)['evidence_current_for_frozen_inputs'])
        self.assertIsNone(state['checkpoint'])

    def test_stale_result_and_command_change_rejected(self):
        op, state = self.applied()
        filename, _, report = self.f.report(state)
        for key, value in [('source_binding', '0' * 64), ('argv', ['false']), ('cwd', 'protected')]:
            bad = {**report, key: value}
            raw = json.dumps(bad).encode()
            filename.write_bytes(raw)
            with self.subTest(key=key), self.assertRaises(Invalid):
                engine.record_report(op, state, filename, digest(raw))
        self.assertEqual(state['evidence'], [])

    def test_wait_window_preserves_handle_and_does_not_fail_process(self):
        op, state = self.applied()
        self.f.finish_check(op, state, phase='waiting')
        self.assertEqual(engine.run_operation(op, state), 3)
        self.assertEqual(state['steps'][1]['state'], 'waiting')
        self.assertEqual(state['failures'], [])
        self.assertEqual(cli.current_status(op, state)['active_jobs'][0]['id'], 'test-job-1')
        with self.assertRaisesRegex(Invalid, 'original job handle'):
            self.f.finish_check(op, state, job='replacement-job')
        self.f.finish_check(op, state)
        self.assertEqual(engine.run_operation(op, state), 0)

    def test_process_exit_124_timeout_skip_unsupported_and_harness_error_preserved(self):
        for outcome, code in [('fail', 124), ('timeout', 124), ('skip', 0), ('unsupported', 0), ('harness-error', 125)]:
            with self.subTest(outcome=outcome):
                f = Fixture()
                try:
                    op, state = f.create()
                    self.assertEqual(engine.run_operation(op, state), 3)
                    f.finish_check(op, state, outcome=outcome, code=code)
                    self.assertEqual(engine.run_operation(op, state), 1)
                    self.assertEqual(state['evidence'][0]['outcome'], outcome)
                    self.assertIsNone(state['checkpoint'])
                    with self.assertRaisesRegex(Invalid, 'terminal check result'):
                        f.finish_check(op, state)
                finally:
                    f.close()

    def test_lost_supervisor_is_not_a_wait(self):
        op, state = self.applied()
        self.f.finish_check(op, state, phase='lost', outcome='harness-error', code=125)
        self.assertEqual(engine.run_operation(op, state), 1)
        self.assertEqual(state['failures'][0]['outcome'], 'harness-error')

    def test_result_log_hash_checked_and_retained(self):
        op, state = self.applied()
        self.f.finish_check(op, state, reused=True)
        self.f.write('.context/check.log', 'changed log\n')
        self.assertEqual(engine.run_operation(op, state), 2)
        self.assertTrue(state['evidence'][0]['reused'])

    def test_unauthorized_commit_and_push_do_not_apply(self):
        self.f.manifest['commit']['authorized'] = False
        with self.assertRaisesRegex(Invalid, 'not authorized'):
            self.f.create(commit=True)
        self.assertEqual((self.f.root / 'owned.txt').read_text(), 'before\n')
        with self.assertRaisesRegex(Invalid, 'push requires'):
            self.f.create(push=True)

    def test_commit_includes_only_owned_paths(self):
        self.f.write('unrelated.txt', 'staged unrelated\n')
        self.f.git('add', '--', 'unrelated.txt')
        op, state = self.applied(commit=True)
        self.f.finish_check(op, state)
        self.assertEqual(engine.run_operation(op, state), 0)
        changed = set(self.f.git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').decode().splitlines())
        self.assertEqual(changed, set(self.f.manifest['owned_paths']))
        self.assertEqual(self.f.git('show', 'HEAD:unrelated.txt'), b'unrelated\n')
        self.assertEqual(self.f.git('show', ':unrelated.txt'), b'staged unrelated\n')
        head = self.f.git('rev-parse', 'HEAD')
        self.assertEqual(engine.run_operation(op, state), 0)
        self.assertEqual(head, self.f.git('rev-parse', 'HEAD'))

    def test_commit_update_ref_crash_reconciled(self):
        op, state = self.applied(commit=True)
        self.f.finish_check(op, state)
        original = engine.finish
        def interrupted(op, state, step, **kwargs):
            if step['id'] == 'commit':
                raise KeyboardInterrupt()
            return original(op, state, step, **kwargs)
        with patch.object(engine, 'finish', side_effect=interrupted), self.assertRaises(KeyboardInterrupt):
            engine.run_operation(op, state)
        head = self.f.git('rev-parse', 'HEAD')
        durable = load(op / 'ledger.json')
        with patch.object(engine, 'commit_step', wraps=engine.commit_step):
            self.assertEqual(engine.run_operation(op, durable), 0)
        self.assertEqual(head, self.f.git('rev-parse', 'HEAD'))

    def test_commit_object_creation_crash_recreates_identical_object(self):
        op, state = self.applied(commit=True)
        self.f.finish_check(op, state)
        original_save = engine.save
        original_git = g.git
        objects = []
        def interrupt_save(op, state):
            if any(s['id'] == 'commit' and s.get('commit') for s in state['steps']):
                raise KeyboardInterrupt()
            return original_save(op, state)
        def capture_git(root, *args, **kwargs):
            if args[0] == 'commit-tree':
                self.assertIn('GIT_AUTHOR_DATE', kwargs['env'])
                self.assertIn('GIT_COMMITTER_DATE', kwargs['env'])
            result = original_git(root, *args, **kwargs)
            if args[0] == 'commit-tree':
                objects.append(result)
            return result
        with patch.object(engine, 'save', side_effect=interrupt_save), patch.object(g, 'git', side_effect=capture_git), self.assertRaises(KeyboardInterrupt):
            engine.run_operation(op, state)
        durable = load(op / 'ledger.json')
        with patch.object(g, 'git', side_effect=capture_git):
            self.assertEqual(engine.run_operation(op, durable), 0)
        self.assertEqual(len(objects), 2)
        self.assertEqual(objects[0], objects[1])

    def test_completed_commit_branch_reset_is_drift(self):
        op, state = self.applied(commit=True)
        self.f.finish_check(op, state)
        self.assertEqual(engine.run_operation(op, state), 0)
        self.f.git('update-ref', state['branch'], self.f.base)
        self.assertEqual(engine.run_operation(op, state), 2)
        self.assertTrue(cli.current_status(op, state)['drift']['target'])

    def test_cli_rejected_result_is_retained_without_completing_check(self):
        op, state = self.applied()
        filename, sha, report = self.f.report(state)
        report['source_binding'] = '0' * 64
        raw = json.dumps(report).encode()
        filename.write_bytes(raw)
        result = self.f.cli('record', self.f.manifest['id'], '--report', filename, '--sha256', digest(raw))
        self.assertEqual(result.returncode, 2)
        durable = load(op / 'ledger.json')
        self.assertEqual(durable['steps'][1]['state'], 'ready')
        self.assertEqual(durable['evidence'], [])
        self.assertEqual(durable['events'][-1]['kind'], 'result-rejected')

    def test_cli_process_exit_124_is_reported_as_failure(self):
        op, state = self.applied()
        filename, sha, _ = self.f.report(state, outcome='fail', code=124)
        result = self.f.cli('record', self.f.manifest['id'], '--report', filename, '--sha256', sha)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn('fail (exit 124)', result.stdout)
        self.assertNotIn('wait-window', result.stdout)
        self.assertIsNone(load(op / 'ledger.json')['checkpoint'])

    def test_push_local_bare_and_resume_no_duplicate(self):
        remote = self.f.directory / 'bare.git'
        subprocess.run(['git', 'init', '--bare', '-q', str(remote)], check=True)
        self.f.git('remote', 'add', 'local-test', str(remote))
        op, state = self.applied(commit=True, push=True)
        self.f.finish_check(op, state)
        self.assertEqual(engine.run_operation(op, state), 0)
        commit = self.f.git('rev-parse', 'HEAD').decode().strip()
        self.assertEqual(engine.remote_head(self.f.root, str(remote), 'refs/heads/checkpoint'), commit)
        with patch.object(g, 'run', wraps=g.run) as commands:
            self.assertEqual(engine.run_operation(op, state), 0)
            self.assertFalse(any(c.args[0][:2] == ['git', 'push'] for c in commands.call_args_list))

    def test_uncertain_push_is_never_blindly_repeated(self):
        remote = self.f.directory / 'bare.git'
        subprocess.run(['git', 'init', '--bare', '-q', str(remote)], check=True)
        self.f.git('remote', 'add', 'local-test', str(remote))
        op, state = self.applied(commit=True, push=True)
        self.f.finish_check(op, state)
        with patch.object(engine, 'push_step', side_effect=KeyboardInterrupt), self.assertRaises(KeyboardInterrupt):
            engine.run_operation(op, state)
        durable = load(op / 'ledger.json')
        with patch.object(g, 'run', wraps=g.run) as commands:
            self.assertEqual(engine.run_operation(op, durable), 2)
            self.assertFalse(any(c.args[0][:2] == ['git', 'push'] for c in commands.call_args_list))
        self.assertIsNone(engine.remote_head(self.f.root, str(remote), 'refs/heads/checkpoint'))
        self.assertIn('uncertain push outcome', durable['failures'][-1]['detail'])

    def test_completed_push_before_journal_finish_is_reconciled(self):
        remote = self.f.directory / 'bare.git'
        subprocess.run(['git', 'init', '--bare', '-q', str(remote)], check=True)
        self.f.git('remote', 'add', 'local-test', str(remote))
        op, state = self.applied(commit=True, push=True)
        self.f.finish_check(op, state)
        original_finish = engine.finish
        def interrupted(op, state, step, **kwargs):
            if step['id'] == 'push':
                raise KeyboardInterrupt()
            return original_finish(op, state, step, **kwargs)
        with patch.object(engine, 'finish', side_effect=interrupted), self.assertRaises(KeyboardInterrupt):
            engine.run_operation(op, state)
        durable = load(op / 'ledger.json')
        with patch.object(g, 'run', wraps=g.run) as commands:
            self.assertEqual(engine.run_operation(op, durable), 0)
            self.assertFalse(any(c.args[0][:2] == ['git', 'push'] for c in commands.call_args_list))

    def test_protected_and_unrelated_guard_changes_block(self):
        op, state = self.applied()
        self.f.write('protected/new.txt', 'new protected file\n')
        self.assertEqual(engine.run_operation(op, state), 2)
        self.assertIsNone(state['checkpoint'])

    def test_cli_does_not_launch_declared_commands(self):
        sentinel = self.f.directory / 'should-not-exist'
        self.f.manifest['checks'][0]['argv'] = ['touch', str(sentinel)]
        self.f.persist()
        result = self.f.cli('run', self.f.spec)
        self.assertEqual(result.returncode, 3, result.stdout + result.stderr)
        self.assertFalse(sentinel.exists())
        status = self.f.cli('status', self.f.manifest['id'], '--json')
        self.assertEqual(status.returncode, 0, status.stderr)
        self.assertIn('await validation manager', json.loads(status.stdout)['next_action'])


if __name__ == '__main__':
    unittest.main()
