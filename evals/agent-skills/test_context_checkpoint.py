#!/usr/bin/env python3
"""Offline regression tests: correct agent attribution and durable handoffs."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
from concurrent.futures import ThreadPoolExecutor

REPO = Path(__file__).resolve().parents[2]
HOOK = REPO / ".claude/hooks/context-checkpoint.py"
INSTALLER = REPO / ".claude/hooks/install-hooks.py"


def module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


checkpoint = module(HOOK, "checkpoint")
installer = module(INSTALLER, "installer")


def assistant(tokens, mid="m1"):
    return dict(type="assistant", message=dict(id=mid, usage=dict(
        input_tokens=2, cache_read_input_tokens=tokens - 12,
        cache_creation_input_tokens=10, output_tokens=50)))


def codex_usage(tokens, cached=0, total=99_000_000):
    return dict(type="event_msg", payload=dict(type="token_count", info=dict(
        total_token_usage=dict(input_tokens=total), last_token_usage=dict(
            input_tokens=tokens, cached_input_tokens=cached, output_tokens=100))))


NOTE = "\n\n".join("## " + title + "\n" + body for title, body in zip(checkpoint.SECTIONS, (
    "Fix fixture; acceptance is the focused check.",
    "Preserve EIO on failed writes; silent success was rejected.",
    "tracked.txt changed; no untracked source files.",
    "Focused check not run; no runtime validation claimed.",
    "None. Coordinator owns any later broad suite.",
    "Original failure remains unverified.",
    "Run the focused check against the final tree.",
)))


class ContextCheckpointTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="context-checkpoint-")
        self.addCleanup(directory.cleanup)
        self.base = Path(directory.name)
        self.root = self.base / "checkout with spaces"
        (self.root / "scripts").mkdir(parents=True)
        (self.root / "scripts/agent-job").touch()
        self.transcript = self.base / "session.jsonl"
        self.transcript.write_text(json.dumps(assistant(300_000)) + "\n")
        self.state = self.base / "cache"
        self.payload = dict(hook_event_name="PreToolUse", session_id="session",
                            cwd=str(self.root), transcript_path=str(self.transcript),
                            tool_name="Read", tool_input={})
        self.env = dict(os.environ, KANDELO_CONTEXT_CACHE_DIR=str(self.state),
                        GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1")

    def hook(self, payload=None, client="claude"):
        command = [sys.executable, "-B", str(HOOK)]
        if client == "codex":
            command.append("hook-codex")
        result = subprocess.run(command,
                                input=json.dumps(payload or self.payload), text=True,
                                capture_output=True, env=self.env, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout) if result.stdout else {}

    def codex_transcript(self, path=None, session="session", rows=None):
        path = path or self.transcript
        path.write_text("\n".join(map(json.dumps, [
            dict(type="session_meta", payload=dict(id=session)),
            *(rows if rows is not None else [codex_usage(260_000, 250_000)]),
        ])) + "\n")

    def test_codex_input_includes_cache_and_does_not_use_session_totals(self):
        self.codex_transcript(rows=[codex_usage(40_000, 35_000)])
        self.assertEqual(self.hook(client="codex"), {})
        self.codex_transcript()
        output = self.hook(client="codex")
        self.assertIn("260,000", output["hookSpecificOutput"]["additionalContext"])
        self.assertEqual(set(output["hookSpecificOutput"]), {"hookEventName", "additionalContext"})
        self.assertEqual(self.hook(client="codex"), {})

    def test_codex_compaction_and_null_rate_limit_events(self):
        self.codex_transcript(rows=[codex_usage(900_000), dict(type="compacted", payload={}),
            codex_usage(40_000), dict(type="event_msg", payload=dict(type="token_count", info=None))])
        self.assertEqual(self.hook(client="codex"), {})

    def test_codex_child_rollout_is_separate_and_parent_mismatch_is_silent(self):
        self.codex_transcript()
        child = self.base / "rollout-child.jsonl"
        self.codex_transcript(child, "child", [codex_usage(40_000)])
        payload = dict(self.payload, session_id="child", transcript_path=str(child))
        self.assertEqual(self.hook(payload, client="codex"), {})
        self.assertEqual(self.hook(dict(payload, transcript_path=str(self.transcript)), client="codex"), {})
        self.codex_transcript(child, "child")
        self.assertTrue(self.hook(payload, client="codex"))
        self.assertTrue(self.hook(client="codex"))

    def test_codex_unknown_rollout_header_fails_open(self):
        self.transcript.write_text(json.dumps(codex_usage(260_000)) + "\n")
        self.assertEqual(self.hook(client="codex"), {})

    def test_codex_parallel_tools_deliver_once(self):
        self.codex_transcript()
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: self.hook(client="codex"), range(4)))
        self.assertEqual(sum(bool(result) for result in results), 1)

    def test_reminds_model_once_without_tool_decision_or_user_message(self):
        result = self.hook()
        self.assertEqual(set(result), {"hookSpecificOutput"})
        output = result["hookSpecificOutput"]
        self.assertEqual(set(output), {"hookEventName", "additionalContext"})
        self.assertIn("300,000", output["additionalContext"])
        self.assertIn("next completed milestone", output["additionalContext"])
        self.assertEqual(self.hook(), {})

    def test_small_child_never_inherits_large_parent_usage(self):
        child = self.base / "session/subagents/agent-child.jsonl"
        child.parent.mkdir(parents=True)
        child.write_text(json.dumps(assistant(40_000)) + "\n")
        payload = dict(self.payload, agent_id="child")
        self.assertEqual(self.hook(payload), {})
        child.write_text(json.dumps(assistant(260_000)) + "\n")
        self.assertIn("260,000", self.hook(payload)["hookSpecificOutput"]["additionalContext"])
        self.assertTrue(self.hook())  # independent main-stream marker

    def test_moving_same_agent_between_worktrees_does_not_repeat_reminder(self):
        self.assertTrue(self.hook())
        peer = self.base / "peer"
        (peer / "scripts").mkdir(parents=True)
        (peer / "scripts/agent-job").touch()
        self.assertEqual(self.hook(dict(self.payload, cwd=str(peer))), {})

    def test_missing_child_transcript_is_silent(self):
        self.assertEqual(self.hook(dict(self.payload, agent_id="missing")), {})

    def test_prefixed_agent_id_and_direct_child_path(self):
        child = self.base / "session/subagents/agent-child.jsonl"
        child.parent.mkdir(parents=True)
        child.write_text(json.dumps(assistant(260_000)) + "\n")
        result = self.hook(dict(self.payload, agent_id="agent-child", transcript_path=str(child)))
        self.assertIn("260,000", result["hookSpecificOutput"]["additionalContext"])

    def test_latest_usage_wins_over_older_large_context_and_duplicate_blocks(self):
        self.transcript.write_text("\n".join(map(json.dumps, [assistant(900_000),
            assistant(40_000, "m2"), assistant(40_000, "m2")])) + "\n")
        self.assertEqual(self.hook(), {})

    def test_partial_tail_large_output_and_zero_usage_are_tolerated(self):
        self.transcript.write_text(json.dumps(dict(type="user", message="x" * 600_000)) + "\n" +
                                   json.dumps(assistant(300_000)) + "\n" +
                                   json.dumps(dict(type="assistant", message=dict(usage={}))) + "\n{partial")
        self.assertTrue(self.hook())

    def test_parallel_calls_deliver_one_reminder(self):
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: self.hook(), range(4)))
        self.assertEqual(sum(bool(result) for result in results), 1)

    def test_outside_checkout_invalid_json_and_missing_usage_fail_open(self):
        self.assertEqual(self.hook(dict(self.payload, cwd=str(self.base))), {})
        self.transcript.write_text("not JSON\n")
        self.assertEqual(self.hook(), {})
        result = subprocess.run([sys.executable, "-B", str(HOOK)], input="not JSON",
                                text=True, capture_output=True, env=self.env, timeout=10)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "", ""))

    def setup_git(self):
        def git(*args):
            return subprocess.run(["git", "-C", str(self.root), "-c", "user.name=Fixture",
                                   "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false",
                                   "-c", "core.hooksPath=/dev/null", *args], check=True,
                                  env=self.env, capture_output=True)
        git("init", "-q")
        (self.root / ".gitignore").write_text(".context/\n")
        (self.root / "tracked.txt").write_text("before\n")
        git("add", ".")
        git("commit", "-qm", "Fixture: Initial state")
        return git

    def test_saved_notes_are_immutable_and_check_does_not_invent_test_success(self):
        self.setup_git()
        first = checkpoint.save(self.root, "phase", NOTE)
        original = first.read_bytes()
        second = checkpoint.save(self.root, "phase", NOTE)
        self.assertNotEqual(first, second)
        self.assertEqual(first.read_bytes(), original)
        checkpoint.check(self.root, first)
        self.assertIn("not run", first.read_text())

    def test_same_head_with_changed_tracked_content_is_stale(self):
        self.setup_git()
        note = checkpoint.save(self.root, "phase", NOTE)
        (self.root / "tracked.txt").write_text("changed\n")
        with self.assertRaisesRegex(ValueError, "stale.*tracked_diff_sha256"):
            checkpoint.check(self.root, note)

    def test_missing_or_placeholder_decisions_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "Decisions"):
            checkpoint.validate_note(NOTE.replace("Preserve EIO on failed writes; silent success was rejected.", "TODO"))
        with self.assertRaisesRegex(ValueError, "Next step"):
            checkpoint.validate_note(NOTE.split("## Next step")[0])
        with self.assertRaisesRegex(ValueError, "duplicate"):
            checkpoint.validate_note(NOTE + "\n## Next step\nAnother step")

    def test_cli_and_wrapper_record_then_check_without_printing_full_note(self):
        self.setup_git()
        result = subprocess.run([sys.executable, "-B", str(REPO / "scripts/agent-checkpoint"),
                                 "save", "phase"], input=NOTE, text=True, cwd=self.root,
                                capture_output=True, env=self.env, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        path = Path(result.stdout.strip())
        self.assertTrue(path.is_file())
        result = subprocess.run([sys.executable, "-B", str(HOOK), "check", str(path)],
                                cwd=self.root, text=True, capture_output=True, env=self.env, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("verify decisions", result.stdout)
        self.assertNotIn("Preserve EIO", result.stdout)

    def test_invalid_names_and_oversize_notes_are_not_written(self):
        for name, note in (("../escape", NOTE), ("phase", NOTE + "x" * checkpoint.NOTE_BYTES)):
            with self.assertRaises(ValueError):
                checkpoint.save(self.root, name, note)
        self.assertFalse((self.root / ".context").exists())

    def test_installer_preserves_other_hooks_and_context_install_is_idempotent(self):
        settings = self.base / "user/.claude/settings.json"
        settings.parent.mkdir(parents=True)
        original = dict(permissions=dict(allow=["Read"]), hooks={
            "PreToolUse": [dict(matcher="Bash", hooks=[
                dict(type="command", command="other-hook"),
                dict(type="command", command="python3 ~/.claude/hooks/kandelo-wait-guard.py")])],
            "Stop": [dict(hooks=[dict(type="command", command="stop-hook")])]})
        settings.write_text(json.dumps(original))
        real_expanduser = installer.os.path.expanduser

        def expand(path):
            return str(self.base / "user" / path[2:]) if path.startswith("~/") else real_expanduser(path)

        def install(*args):
            with mock.patch.object(sys, "argv", [str(INSTALLER), "--user", "--hook", "context", *args]), \
                    mock.patch.object(installer.os.path, "expanduser", side_effect=expand), \
                    contextlib.redirect_stdout(io.StringIO()):
                return installer.main()

        self.assertEqual(install(), 0)
        installed = settings.read_bytes()
        backup = settings.with_suffix(".json.bak").read_bytes()
        self.assertEqual(install(), 0)
        self.assertEqual(install("--check"), 0)
        self.assertEqual(settings.read_bytes(), installed)
        self.assertEqual(settings.with_suffix(".json.bak").read_bytes(), backup)
        current = json.loads(installed)
        self.assertEqual(current["hooks"]["Stop"], original["hooks"]["Stop"])
        self.assertEqual(current["hooks"]["PreToolUse"][0], original["hooks"]["PreToolUse"][0])
        copy = settings.parent / "hooks/kandelo-context-checkpoint.py"
        self.assertEqual(copy.read_bytes(), HOOK.read_bytes())
        self.assertEqual(install("--uninstall"), 0)
        self.assertEqual(json.loads(settings.read_text()), original)
        self.assertFalse(copy.exists())

    def test_codex_installer_preserves_inline_config_and_trust_records(self):
        import tomllib
        config = self.base / "user/.codex/config.toml"
        config.parent.mkdir(parents=True)
        original = ('# User preferences stay intact\nmodel = "fixture-model"\n'
                    '[hooks.state."existing"]\ntrusted = true\n'
                    '[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "existing-hook"\n')
        config.write_text(original)
        real_expanduser = installer.os.path.expanduser

        def expand(path):
            return str(self.base / "user" / path[2:]) if path.startswith("~/") else real_expanduser(path)

        def install(*args):
            with mock.patch.object(sys, "argv", [str(INSTALLER), "--user", "--hook", "context", "--client", "codex", *args]), \
                    mock.patch.object(installer.os.path, "expanduser", side_effect=expand), \
                    contextlib.redirect_stdout(io.StringIO()):
                return installer.main()

        self.assertEqual(install(), 0)
        installed = config.read_bytes()
        parsed = tomllib.loads(installed.decode())
        parsed["hooks"].pop("PreToolUse")
        self.assertEqual(parsed, tomllib.loads(original))
        self.assertTrue(installed.decode().startswith(original))
        self.assertFalse((config.parent / "hooks.json").exists())
        self.assertEqual(install(), 0)
        self.assertEqual(install("--check"), 0)
        self.assertEqual(config.read_bytes(), installed)
        self.assertEqual(config.with_suffix(".toml.bak").read_text(), original)
        self.assertEqual(install("--uninstall"), 0)
        self.assertEqual(config.read_text(), original)

    def test_codex_existing_json_is_preserved_instead_of_adding_toml_hooks(self):
        directory = self.base / "user/.codex"
        directory.mkdir(parents=True)
        path = directory / "hooks.json"
        original = {"description": "User hooks", "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "existing"}]}]}}
        path.write_text(json.dumps(original))
        real_expanduser = installer.os.path.expanduser

        def expand(value):
            return str(self.base / "user" / value[2:]) if value.startswith("~/") else real_expanduser(value)

        for mode in ([], ["--uninstall"]):
            with mock.patch.object(sys, "argv", [str(INSTALLER), "--user", "--hook", "context", "--client", "codex", *mode]), \
                    mock.patch.object(installer.os.path, "expanduser", side_effect=expand), \
                    contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(installer.main(), 0)
            current = json.loads(path.read_text())
            self.assertEqual(installer.without_ours(current, "context-checkpoint.py"), original)
        self.assertEqual(current, original)
        self.assertFalse((directory / "config.toml").exists())


if __name__ == "__main__":
    unittest.main()
