#!/usr/bin/env python3
"""A/B test: do the build-waiting tools change how an agent waits?

Why it exists: transcript evidence needs weeks of real use. This gives a
controlled answer in minutes. It already caught guidance that made headless
sessions end before reporting a result.

Each task asks a headless `claude -p` session to run a fake long build
(fixtures/fake-build.sh, 2-3 minutes) and report how it ended. Two arms:

  tools-on   the current CLAUDE.md and docs/agent-guidance/validation.md,
             scripts/agent-job, and .claude/hooks/wait-guard.py wired in;
  tools-off  CLAUDE.md and validation.md as they were before the tools
             (commit BEFORE below), with no agent-job and no hook.

Each run happens in a fresh sandbox directory holding only those files and
the fixture, so the arms differ in exactly the tooling. Scored on
correctness first (the reported exit status and error line), then on cost,
turns, and how many tool calls were spent waiting.

Usage (from the repo root):
  python3 evals/build-waiting/run.py [--reps 3] [--model sonnet] [--tasks id,id] [--jobs 4]

Cost: each run is a few cents on Sonnet but takes 2-4 minutes of wall time.
"""
import argparse
import concurrent.futures
import json
import os
import pathlib
import re
import shutil
import statistics
import subprocess
import tempfile
import time

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[1]
BEFORE = "938b7ae3e"  # the declaration commit, before any tool existed
TASKS = [
    {
        "id": "wait-and-report",
        "env": {"FAKE_BUILD_SECONDS": "150"},
        "prompt": ("Run `bash evals/build-waiting/fixtures/fake-build.sh`. It is a build that takes about "
                   "2.5 minutes. When it has finished, report its exit status and the first error line it "
                   "printed. Do not edit any files."),
        "checks": {"exit status 3": r"\b3\b", "error line": r"frob_widget"},
    },
    {
        "id": "long-build",
        "env": {"FAKE_BUILD_SECONDS": "720"},
        "prompt": ("Run `bash evals/build-waiting/fixtures/fake-build.sh`. It is a build that takes about "
                   "12 minutes. When it has finished, report its exit status and the first error line it "
                   "printed. Do not edit any files."),
        "checks": {"exit status 3": r"\b3\b", "error line": r"frob_widget"},
    },
    {
        "id": "quiet-build",
        "env": {"FAKE_BUILD_SECONDS": "150", "FAKE_BUILD_QUIET": "1"},
        "prompt": ("Run `bash evals/build-waiting/fixtures/fake-build.sh`. It is a build that takes about "
                   "2.5 minutes and prints nothing until it finishes. Do not restart or kill it. When it has "
                   "finished, report its exit status and its final line. Do not edit any files."),
        "checks": {"exit status 0": r"\b0\b", "final line": r"12 targets"},
    },
]
WAITISH = re.compile(r"\bsleep\s+\d|\btail\b|\bpgrep\b|\bps\b|agent-job\s+(status|wait)|kill\s+-0|\.output\b")


def git_show(rev, path):
    return subprocess.run(["git", "show", f"{rev}:{path}"], cwd=REPO, capture_output=True, text=True,
                          check=True).stdout


def make_sandbox(arm):
    box = pathlib.Path(tempfile.mkdtemp(prefix=f"kandelo-wait-eval-{arm}-"))
    (box / "docs/agent-guidance").mkdir(parents=True)
    (box / "evals/build-waiting/fixtures").mkdir(parents=True)
    shutil.copy(HERE / "fixtures/fake-build.sh", box / "evals/build-waiting/fixtures/fake-build.sh")
    if arm == "tools-on":
        shutil.copy(REPO / "CLAUDE.md", box / "CLAUDE.md")
        shutil.copy(REPO / "docs/agent-guidance/validation.md", box / "docs/agent-guidance/validation.md")
        (box / "scripts").mkdir()
        shutil.copy(REPO / "scripts/agent-job", box / "scripts/agent-job")
        (box / ".claude/hooks").mkdir(parents=True)
        shutil.copy(REPO / ".claude/hooks/wait-guard.py", box / ".claude/hooks/wait-guard.py")
        settings = {"hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [
            {"type": "command", "command": f"python3 {box}/.claude/hooks/wait-guard.py"}]}]}}
    else:
        (box / "CLAUDE.md").write_text(git_show(BEFORE, "CLAUDE.md"))
        (box / "docs/agent-guidance/validation.md").write_text(git_show(BEFORE, "docs/agent-guidance/validation.md"))
        settings = {}
    subprocess.run(["git", "init", "-q"], cwd=box, check=True)
    return box, settings


