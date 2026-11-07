#!/usr/bin/env python3
"""Accounting regressions: final-segment usage must not hide background work."""
import unittest
import pathlib
import re
import tempfile
from unittest import mock

from run import input_equivalent, session_usage
from subagent_wait import collect


class AccountingTest(unittest.TestCase):
    def test_session_totals_include_all_models_and_segments(self):
        events = [
            {"type": "result", "num_turns": 4, "usage": {"input_tokens": 500}},
            {"type": "assistant"},
            {"type": "result", "num_turns": 2, "usage": {"input_tokens": 5}, "modelUsage": {
                "main": {"inputTokens": 20, "cacheReadInputTokens": 100, "cacheCreationInputTokens": 40,
                         "outputTokens": 3},
                "worker": {"inputTokens": 10, "cacheReadInputTokens": 200, "cacheCreationInputTokens": 60,
                           "outputTokens": 7}}},
        ]
        usage, turns = session_usage(events)
        self.assertEqual(turns, 6)
        self.assertEqual(usage, dict(input_tokens=30, cache_read_input_tokens=300,
                                     cache_creation_input_tokens=100, output_tokens=10))
        self.assertEqual(input_equivalent(usage), 310)

    def test_empty_and_legacy_results(self):
        self.assertEqual(session_usage([]), ({}, 0))
        self.assertEqual(session_usage([{"type": "result", "num_turns": 3,
                                         "usage": {"input_tokens": 15}}]), ({"input_tokens": 15}, 3))

    def test_transcripts_survive_a_symlinked_sandbox_path(self):
        # On macOS /tmp resolves to /private/tmp; Claude stores the resolved
        # path, while tempfile can return the alias. Missing this loses the
        # only per-wake usage evidence after the sandbox is removed.
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            box = root / "real"
            box.mkdir()
            alias = root / "alias"
            alias.symlink_to(box, target_is_directory=True)
            home, out = root / "home", root / "out"
            out.mkdir()
            project = re.sub(r"[^a-zA-Z0-9]", "-", str(box.resolve()))
            source = home / ".claude/projects" / project / "session/subagents"
            source.mkdir(parents=True)
            (source / "worker.jsonl").write_text('{"usage": "evidence"}\n')
            result = box / ".agent-jobs/jobs/job/result.json"
            result.parent.mkdir(parents=True)
            result.write_text('{"exit_code": 3}')
            with mock.patch.object(pathlib.Path, "home", return_value=home):
                record = collect(alias, out, "probe", "session", "job")
            self.assertEqual(record["fixture_result"], {"exit_code": 3})
            self.assertEqual((out / "probe.evidence/subagents/worker.jsonl").read_text(),
                             '{"usage": "evidence"}\n')


if __name__ == "__main__":
    unittest.main()
