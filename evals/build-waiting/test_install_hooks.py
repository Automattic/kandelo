#!/usr/bin/env python3
"""Automatic maintenance must preserve opt-in and merged-source provenance."""
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

REPO = pathlib.Path(__file__).resolve().parents[2]


class InstallHooksTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix="hook-install-test-")
        self.addCleanup(tmp.cleanup)
        self.root = pathlib.Path(tmp.name)
        self.home = self.root / "home"
        self.checkout = self.root / "checkout"
        self.hooks = self.checkout / ".claude/hooks"
        self.hooks.mkdir(parents=True)
        self.installer = self.hooks / "install-hooks.py"
        shutil.copy(REPO / ".claude/hooks/install-hooks.py", self.installer)
        self.merged = "HOOK_VERSION = 4\n# merged source\n"
        (self.hooks / "wait-guard.py").write_text(self.merged)
        self.env = dict(os.environ, HOME=str(self.home))
        self.git("init", "-q")
        self.git("add", ".")
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
                 "commit", "--no-gpg-sign", "-qm", "fixture")
        self.git("update-ref", "refs/remotes/origin/main", "HEAD")
        (self.hooks / "wait-guard.py").write_text("HOOK_VERSION = 99\n# unmerged feature\n")
        # The current branch can run the updater, but must never supply the
        # installer used to change the user's registered hook/settings.
        text = self.installer.read_text().replace(
            "    path, command = target(args, filename, user_copy)",
            "    if not args.update_from_main:\n        raise RuntimeError('unmerged installer used')\n"
            "    path, command = target(args, filename, user_copy)")
        self.assertIn("unmerged installer used", text)
        self.installer.write_text(text)
        self.copy = self.home / ".claude/hooks/kandelo-wait-guard.py"
        self.settings = self.home / ".claude/settings.json"

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.checkout, env=self.env,
                              capture_output=True, text=True, check=True)

    def opt_in(self, version=3):
        self.copy.parent.mkdir(parents=True)
        self.copy.write_text(f"HOOK_VERSION = {version}\n" if version else "# old unversioned hook\n")
        settings = {"permissions": {"deny": ["Bash(example)"]}, "hooks": {"PreToolUse": [
            {"matcher": "Bash", "hooks": [{"type": "command", "command": "python3 ~/.claude/hooks/kandelo-wait-guard.py"},
                                          {"type": "command", "command": "other-hook"}]}]}}
        self.settings.write_text(json.dumps(settings))

    def update(self, scope="--user", *options):
        return subprocess.run([sys.executable, str(self.installer), scope, "--update-from-main", *options],
                              cwd=self.checkout, env=self.env, capture_output=True, text=True, timeout=30)

    def test_uses_merged_hook_and_installer_preserving_other_settings(self):
        self.opt_in()
        before = self.settings.read_text()
        result = self.update()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.copy.read_text(), self.merged)
        settings = json.loads(self.settings.read_text())
        self.assertEqual(settings["permissions"], {"deny": ["Bash(example)"]})
        commands = [h["command"] for g in settings["hooks"]["PreToolUse"] for h in g["hooks"]]
        self.assertIn("other-hook", commands)
        self.assertEqual(pathlib.Path(str(self.settings) + ".bak").read_text(), before)
        times = self.copy.stat().st_mtime_ns, self.settings.stat().st_mtime_ns
        self.assertEqual(self.update().returncode, 0)
        self.assertEqual((self.copy.stat().st_mtime_ns, self.settings.stat().st_mtime_ns), times)

    def test_does_not_enable_an_absent_installation(self):
        self.assertEqual(self.update().returncode, 0)
        self.assertFalse(self.home.exists())

    def test_never_downgrades_a_newer_installation(self):
        self.opt_in(5)
        before = self.copy.read_bytes(), self.settings.read_bytes()
        self.assertEqual(self.update().returncode, 0)
        self.assertEqual((self.copy.read_bytes(), self.settings.read_bytes()), before)

    def test_updates_an_existing_unversioned_copy(self):
        self.opt_in(None)
        self.assertEqual(self.update().returncode, 0)
        self.assertEqual(self.copy.read_text(), self.merged)

    def test_missing_main_does_not_fall_back_to_feature_code(self):
        self.opt_in()
        before = self.copy.read_bytes(), self.settings.read_bytes()
        self.git("update-ref", "-d", "refs/remotes/origin/main")
        self.assertNotEqual(self.update().returncode, 0)
        self.assertEqual((self.copy.read_bytes(), self.settings.read_bytes()), before)

    def test_update_mode_requires_user_scope(self):
        self.assertEqual(self.update("--project-local").returncode, 2)
        self.assertFalse(self.home.exists())

    def test_wait_guard_updates_preserve_checkpoint_hook_registration(self):
        self.opt_in()
        settings = json.loads(self.settings.read_text())
        checkpoint = {"matcher": "", "hooks": [{"type": "command", "command":
            "python3 ~/.claude/hooks/kandelo-context-checkpoint.py"}]}
        settings["hooks"]["PreToolUse"].append(checkpoint)
        self.settings.write_text(json.dumps(settings))
        self.assertEqual(self.update().returncode, 0)
        self.assertIn(checkpoint, json.loads(self.settings.read_text())["hooks"]["PreToolUse"])

    def test_update_mode_rejects_checkpoint_profiles_without_writing_settings(self):
        self.opt_in()
        before = self.copy.read_bytes(), self.settings.read_bytes()
        for options in (("--hook", "context"), ("--hook", "context", "--client", "codex")):
            with self.subTest(options=options):
                result = self.update("--user", *options)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertEqual((self.copy.read_bytes(), self.settings.read_bytes()), before)


if __name__ == "__main__":
    unittest.main()