def run_one(task, arm, rep, model, out_dir, budget):
    box, settings = make_sandbox(arm)
    env = dict(os.environ, **task["env"], KANDELO_AGENT_JOBS_DIR=str(box / ".agent-jobs"))
    cmd = ["claude", "-p", task["prompt"], "--model", model, "--output-format", "stream-json", "--verbose",
           "--setting-sources", "project,local", "--strict-mcp-config", "--no-session-persistence",
           "--permission-mode", "bypassPermissions", "--settings", json.dumps(settings),
           "--disallowedTools", "Edit Write NotebookEdit", "--max-budget-usd", str(budget)]
    start = time.time()
    proc = subprocess.run(cmd, cwd=box, env=env, capture_output=True, text=True, stdin=subprocess.DEVNULL)
    seconds = round(time.time() - start)
    events = []
    for line in proc.stdout.splitlines():
        try:
            events.append(json.loads(line))
        except ValueError:
            pass
    result = next((e for e in reversed(events) if e.get("type") == "result"), {})
    answer = result.get("result") or ""
    bash = [c.get("input", {}).get("command", "") for e in events if e.get("type") == "assistant"
            for c in (e.get("message", {}).get("content") or []) if isinstance(c, dict)
            and c.get("type") == "tool_use" and c.get("name") == "Bash"]
    passed = {name: bool(re.search(rx, answer, re.I)) for name, rx in task["checks"].items()}
    record = {
        "task": task["id"], "arm": arm, "rep": rep,
        "score": sum(passed.values()) / len(passed), "checks": passed,
        "cost_usd": result.get("total_cost_usd") or 0.0, "turns": result.get("num_turns") or 0,
        "bash_calls": len(bash), "wait_calls": sum(1 for c in bash if WAITISH.search(c)),
        "used_agent_job": any("agent-job" in c for c in bash),
        "seconds": seconds, "error": bool(result.get("is_error")) or not result,
    }
    (out_dir / f"{task['id']}.{arm}.{rep}.md").write_text(answer + "\n\n--- bash calls ---\n" + "\n".join(bash))
    (out_dir / f"{task['id']}.{arm}.{rep}.json").write_text(json.dumps(record, indent=2))
    shutil.rmtree(box, ignore_errors=True)
    return record


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--reps", type=int, default=3)
    ap.add_argument("--model", default="sonnet")
    ap.add_argument("--tasks", default="")
    ap.add_argument("--jobs", type=int, default=4)
    ap.add_argument("--budget-usd", type=float, default=1.0, help="per-run spending cap")
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    tasks = [t for t in TASKS if not args.tasks or t["id"] in args.tasks.split(",")]
    out_dir = pathlib.Path(args.out or tempfile.mkdtemp(prefix="kandelo-wait-eval-"))
    out_dir.mkdir(parents=True, exist_ok=True)
    arms = ("tools-on", "tools-off")
    jobs = [(t, arm, r) for t in tasks for arm in arms for r in range(args.reps)]
    print(f"{len(jobs)} runs with {args.model}; answers in {out_dir}", flush=True)
    with concurrent.futures.ThreadPoolExecutor(args.jobs) as pool:
        records = list(pool.map(lambda j: run_one(*j, args.model, out_dir, args.budget_usd), jobs))

    print(f"\n{'task':18s} {'arm':10s} {'score':>6s} {'cost $':>7s} {'turns':>6s} {'bash':>5s} {'waits':>6s} "
          f"{'secs':>5s} {'agent-job':>9s}")
    for t in tasks:
        for arm in arms:
            rs = [r for r in records if r["task"] == t["id"] and r["arm"] == arm]
            m = lambda k: statistics.mean(r[k] for r in rs)
            errs = sum(r["error"] for r in rs)
            print(f"{t['id']:18s} {arm:10s} {m('score'):6.2f} {m('cost_usd'):7.3f} {m('turns'):6.1f} "
                  f"{m('bash_calls'):5.1f} {m('wait_calls'):6.1f} {m('seconds'):5.0f} "
                  f"{sum(r['used_agent_job'] for r in rs):>4d}/{len(rs)}{f'  ({errs} errored)' if errs else ''}")
    print("\nScore first, cost second. Read the saved answers and bash calls before trusting a number.")


if __name__ == "__main__":
    main()
