#!/usr/bin/env python3
"""Compare agent answers with and without the repo's agent skills.

Each task in tasks.json runs as a headless, read-only `claude -p` session,
once with the skills on and once with them turned off via skillOverrides.
Only project and local settings load, so personal hooks and plugins do not
skew the comparison between developers. Answers are scored against each
task's checklist (regexes that a correct answer must mention); read the saved
answers too, because a regex hit is not proof the advice is right.

Usage (from the repo root):
  python3 evals/agent-skills/run.py [--reps 3] [--model sonnet] [--tasks id,id] [--jobs 4]

Cost: each run is roughly 50-100k tokens. The default (4 tasks x 2 arms x
3 reps) is ~24 runs; run it when the skills change, not in CI.
"""
import argparse
import concurrent.futures
import json
import pathlib
import re
import statistics
import subprocess
import tempfile
import time

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[1]
SKILLS = ["porting-software-to-kandelo", "diagnosing-kandelo-build-failures"]
ARMS = {
    "skills-on": {},
    "skills-off": {"skillOverrides": {name: "off" for name in SKILLS}},
}
READ_ONLY_TOOLS = ("Read Grep Glob Skill Bash(grep *) Bash(git grep *) Bash(ls *) "
                   "Bash(sed -n *) Bash(head *) Bash(wc *) Bash(find *)")


def build_prompt(task):
    prompt = task["prompt"]
    if "log_fixture" in task:
        log = (REPO / task["log_fixture"]).read_text(errors="replace")
        prompt += "\n\n```\n" + log.strip() + "\n```"
    return prompt


def run_one(task, arm, rep, model, out_dir, budget):
    cmd = ["claude", "-p", build_prompt(task), "--model", model, "--output-format", "json",
           "--setting-sources", "project,local", "--strict-mcp-config", "--no-session-persistence",
           "--settings", json.dumps(ARMS[arm]), "--allowedTools", READ_ONLY_TOOLS,
           "--disallowedTools", "Edit Write NotebookEdit", "--max-budget-usd", str(budget)]
    start = time.time()
    proc = subprocess.run(cmd, cwd=REPO, capture_output=True, text=True)
    try:
        data = json.loads(proc.stdout)
    except ValueError:
        data = {"result": "", "is_error": True, "error": proc.stderr[-2000:]}
    answer = data.get("result") or ""
    passed = {name: bool(re.search(rx, answer, re.I)) for name, rx in task["checks"].items()}
    record = {
        "task": task["id"], "arm": arm, "rep": rep,
        "score": sum(passed.values()) / len(passed), "checks": passed,
        "cost_usd": data.get("total_cost_usd") or 0.0, "turns": data.get("num_turns") or 0,
        "seconds": round(time.time() - start), "error": data.get("is_error", False),
    }
    (out_dir / f"{task['id']}.{arm}.{rep}.md").write_text(answer)
    (out_dir / f"{task['id']}.{arm}.{rep}.json").write_text(json.dumps(record, indent=2))
    return record


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--reps", type=int, default=3)
    ap.add_argument("--model", default="sonnet")
    ap.add_argument("--tasks", default="")
    ap.add_argument("--jobs", type=int, default=4)
    ap.add_argument("--budget-usd", type=float, default=2.0, help="per-run spending cap")
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    tasks = json.loads((HERE / "tasks.json").read_text())
    if args.tasks:
        wanted = set(args.tasks.split(","))
        tasks = [t for t in tasks if t["id"] in wanted]
    out_dir = pathlib.Path(args.out or tempfile.mkdtemp(prefix="kandelo-skill-eval-"))
    out_dir.mkdir(parents=True, exist_ok=True)

    jobs = [(t, arm, r) for t in tasks for arm in ARMS for r in range(args.reps)]
    print(f"{len(jobs)} runs with {args.model}; answers in {out_dir}")
    with concurrent.futures.ThreadPoolExecutor(args.jobs) as pool:
        records = list(pool.map(lambda j: run_one(*j, args.model, out_dir, args.budget_usd), jobs))

    print(f"\n{'task':28s} {'arm':11s} {'score':>6s} {'cost $':>7s} {'turns':>6s}  missed checks")
    for t in tasks:
        for arm in ARMS:
            rs = [r for r in records if r["task"] == t["id"] and r["arm"] == arm]
            missed = sorted({k for r in rs for k, ok in r["checks"].items() if not ok})
            errs = sum(r["error"] for r in rs)
            print(f"{t['id']:28s} {arm:11s} {statistics.mean(r['score'] for r in rs):6.2f} "
                  f"{statistics.mean(r['cost_usd'] for r in rs):7.3f} {statistics.mean(r['turns'] for r in rs):6.1f}"
                  f"  {', '.join(missed) or '-'}{f'  ({errs} errored)' if errs else ''}")
    for arm in ARMS:
        rs = [r for r in records if r["arm"] == arm]
        print(f"{'ALL':28s} {arm:11s} {statistics.mean(r['score'] for r in rs):6.2f} "
              f"{statistics.mean(r['cost_usd'] for r in rs):7.3f} {statistics.mean(r['turns'] for r in rs):6.1f}")
    print("\nScore first, cost second: cheaper answers that miss checks are not a win. "
          "Read the saved answers before trusting a score.")


if __name__ == "__main__":
    main()
