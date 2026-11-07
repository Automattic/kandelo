#!/usr/bin/env python3
"""Tests for .claude/hooks/wait-guard.py: staying current, and versioned logs.

Why they exist: the hook is installed as a copy in ~/.claude/hooks, so an
update merged to main reaches nobody until they re-run the installer. On
2026-10-02 that mattered. The installed copy still told agents to wait on
another workspace's build with `while kill -0 <pid>`, after #1464 had changed
the advice to `agent-job list --all`. The hook now says when the checkout
has a newer version (HOOK_VERSION), once per session, and logs its version
with every decision so the keep rules can tell which advice was in force.

Each test runs the hook the way Claude Code does, as a process reading a
JSON payload on stdin, from a fake checkout with its own jobs directory.

Run from the repo root: python3 evals/build-waiting/test_wait_guard.py
"""
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import unittest

REPO = pathlib.Path(__file__).resolve().parents[2]
HOOK = REPO / ".claude" / "hooks" / "wait-guard.py"
VERSION = int(re.search(r"^HOOK_VERSION = (\d+)$", HOOK.read_text(), re.M).group(1))
PGREP_LOOP = 'until ! pgrep -f "run.sh setup"; do sleep 10; done'


class WaitGuardTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix="wait-guard-test-")
        self.addCleanup(tmp.cleanup)
        self.state = os.path.join(tmp.name, "state")
        # A checkout as the hook sees one: scripts/agent-job marks it.
        self.checkout = os.path.join(tmp.name, "checkout")
        os.makedirs(os.path.join(self.checkout, "scripts"))
        os.makedirs(os.path.join(self.checkout, ".claude", "hooks"))
        pathlib.Path(self.checkout, "scripts", "agent-job").write_text("")

    def checkout_hook(self, text):
        pathlib.Path(self.checkout, ".claude", "hooks", "wait-guard.py").write_text(text)

    def run_hook(self, command="ls", session="s1", cwd=None, agent_id=None):
        payload = dict(tool_name="Bash", session_id=session, cwd=cwd or self.checkout,
                       agent_id=agent_id,
                       tool_input=dict(command=command))
        r = subprocess.run([sys.executable, str(HOOK)], input=json.dumps(payload), capture_output=True, text=True,
                           env=dict(os.environ, KANDELO_AGENT_JOBS_DIR=self.state), timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout) if r.stdout.strip() else {}

    def test_newer_checkout_version_gives_one_notice_per_session(self):
        self.checkout_hook(f"HOOK_VERSION = {VERSION + 1}\n")
        out = self.run_hook()
        self.assertIn(f"installed v{VERSION}, this checkout has v{VERSION + 1}", out["systemMessage"])
        self.assertIn("install-hooks.py --user", out["systemMessage"])
        # A notice must not approve or deny: the call goes through the normal flow.
        self.assertNotIn("hookSpecificOutput", out)
        self.assertEqual(self.run_hook(), {})  # same session: said once
        self.assertIn("systemMessage", self.run_hook(session="s2"))

    def test_same_older_or_missing_version_is_silent(self):
        # An older branch's hook is not a reason to reinstall; neither is a
        # checkout from before HOOK_VERSION existed.
        for text in (f"HOOK_VERSION = {VERSION}\n", f"HOOK_VERSION = {VERSION - 1}\n", "# no version line\n"):
            with self.subTest(text=text):
                self.checkout_hook(text)
                self.assertEqual(self.run_hook(session=text), {})
        os.remove(os.path.join(self.checkout, ".claude", "hooks", "wait-guard.py"))
        self.assertEqual(self.run_hook(session="no-file"), {})

    def test_notice_rides_along_with_a_denial(self):
        self.checkout_hook(f"HOOK_VERSION = {VERSION + 1}\n")
        out = self.run_hook(PGREP_LOOP)
        self.assertEqual(out["hookSpecificOutput"]["permissionDecision"], "deny")
        self.assertIn("systemMessage", out)
        out = self.run_hook(PGREP_LOOP)  # notice already given; the denial stays
        self.assertEqual(out["hookSpecificOutput"]["permissionDecision"], "deny")
        self.assertNotIn("systemMessage", out)

    def test_outside_an_agent_job_checkout_does_nothing(self):
        self.checkout_hook(f"HOOK_VERSION = {VERSION + 1}\n")
        os.remove(os.path.join(self.checkout, "scripts", "agent-job"))
        self.assertEqual(self.run_hook(PGREP_LOOP), {})

    def test_log_entries_record_the_hook_version(self):
        self.run_hook(PGREP_LOOP)
        with open(os.path.join(self.state, "hook-log.jsonl")) as f:
            entry = json.loads(f.readline())
        self.assertEqual(entry["version"], VERSION)
        self.assertEqual(entry["rule"], "pgrep-waiter")

    def test_repo_hook_version_line_is_what_installed_copies_parse(self):
        # Installed copies find the checkout's version with this exact
        # pattern. Reformatting the line would silence every stale notice.
        self.assertGreaterEqual(VERSION, 3)
        self.assertEqual(len(re.findall(r"^HOOK_VERSION = \d+$", HOOK.read_text(), re.M)), 1)

    def test_subagent_wait_windows_and_main_session_controls(self):
        unsafe = [
            "scripts/agent-job wait job", "scripts/agent-job wait --peer build",
            "scripts/agent-job wait job --timeout 0", "scripts/agent-job wait job --timeout 271",
            "scripts/agent-job wait job --timeout=540", "scripts/agent-job wait job --timeout $WINDOW",
            "bash -lc 'scripts/agent-job wait --peer build --timeout 540'",
            "scripts/dev-shell.sh python3 scripts/agent-job wait job --timeout 540",
            "scripts/agent-job wait a --timeout 240; scripts/agent-job wait b --timeout 240",
            "while true; do scripts/agent-job wait job --timeout 240; done",
            "until scripts/agent-job wait job --timeout 240; do true; done",
        ]
        for command in unsafe:
            with self.subTest(command=command):
                out = self.run_hook(command, agent_id="worker")
                reason = out["hookSpecificOutput"]["permissionDecisionReason"]
                self.assertIn("--timeout 240", reason)
                self.assertIn("parent", reason)
                self.assertIn("FAILED (exit 124)", reason)
                self.assertEqual(self.run_hook(command), {})
        entries = [json.loads(l) for l in pathlib.Path(self.state, "hook-log.jsonl").read_text().splitlines()]
        self.assertTrue(all(e["rule"] == "subagent-wait-window" and e["agent_id"] == "worker" for e in entries))

    def test_subagent_short_waits_and_mentions_pass(self):
        safe = [
            "scripts/agent-job wait job --timeout 240", "scripts/agent-job wait job --timeout=270",
            "python3 scripts/agent-job wait --peer build --timeout 120",
            "scripts/agent-job wait a --timeout 120 && scripts/agent-job wait b --timeout 120",
            "scripts/agent-job wait --help", "scripts/agent-job status job",
            "rg 'scripts/agent-job wait job' README.md", "echo 'scripts/agent-job wait job --timeout 0'",
            "cat <<'EOF'\nscripts/agent-job wait job\nEOF",
            "scripts/agent-job wait job --timeout 0 # agent-job: allow-wait",
            "scripts/agent-job wait job --timeout 240; for f in one two; do echo $f; done",
            "for f in one two; do echo $f; done; scripts/agent-job wait job --timeout 240",
        ]
        for command in safe:
            with self.subTest(command=command):
                self.assertEqual(self.run_hook(command, agent_id="worker"), {})

    def test_existing_whole_tree_rule_still_returns_work_to_parent(self):
        for command in ("./run.sh setup", "npx vitest run"):
            out = self.run_hook(command, agent_id="worker")
            self.assertIn("report back to your parent", out["hookSpecificOutput"]["permissionDecisionReason"])
            self.assertEqual(self.run_hook(command), {})


if __name__ == "__main__":
    unittest.main()
