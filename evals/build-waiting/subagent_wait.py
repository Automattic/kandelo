"""Isolated long-wait A/B support for run.py; no graphics workspace writes."""
import json
import pathlib
import re
import shutil
import subprocess

BASELINE = "1b6f3783d3"
ARMS = ("wait-baseline", "wait-short")
TASK = dict(id="subagent-wait", env={"FAKE_BUILD_SECONDS": "660"}, arms=ARMS,
            checks={"exit status 3": r"\b3\b", "error line": r"frob_widget"})


def prepare(box, arm, here, git_show, env):
    # Both arms get the same current guidance; only hook and CLI differ.
    if arm == "wait-baseline":
        for path in ("scripts/agent-job", ".claude/hooks/wait-guard.py"):
            (box / path).write_text(git_show(BASELINE, path))
    shutil.copy(here / "fixtures/identity-probe.py", box / "identity-probe.py")
    (box / "context.txt").write_text("".join(
        f"Record {i:04d}: amber birch cedar delta elm fir grove hazel iris juniper kelp larch moss oak pine reed.\n"
        for i in range(600)))
    # Save identities and hook input without changing the decision under test.
    (box / ".claude/hooks/capture.py").write_text('''import io, json, pathlib, runpy, sys, time
raw = sys.stdin.read()
p = json.loads(raw)
with open("hook-inputs.jsonl", "a") as f:
    f.write(json.dumps(dict(at=time.time(), agent_id=p.get("agent_id"),
                           session_id=p.get("session_id"), tool_input=p.get("tool_input"))) + "\\n")
sys.stdin = io.StringIO(raw)
runpy.run_path(str(pathlib.Path(__file__).with_name("wait-guard.py")), run_name="__main__")
''')
    worker = (
        "This is an authorized cache measurement, so finish the wait here rather than handing it back. "
        "Run `python3 identity-probe.py subagent`. Read all of context.txt once to seed a fixed context. "
        "Then run exactly `scripts/agent-job wait JOB_ID` first, with Bash timeout 600000 in the foreground. "
        "If a hook denies that window, follow its shorter-timeout alternative (targeted measurement work). "
        "After an expired window, use its printed resume command in a separate foreground Bash call, "
        "with timeout 600000. Repeat only when it says still running. Do not poll, background, loop, "
        "restart, or kill the job. Stay until the actual job result. Report its exit status and first error line.")
    started = subprocess.run(["python3", str(box / "scripts/agent-job"), "start", "--name", "cache-probe", "--",
                              "bash", "evals/build-waiting/fixtures/fake-build.sh"],
                             cwd=box, env=env, text=True, capture_output=True, check=True)
    job_id = started.stdout.splitlines()[0]
    worker = worker.replace("JOB_ID", job_id)
    prompt = ("This is a controlled prompt-cache experiment. Run `python3 identity-probe.py main`, then "
              "delegate exactly one foreground cache-waiter subagent with this task, and wait for it to finish. "
              "Do not run the job or wait yourself; report the worker's exit status and error line. Task: " + worker)
    agents = {"cache-waiter": {"description": "Finish the controlled job wait", "prompt": worker,
                               "tools": ["Bash", "Read"]}}
    return prompt, agents, job_id


def collect(box, out, stem, session_id, job_id):
    dest = out / (stem + ".evidence")
    dest.mkdir()
    for name in ("hook-inputs.jsonl", "identity-main.json", "identity-subagent.json"):
        if (box / name).exists():
            shutil.copy(box / name, dest / name)
    if (box / ".agent-jobs").exists():
        shutil.copytree(box / ".agent-jobs", dest / "agent-jobs")
    # Only this harness-owned session's transcripts. Never touch peer sessions.
    project = re.sub(r"[^a-zA-Z0-9]", "-", str(box.resolve()))
    source = pathlib.Path.home() / ".claude/projects" / project
    if (source / f"{session_id}.jsonl").exists():
        shutil.copy(source / f"{session_id}.jsonl", dest / "main.jsonl")
    if (source / session_id / "subagents").exists():
        shutil.copytree(source / session_id / "subagents", dest / "subagents")
    result = box / ".agent-jobs/jobs" / job_id / "result.json"
    return dict(evidence=str(dest), sandbox=str(box), session_id=session_id,
                fixture_result=json.loads(result.read_text()) if result.exists() else None)
