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

The rest cover finding and waiting on another worktree's job (README tool
1b): `list --all`, the recorded commit and its relation to the caller's
HEAD, job records written before those fields existed, and `wait --peer`
refusing to guess.

Each test uses its own KANDELO_AGENT_JOBS_DIR, so it never touches the real
ledger or sees another session's jobs.

Run from the repo root: python3 evals/build-waiting/test_agent_job.py
"""
import importlib.machinery
import importlib.util
import json
import os
import pathlib
import signal
import subprocess
import sys
import tempfile
import time
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


class JobsDirCase(unittest.TestCase):
    """An isolated jobs directory and a runner for agent-job; no tests of its own."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="agent-job-test-")
        self.addCleanup(self.tmp.cleanup)
        self.jobs_dir = os.path.join(self.tmp.name, "jobs-state")
        # The job's working directory is deliberately not /tmp, so a script
        # that loses its `cd /tmp` prints something else.
        self.cwd = os.path.join(self.tmp.name, "work")
        os.makedirs(self.cwd)
        self.env = dict(os.environ, KANDELO_AGENT_JOBS_DIR=self.jobs_dir)

    def agent_job(self, *argv, check=True, cwd=None):
        r = subprocess.run([sys.executable, str(AGENT_JOB), *argv], cwd=cwd or self.cwd, env=self.env,
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


class AgentJobTest(JobsDirCase):
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


class PeerJobTest(JobsDirCase):
    """Jobs started in other worktrees: discovery, commits, and --peer."""

    def setUp(self):
        super().setUp()
        self.env.update(GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@example.com", GIT_COMMITTER_NAME="t",
                        GIT_COMMITTER_EMAIL="t@example.com", GIT_CONFIG_GLOBAL=os.devnull,
                        GIT_CONFIG_NOSYSTEM="1")
        # Two worktrees of one clone, like two Conductor workspaces: `main`
        # at commit A, `peer` one commit ahead (B, a descendant of A).
        # realpath: git reports macOS's /var/folders as /private/var/folders.
        root = os.path.realpath(self.tmp.name)
        self.main = os.path.join(root, "main")
        self.peer = os.path.join(root, "peer")
        os.makedirs(self.main)
        self.git(self.main, "init", "-q", "-b", "trunk")
        pathlib.Path(self.main, "f").write_text("a\n")
        self.git(self.main, "add", "f")
        self.git(self.main, "commit", "-q", "-m", "A")
        self.git(self.main, "worktree", "add", "-q", "-b", "peer", self.peer)
        pathlib.Path(self.peer, "f").write_text("b\n")
        self.git(self.peer, "commit", "-q", "-am", "B")

    def git(self, cwd, *argv):
        return subprocess.run(["git", *argv], cwd=cwd, env=self.env, check=True, capture_output=True,
                              text=True).stdout.strip()

    def start(self, cwd, command):
        return self.agent_job("start", "--", command, cwd=cwd).stdout.splitlines()[0]

    def meta(self, job_id):
        with open(os.path.join(self.jobs_dir, "jobs", job_id, "meta.json")) as f:
            return json.load(f)

    def start_running(self, cwd, command):
        """Start a job that runs until the test ends, and stop it at cleanup."""
        job_id = self.start(cwd, command)
        for _ in range(100):  # the supervisor PID is written just after start returns
            pid = self.meta(job_id).get("supervisor_pid")
            if pid:
                break
            time.sleep(0.05)
        self.addCleanup(self.stop, job_id)
        return job_id

    def stop(self, job_id):
        try:
            os.kill(self.meta(job_id)["supervisor_pid"], signal.SIGTERM)
        except OSError:
            pass
        self.agent_job("wait", job_id, "--timeout", "30", check=False)

    def row(self, out, job_id):
        lines = [l for l in out.splitlines() if l.startswith(job_id)]
        self.assertEqual(len(lines), 1, out)
        return lines[0]

    def write_old_job(self, job_id, meta, result=None):
        # A job directory as an older agent-job wrote it.
        d = os.path.join(self.jobs_dir, "jobs", job_id)
        os.makedirs(d)
        with open(os.path.join(d, "meta.json"), "w") as f:
            json.dump(meta, f)
        if result is not None:
            with open(os.path.join(d, "result.json"), "w") as f:
                json.dump(result, f)
        with open(os.path.join(d, "output.log"), "w") as f:
            f.write("old log\n")

    def test_start_records_head_and_uncommitted_paths(self):
        pathlib.Path(self.main, "f").write_text("edited\n")
        pathlib.Path(self.main, "untracked").write_text("x\n")  # not counted: every worktree has some
        meta = self.meta(self.start(self.main, "true"))
        self.assertEqual(meta["head"], self.git(self.main, "rev-parse", "HEAD"))
        self.assertIs(meta["dirty"], True)
        self.assertEqual(meta["dirty_paths"], ["f"])
        clean = self.meta(self.start(self.peer, "true"))
        self.assertEqual(clean["head"], self.git(self.peer, "rev-parse", "HEAD"))
        self.assertIs(clean["dirty"], False)

    def test_list_all_shows_every_worktree_with_state_and_commit_relation(self):
        done = self.start(self.peer, "exit 3")
        self.agent_job("wait", done, "--timeout", "30", check=False)
        running = self.start_running(self.main, "sleep 60")
        self.write_old_job("lost-0101-000000-0000", dict(
            id="lost-0101-000000-0000", cmd="./run.sh setup", cwd=self.peer, worktree=self.peer,
            started=time.time() - 60, supervisor_pid=2 ** 22 + 12345))  # no such process

        # The default stays scoped to the caller's worktree.
        scoped = self.agent_job("list", cwd=self.main).stdout
        self.assertIn(running, scoped)
        self.assertNotIn(done, scoped)

        out = self.agent_job("list", "--all", cwd=self.main).stdout
        a = self.git(self.main, "rev-parse", "HEAD")
        b = self.git(self.peer, "rev-parse", "HEAD")
        self.assertIn(f"your HEAD: {a[:9]}", out)
        row = self.row(out, done)
        self.assertIn("exit 3 in", row)
        self.assertIn(" peer ", row)
        self.assertIn(b[:9], row)
        self.assertIn("1 ahead", row)  # the peer built a descendant of main's HEAD
        row = self.row(out, running)
        self.assertIn("running", row)
        self.assertIn(" main ", row)
        self.assertIn("same", row)
        self.assertIn("LOST", self.row(out, "lost-0101-000000-0000"))

        # Seen from the peer, main's job built an ancestor.
        out = self.agent_job("list", "--all", cwd=self.peer).stdout
        self.assertIn("1 behind", self.row(out, running))
        status = self.agent_job("status", running, cwd=self.peer).stdout
        self.assertIn(f"worktree: {self.main} (not yours)", status)
        self.assertIn(f"commit: {a[:12]} (clean), an ancestor of your HEAD (1 commit behind it)", status)

    def test_diverged_and_unrelated_commits(self):
        # main moves on to C, so the peer's B and main's C share only A.
        pathlib.Path(self.main, "g").write_text("c\n")
        self.git(self.main, "add", "g")
        self.git(self.main, "commit", "-q", "-m", "C")
        peer_job = self.start(self.peer, "true")
        self.agent_job("wait", peer_job, "--timeout", "30")
        self.assertIn("diverged +1/-1", self.row(self.agent_job("list", "--all", cwd=self.main).stdout, peer_job))
        # A commit from another clone is not in this one's history.
        other = os.path.join(os.path.dirname(self.main), "other")
        os.makedirs(other)
        self.git(other, "init", "-q")
        self.git(other, "commit", "-q", "--allow-empty", "-m", "X")
        stranger = self.start(other, "true")
        self.agent_job("wait", stranger, "--timeout", "30")
        self.assertIn("unknown", self.row(self.agent_job("list", "--all", cwd=self.main).stdout, stranger))
        self.assertIn("not in this repository's history", self.agent_job("status", stranger, cwd=self.main).stdout)
        # A root commit in this clone that shares no history with main's HEAD.
        tree = self.git(self.main, "write-tree")
        orphan = self.git(self.main, "commit-tree", tree, "-m", "orphan")
        self.write_old_job("orphan-0101-000000-0003", dict(
            id="orphan-0101-000000-0003", cmd="true", cwd=self.main, worktree=self.main, head=orphan,
            dirty=False, started=time.time() - 60, supervisor_pid=2 ** 22 + 12345),
            dict(exit_code=0, signal=None, ended=time.time(), duration=1.0))
        self.assertIn("unrelated", self.row(self.agent_job("list", "--all", cwd=self.main).stdout,
                                            "orphan-0101-000000-0003"))
        self.assertIn("unrelated to your HEAD (no common history)",
                      self.agent_job("status", "orphan-0101-000000-0003", cwd=self.main).stdout)

    def test_jobs_recorded_before_the_commit_fields_still_list_and_wait(self):
        # The meta.json fields agent-job wrote before 2026-10-02.
        base = dict(cmd="./run.sh local-build", cwd=self.peer, worktree=self.peer, started=time.time() - 120,
                    key="./run.sh local-build", name="run.sh-local-build", usual_duration=None,
                    supervisor_pid=2 ** 22 + 12345, child_pid=2 ** 22 + 12346)
        self.write_old_job("old-0101-000000-0001", dict(base, id="old-0101-000000-0001"),
                           dict(exit_code=4, signal=None, ended=time.time() - 60, duration=60.0))
        # A development build of agent-job recorded `head` but no dirty flag.
        head = self.git(self.peer, "rev-parse", "HEAD")
        self.write_old_job("old-0101-000000-0002", dict(base, id="old-0101-000000-0002", head=head),
                           dict(exit_code=0, signal=None, ended=time.time() - 60, duration=60.0))

        out = self.agent_job("list", "--all", cwd=self.main).stdout
        row = self.row(out, "old-0101-000000-0001")
        self.assertIn("exit 4 in 1m00s", row)
        self.assertRegex(row, r"\s-\s+-\s")  # commit and relation: not recorded
        self.assertIn(f"{head[:9]}?", self.row(out, "old-0101-000000-0002"))
        self.assertIn("1 ahead", self.row(out, "old-0101-000000-0002"))

        waited = self.agent_job("wait", "old-0101-000000-0001", cwd=self.main, check=False)
        self.assertEqual(waited.returncode, 4)
        self.assertIn("commit: not recorded", waited.stdout)
        status = self.agent_job("status", "old-0101-000000-0002", cwd=self.main).stdout
        self.assertIn("uncommitted changes not recorded", status)

    def test_wait_peer_refuses_to_guess(self):
        marker = "peer-marker-7f3a"
        first = self.start_running(self.peer, f"sleep 60; : {marker}")
        second = self.start_running(self.main, f"sleep 60; : {marker}")
        r = self.agent_job("wait", "--peer", marker, "--timeout", "5", cwd=self.main, check=False)
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertIn("matches 2 running jobs", r.stderr)
        self.assertIn(first, r.stderr)
        self.assertIn(second, r.stderr)
        self.assertNotIn("waiting on", r.stdout)

        r = self.agent_job("wait", "--peer", "no-such-command-text", cwd=self.main, check=False)
        self.assertEqual(r.returncode, 2)
        self.assertIn("no running job's command contains it", r.stderr)

        # A finished job never matches: only running jobs are candidates.
        self.stop(second)
        r = self.agent_job("wait", "--peer", marker, "--timeout", "2", cwd=self.main, check=False)
        self.assertEqual(r.returncode, 124, r.stdout + r.stderr)  # the one match is still running
        self.assertIn(f"waiting on {first} in {self.peer}", r.stdout)

    def test_wait_peer_waits_on_the_single_match_and_returns_its_status(self):
        job_id = self.start_running(self.peer, "sleep 2; exit 5")
        r = self.agent_job("wait", "--peer", "exit 5", "--timeout", "30", cwd=self.main, check=False)
        self.assertEqual(r.returncode, 5, r.stdout + r.stderr)
        self.assertIn(f"waiting on {job_id}", r.stdout)
        self.assertIn("a descendant of your HEAD (1 commit ahead of it)", r.stdout)
        self.assertIn(f"{job_id}: FAILED (exit 5)", r.stdout)

    def test_wait_timeout_exits_124_without_ps_on_path(self):
        # scripts/dev-shell.sh's PATH has no `ps`. A timed-out wait prints
        # status, which lists processes; it must still exit 124.
        job_id = self.start_running(self.main, "sleep 60")
        bare = os.path.join(self.tmp.name, "bare-bin")
        os.makedirs(bare)
        os.symlink(subprocess.run(["sh", "-c", "command -v git"], capture_output=True, text=True).stdout.strip(),
                   os.path.join(bare, "git"))
        self.env["PATH"] = bare
        r = self.agent_job("wait", job_id, "--timeout", "1", cwd=self.main, check=False)
        self.assertEqual(r.returncode, 124, r.stdout + r.stderr)
        self.assertIn(f"{job_id}: running", r.stdout)
        self.assertEqual(self.agent_job("status", job_id, cwd=self.main, check=False).returncode, 0)

    def test_wait_needs_exactly_one_of_id_and_peer(self):
        self.assertEqual(self.agent_job("wait", check=False).returncode, 2)
        self.assertEqual(self.agent_job("wait", "x-0101-000000-0000", "--peer", "x", check=False).returncode, 2)


if __name__ == "__main__":
    unittest.main()
