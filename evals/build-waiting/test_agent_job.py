#!/usr/bin/env python3
"""Regression tests for scripts/agent-job.

Why they exist: on 2026-10-01 a 45-file vitest run started as
`agent-job start -- scripts/dev-shell.sh bash -c 'cd host && npx vitest …'`
produced only invalid results. agent-job joined the words with plain spaces,
which dropped their quoting, so the inner `bash -c` received only `cd`. The
`&& npx vitest …` part then ran outside the dev shell, from the repo root.
Nothing failed loudly: the run used the wrong vitest config and toolchain and
reported misleading link errors and timeouts. These tests pin down that a
job runs the command the caller wrote, in both documented forms, and that
the fix keeps job names and timing history stable for common commands.

Each test uses its own KANDELO_AGENT_JOBS_DIR, so it never touches the real
ledger or sees another session's jobs.

Run from the repo root: python3 evals/build-waiting/test_agent_job.py
"""
import importlib.machinery
import importlib.util
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

REPO = pathlib.Path(__file__).resolve().parents[2]
AGENT_JOB = REPO / "scripts" / "agent-job"


def load_agent_job():
    # agent-job has no .py suffix, so name the loader explicitly.
    loader = importlib.machinery.SourceFileLoader("agent_job", str(AGENT_JOB))
    spec = importlib.util.spec_from_loader("agent_job", loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


class AgentJobTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="agent-job-test-")
        self.addCleanup(self.tmp.cleanup)
        self.jobs_dir = os.path.join(self.tmp.name, "jobs-state")
        # The job's working directory is deliberately not /tmp, so a script
        # that loses its `cd /tmp` prints something else.
        self.cwd = os.path.join(self.tmp.name, "work")
        os.makedirs(self.cwd)
        self.env = dict(os.environ, KANDELO_AGENT_JOBS_DIR=self.jobs_dir)

    def agent_job(self, *argv, check=True):
        r = subprocess.run([sys.executable, str(AGENT_JOB), *argv], cwd=self.cwd, env=self.env,
                           capture_output=True, text=True, timeout=60)
        if check and r.returncode != 0:
            self.fail(f"agent-job {' '.join(argv)} exited {r.returncode}:\n{r.stdout}{r.stderr}")
        return r

    def run_job(self, *command):
        """Start a job, wait for it, and return (exit status, log text)."""
        job_id = self.agent_job("start", "--", *command).stdout.splitlines()[0]
        waited = self.agent_job("wait", job_id, "--timeout", "30", check=False)
        self.assertNotEqual(waited.returncode, 124, f"job did not finish:\n{waited.stdout}")
        with open(os.path.join(self.jobs_dir, "jobs", job_id, "output.log")) as f:
            return waited.returncode, f.read()

    def test_multi_word_command_keeps_inner_bash_c_script_whole(self):
        # The 2026-10-01 shape: a wrapper, then `bash -c` with a script that
        # has spaces and `&&`. The whole script must run in the inner shell.
        code, log = self.run_job("bash", "-c", "cd /tmp && pwd")
        self.assertEqual(code, 0)
        self.assertEqual(log, "/tmp\n")

    def test_multi_word_command_passes_each_argument_verbatim(self):
        # Spaces, `$`, `&&`, and quotes inside one argument reach the
        # program as that one argument, unexpanded.
        args = ["a b", "$HOME", "&&", "it's", ""]
        code, log = self.run_job("printf", "[%s]\\n", *args)
        self.assertEqual(code, 0)
        self.assertEqual(log, "".join(f"[{a}]\n" for a in args))

    def test_single_argument_is_still_a_shell_string(self):
        # The documented one-string form: the shell interprets it.
        code, log = self.run_job("echo one && echo two")
        self.assertEqual(code, 0)
        self.assertEqual(log, "one\ntwo\n")

    def test_exit_status_comes_from_the_inner_script(self):
        # Split on spaces, `exit` would get `7` as its $0 and exit 0, and the
        # outer shell would run `true`: a failure reported as success.
        code, _ = self.run_job("bash", "-c", "exit 7; true")
        self.assertEqual(code, 7)

    def test_job_key_unchanged_for_common_commands(self):
        # Timing history ("usually takes 18m") is keyed by job_key. The same
        # run started as several words or as one string must share a key,
        # and the key must be what earlier ledger entries recorded.
        aj = load_agent_job()
        cases = [
            (["./run.sh", "setup"], "./run.sh setup", "./run.sh setup"),
            (["./run.sh", "local-build"], "./run.sh local-build", "./run.sh local-build"),
            (["scripts/ci-run-test-suite.sh", "vitest"], "scripts/ci-run-test-suite.sh vitest",
             "scripts/ci-run-test-suite.sh vitest"),
            (["scripts/dev-shell.sh", "bash", "-c", "cd host && npx vitest run test/foo.test.ts"],
             "scripts/dev-shell.sh bash -c 'cd host && npx vitest run test/foo.test.ts'", "npx vitest run"),
        ]
        for argv, one_string, key in cases:
            with self.subTest(argv=argv):
                self.assertEqual(aj.job_key(aj.shell_command(argv)), key)
                self.assertEqual(aj.job_key(aj.shell_command([one_string])), key)

    def test_locked_detection_sees_quoted_vitest(self):
        aj = load_agent_job()
        cmd = aj.shell_command(["scripts/dev-shell.sh", "bash", "-c", "cd host && npx vitest run"])
        self.assertTrue(aj.LOCKED.search(cmd))
        self.assertTrue(aj.LOCKED.search(aj.shell_command(["./run.sh", "setup"])))


if __name__ == "__main__":
    unittest.main()
