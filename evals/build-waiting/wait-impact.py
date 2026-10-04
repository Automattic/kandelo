#!/usr/bin/env python3
"""How much do agents spend waiting on Kandelo builds and tests? A local report.

Why it exists: every build-waiting tool must earn its place by saving tokens
or rework. This is the measurement that decides whether one stays or gets
removed, as the npm ci skip was.

Reads your own Claude Code transcripts (~/.claude/projects) for Kandelo
checkouts and measures the behaviours the build-waiting tools are meant to
change. Run it over a window before the tools existed to get a baseline, and
over a later window to see whether they helped. See README.md in this
directory for what each number means and the keep/remove rule it feeds.

Nothing leaves your machine. This describes your sessions only; it is not a
way to compare developers (task difficulty drives cost more than people do).

Usage (from anywhere):
  python3 evals/build-waiting/wait-impact.py [--since YYYY-MM-DD] [--until YYYY-MM-DD]
      [--match kandelo] [--json] [--examples N]
"""
import argparse
import collections
import glob
import json
import os
import re
import statistics
import sys
from datetime import datetime

# Background launches that count as "long jobs" when they run at least this long.
LONG_JOB_SECONDS = 120
# A foreground tool call that blocks at least this long is a "foreground wait".
FOREGROUND_WAIT_SECONDS = 300

# Runs that execute the vitest global setup or `npm ci`: two of these in one
# worktree at once race (program-index regeneration, node_modules/.bin).
LOCKED = re.compile(r"npx\s+vitest|node_modules/\.bin/vitest|\bvitest\s+run|run\.sh\s+test\b|"
                    r"ci-run-test-suite\.sh|suite-baseline\.mjs|\bnpm\s+ci\b")
# Text around an error string that marks it as quoted source, docs or memory, not a real occurrence.
QUOTED = re.compile(r"\.rs:\d+:|\"\{\}|format!|metadata:|originSessionId|\bmemory\b|—")
# Background jobs with no completion notice are dropped after this long.
JOB_EXPIRY_SECONDS = 3 * 3600
VALIDATION = re.compile(
    r"\bvitest\b|run\.sh\s+test\b|run-(libc|posix|sortix|sqlite\w*|php\w*|mariadb|nginx|browser\w*)-tests|"
    r"ci-run-test-suite|suite-baseline|playwright\s+test|cargo\s+(test|nextest)")
BUILD = re.compile(r"run\.sh\s+(setup|local-build|build|rebuild|prepare-browser|build-browser)\b|"
                   r"xtask\s+(local-build|bootstrap)|build-musl\.sh|build-programs\.sh|build-package\.sh|"
                   r"cargo\s+build|build-wasm\.sh|scripts/setup\.sh")
SLEEP = re.compile(r"\bsleep\s+\d")
PGREP_WAITER = re.compile(r"\b(until|while)\b[^;]*\bpgrep\s+-f")
PID_WAITER = re.compile(r"\b(until|while)\b[^;]*\bkill\s+-0")
PROBE_HEAD = re.compile(r"^(ps|pgrep|lsof|du|tail|head|wc|ls|stat|date|echo|true|cat|grep|rg|kill\s+-0|"
                        r"sleep|until|while|do|done|then|fi|if|test|\[)\b")
PROCESS_PROBE = re.compile(r"(^|[;&|(]\s*)(ps\b|pgrep\b|lsof\b|du\s+-s)")
TASK_OUTPUT = re.compile(r"/tasks/[^/\s]+\.output|\.log\b")
COLLISIONS = {
    # Fixed by taking the publication lock before the snapshot (tool 6).
    "program-index target race": re.compile(r"program package index target changed"),
    # Not fixed: a hashed build input changed between the two projection passes.
    "registry changed during index": re.compile(r"package registry changed (while generating|after the program package)"),
    "npm ci race": re.compile(r"EEXIST[^\n]{0,200}node_modules"),
}
# A suite that ran nothing. "No test files found" exits 1 (loud); the others can exit 0.
DEAD_SUITE = re.compile(r"Discovered 0 tests|tests\[@\]: unbound variable")
EMPTY_FILTER = re.compile(r"No test files found")
CLOSURE = re.compile(r"Package artifact closure is incomplete")
# Lines the tools print, counted in tool output (see README.md per tool).
MARKERS = {
    "suite_health_lines": re.compile(r"\[suite-health\] files "),
    "suite_health_warnings": re.compile(r"\[suite-health\] WARN "),
    "program_index_lock_waits": re.compile(r"waiting for program-index lock"),
    "closure_preflights": re.compile(r"^artifact closures: \d+ ok", re.M),
}
NOTIFY = re.compile(r"<task-id>([^<]+)</task-id>.*?<status>([^<]+)</status>", re.S)
# Waiting on another worktree's job (tool 1b in README.md). A wait counts as a
# peer wait when the job's recorded worktree is not the session's: subagents
# waiting on their parent's job are then not miscounted.
AGENT_JOB_WAIT = re.compile(r"\bagent-job\s+wait\s+(?:--peer\s+[^<\s]|(?:--timeout\s+\d+\s+)?([A-Za-z0-9._-]+-\d{4}-\d{6}-[0-9a-f]{4}))")
LIST_ALL = re.compile(r"\bagent-job\s+list\b[^;&|\n]*--all\b")
# A command that uses the build-waiting tools (see README.md).
TOOLS = re.compile(r"scripts/agent-job\b|\bagent-job\s+(start|wait|status|result|list)\b")
# Prompt cache lifetime for subagents; a longer idle gap means the next turn rewrites its context.
CACHE_TTL_SECONDS = 300


def ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def cost_of(u):
    # Input-equivalent tokens: cache read 0.1x, cache write 2x, output 5x (same as evals/agent-skills).
    return (u.get("input_tokens") or 0) + 2 * (u.get("cache_creation_input_tokens") or 0) \
        + 0.1 * (u.get("cache_read_input_tokens") or 0) + 5 * (u.get("output_tokens") or 0)


HEREDOC = re.compile(r"<<-?\s*['\"]?(\w+)['\"]?[^\n]*\n.*?\n\s*\1\b", re.S)


def strip_heredocs(cmd):
    # A heredoc body is a script or doc being written, which may quote wait
    # commands (an edit to agent-job's help, say) without running them.
    return HEREDOC.sub("<<heredoc", cmd)


def strip_cd(cmd):
    return re.sub(r"^\s*cd\s+\S+\s*&&\s*", "", cmd.strip())


def produced_by_run(name, inp):
    cmd = inp.get("command", "") or ""
    path = inp.get("file_path", "") or ""
    if name == "Read":
        return bool(TASK_OUTPUT.search(path))
    if name != "Bash":
        return False
    if TOOLS.search(cmd) or "check-artifact-closures" in cmd:
        return True
    if re.search(r"\.(rs|md|ts|py|json)\b|/memory/", cmd) and not (BUILD.search(cmd) or VALIDATION.search(cmd)):
        return False  # a grep or cat of source/docs that may quote the error text
    return bool(BUILD.search(cmd) or VALIDATION.search(cmd) or TASK_OUTPUT.search(cmd))


def is_probe_only(cmd):
    """True when every segment of the command just looks at state (no build, no edit)."""
    cmd = strip_cd(cmd)
    if BUILD.search(cmd) or VALIDATION.search(cmd):
        return False
    segments = [s.strip() for s in re.split(r"[;\n]|&&|\|\|?", cmd) if s.strip()]
    return bool(segments) and all(PROBE_HEAD.match(s) for s in segments)


def text_of(content):
    if isinstance(content, str):
        return content
    out = []
    for x in content or []:
        if isinstance(x, dict):
            if x.get("type") == "text":
                out.append(x.get("text", ""))
            elif x.get("type") == "tool_result":
                out.append(text_of(x.get("content")))
    return "\n".join(out)


def job_worktree(job_id):
    """The worktree a job ran in, from its meta.json on this machine, or None."""
    root = os.path.expanduser(os.environ.get("KANDELO_AGENT_JOBS_DIR", "~/.cache/kandelo/agent-jobs"))
    try:
        with open(os.path.join(root, "jobs", job_id, "meta.json")) as f:
            return json.load(f).get("worktree")
    except (OSError, ValueError):
        return None


def new_stream():
    return dict(cost=0.0, wait_cost=0.0, wait_turns=0, sleep_turns=0, pgrep_waiters=0, pid_waiters=0,
                peer_job_waits=0, peer_selector_waits=0, unresolved_job_waits=0, list_all_calls=0,
                process_probes=0, monitor_calls=0, long_jobs=0, job_seconds=[], polls_per_job=[],
                mutations_mid_validation=0, concurrent_validation=0, foreground_waits=0,
                foreground_wait_seconds=0.0, collisions=collections.Counter(), collision_streams=set(), markers=collections.Counter(), dead_suite=0, empty_filter=0, closure=0,
                tool_uses=0, start=None, gap_rewrites=0, gap_rewrite_cost=0.0, used_tools=False, last_turn=None, examples=collections.defaultdict(list))


def scan_file(path, since, until, n_examples):
    S = new_stream()
    seen_req = set()
    pending = {}      # tool_use_id -> (name, input, launch ts)
    outstanding = {}  # background task id -> dict(cmd, start, polls, validation)
    by_msg = collections.OrderedDict()  # message id -> dict(ts, uses, usage)
    lines = []
    for line in open(path, errors="replace"):
        try:
            lines.append((json.loads(line), line))
        except ValueError:
            continue
    for e, _ in lines:
        t = e.get("timestamp")
        if not t:
            continue
        if S["start"] is None or t < S["start"]:
            S["start"] = t
    if S["start"] is None or not (since <= S["start"][:10] < until):
        return None

    def add_example(kind, text):
        if len(S["examples"][kind]) < n_examples:
            S["examples"][kind].append(text[:160].replace("\n", " "))

    def close_turn(mid):
        turn = by_msg.pop(mid, None)
        if not turn or not turn["uses"]:
            return
        now = turn["ts"]
        waitish = []
        for name, inp in turn["uses"]:
            cmd = inp.get("command", "") or ""
            p = inp.get("file_path", "") or ""
            if name == "Bash":
                if SLEEP.search(cmd):
                    waitish.append(True)
                elif outstanding and is_probe_only(cmd):
                    waitish.append(True)
                else:
                    waitish.append(False)
            elif name == "Read" and outstanding and TASK_OUTPUT.search(p):
                waitish.append(True)
            elif name in ("BashOutput", "TaskOutput", "Monitor"):
                waitish.append(True)
            else:
                waitish.append(False)
        if all(waitish):
            S["wait_turns"] += 1
            S["wait_cost"] += turn["cost"]
            for job in outstanding.values():
                job["polls"] += 1

    for e, raw in lines:
        t = e.get("timestamp")
        m = e.get("message")
        typ = e.get("type")
        now = ts(t) if t else None
        # Completion notices reach main sessions as user messages and
        # subagents as attachments; read them from the raw line either way.
        if "<task-notification>" in raw and now:
            for task_id, status in NOTIFY.findall(raw):
                job = outstanding.pop(task_id.strip(), None)
                if job:
                    dur = now - job["start"]
                    if dur >= LONG_JOB_SECONDS:
                        S["long_jobs"] += 1
                        S["job_seconds"].append(dur)
                        S["polls_per_job"].append(job["polls"])
        if typ == "queue-operation" or not isinstance(m, dict):
            continue
        cwd = e.get("cwd") or ""
        content = m.get("content")
        if typ == "user":
            txt = text_of(content)
            # Error strings only count in output a build/test produced (a task
            # notice, or a result of a build/test/log-reading call), not in a
            # grep of source code or memory files that quotes them.
            produced = "<task-notification>" in txt or any(
                c.get("tool_use_id") in pending and produced_by_run(*pending[c["tool_use_id"]][:2])
                for c in (content if isinstance(content, list) else [])
                if isinstance(c, dict) and c.get("type") == "tool_result")
            for name, rx in COLLISIONS.items():
                hit = produced and rx.search(txt)
                if hit and not QUOTED.search(txt[max(0, hit.start() - 200):hit.end() + 40]):
                    S["collisions"][name] += 1
                    S["collision_streams"].add(name)
                    add_example(name, txt[max(0, hit.start() - 40):])
            if produced and DEAD_SUITE.search(txt):
                S["dead_suite"] += 1
                add_example("dead suite", txt[max(0, txt.find(DEAD_SUITE.search(txt).group(0)) - 80):])
            if produced and EMPTY_FILTER.search(txt):
                S["empty_filter"] += 1
            if produced:
                for name, rx in MARKERS.items():
                    S["markers"][name] += len(rx.findall(txt))
            if produced and CLOSURE.search(txt):
                S["closure"] += 1
            res = e.get("toolUseResult")
            for c in content if isinstance(content, list) else []:
                if not (isinstance(c, dict) and c.get("type") == "tool_result"):
                    continue
                launched = pending.pop(c.get("tool_use_id"), None)
                if not launched:
                    continue
                name, inp, at = launched
                bg = isinstance(res, dict) and res.get("backgroundTaskId")
                if bg:
                    cmd = inp.get("command", "") or ""
                    is_val = bool(VALIDATION.search(cmd))
                    locked = bool(LOCKED.search(cmd)) and not re.search(r"\bpgrep\b|^\s*(until|while|sleep)\b",
                                                                        strip_cd(cmd))
                    for k in [k for k, j in outstanding.items() if at - j["start"] > JOB_EXPIRY_SECONDS]:
                        outstanding.pop(k)
                    if locked and any(j["locked"] and j["cwd"] == cwd for j in outstanding.values()):
                        S["concurrent_validation"] += 1
                        add_example("concurrent validation", cmd)
                    outstanding[bg] = dict(cmd=cmd, start=at, polls=0, validation=is_val, locked=locked, cwd=cwd)
                elif now and at and now - at >= FOREGROUND_WAIT_SECONDS and name == "Bash":
                    S["foreground_waits"] += 1
                    S["foreground_wait_seconds"] += now - at
                    add_example("foreground wait", f"{int(now - at)}s: {strip_cd(inp.get('command', ''))}")
            continue
        if typ != "assistant":
            continue
        mid = m.get("id")
        # A new message id means every earlier turn is complete.
        for old in [k for k in by_msg if k != mid]:
            close_turn(old)
        turn = by_msg.setdefault(mid, dict(ts=now, uses=[], cost=0.0))
        u = m.get("usage")
        if u and (mid, e.get("requestId")) not in seen_req:
            seen_req.add((mid, e.get("requestId")))
            c = cost_of(u)
            S["cost"] += c
            turn["cost"] += c
            # A turn that mostly rewrites its cache after an idle gap paid for the wait.
            write, read = u.get("cache_creation_input_tokens") or 0, u.get("cache_read_input_tokens") or 0
            if S["last_turn"] and now and now - S["last_turn"] >= CACHE_TTL_SECONDS and write > read:
                S["gap_rewrites"] += 1
                S["gap_rewrite_cost"] += 2 * write
            if now:
                S["last_turn"] = now
        for c in content if isinstance(content, list) else []:
            if not (isinstance(c, dict) and c.get("type") == "tool_use"):
                continue
            name, inp = c.get("name"), c.get("input") or {}
            S["tool_uses"] += 1
            turn["uses"].append((name, inp))
            pending[c.get("id")] = (name, inp, now)
            cmd = inp.get("command", "") or ""
            if TOOLS.search(cmd):
                S["used_tools"] = True
            if name == "Monitor":
                S["monitor_calls"] += 1
            if name == "Bash":
                if SLEEP.search(cmd):
                    S["sleep_turns"] += 1
                    add_example("sleep poll", strip_cd(cmd))
                if PGREP_WAITER.search(cmd):
                    S["pgrep_waiters"] += 1
                    add_example("pgrep -f waiter", strip_cd(cmd))
                run = strip_heredocs(cmd)
                if PID_WAITER.search(run):
                    S["pid_waiters"] += 1
                    add_example("kill -0 waiter", strip_cd(cmd))
                if LIST_ALL.search(run):
                    S["list_all_calls"] += 1
                for w in AGENT_JOB_WAIT.finditer(run):
                    if not w.group(1):
                        S["peer_selector_waits"] += 1
                        S["peer_job_waits"] += 1
                        add_example("peer wait", strip_cd(cmd))
                        continue
                    wt = job_worktree(w.group(1))
                    if wt is None:
                        S["unresolved_job_waits"] += 1
                    elif not (cwd == wt or cwd.startswith(wt + "/")):
                        S["peer_job_waits"] += 1
                        add_example("peer wait", strip_cd(cmd))
                if PROCESS_PROBE.search(strip_cd(cmd)):
                    S["process_probes"] += 1
            mutating = name in ("Edit", "Write", "NotebookEdit") or (
                name == "Bash" and re.search(r"\bgit\s+(mv|rm|checkout\s+--|restore)\b", cmd))
            path = inp.get("file_path", "") or ""
            in_tree = (path.startswith(cwd + "/") if path else True) and cwd
            if name in ("TaskStop", "KillShell"):
                outstanding.pop(str(inp.get("task_id") or inp.get("shell_id") or ""), None)
            if mutating and in_tree and "/.context/" not in path and "/.claude/" not in path \
                    and any(j["validation"] and j["cwd"] == cwd for j in outstanding.values()):
                S["mutations_mid_validation"] += 1
                add_example("edit during validation", path or strip_cd(cmd))
    for mid in list(by_msg):
        close_turn(mid)
    return S


def tool_logs(since, until):
    """Numbers the tools record themselves, for the keep rules in README.md."""
    root = os.path.expanduser(os.environ.get("KANDELO_AGENT_JOBS_DIR", "~/.cache/kandelo/agent-jobs"))
    lo, hi = datetime.fromisoformat(since).timestamp(), datetime.fromisoformat(until[:10] if until[:4] != "9999" else "9999-01-01").timestamp()

    def rows(path, key="at"):
        try:
            with open(path) as f:
                for line in f:
                    try:
                        r = json.loads(line)
                    except ValueError:
                        continue
                    if lo <= (r.get(key) or 0) < hi:
                        yield r
        except OSError:
            return

    out = {}
    jobs = list(rows(os.path.join(root, "ledger.jsonl"), "started"))
    errs = [abs(j["duration"] - j["usual_duration"]) / j["duration"] for j in jobs
            if j.get("usual_duration") and j.get("duration")]
    out["agent_job"] = dict(
        jobs=len(jobs), failed=sum(1 for j in jobs if j.get("exit_code")),
        usual_duration_median_abs_error=round(statistics.median(errs), 2) if errs else None,
    )
    hook = list(rows(os.path.join(root, "hook-log.jsonl")))
    out["wait_guard"] = dict(collections.Counter(r["rule"] for r in hook))
    out["wait_guard"]["sessions"] = len({r.get("session_id") for r in hook})
    # Which advice each decision gave: entries before HOOK_VERSION 3 carry no
    # version (1 and 2 are told apart by date: 2 landed 2026-10-02).
    out["wait_guard"]["by_version"] = dict(collections.Counter(str(r.get("version", "1-2")) for r in hook))
    base = os.environ.get("KANDELO_SOURCE_CACHE_ROOT") or os.path.expanduser("~/.cache/kandelo/source-only")
    runs = [r for r in rows(os.path.join(base, "timings", "runs.jsonl"))
            if r.get("predicted_seconds") and r.get("actual_seconds") and r.get("built")]
    errs = [abs(r["predicted_seconds"] - r["actual_seconds"]) / r["actual_seconds"] for r in runs]
    out["local_build_estimate"] = dict(
        builds=len(runs), median_abs_error=round(statistics.median(errs), 2) if errs else None)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", default="2026-08-01")
    ap.add_argument("--until", default="9999-12-31", help="exclusive")
    ap.add_argument("--match", default="kandelo", help="substring of ~/.claude/projects dir names to scan")
    ap.add_argument("--json", action="store_true", help="print machine-readable totals")
    ap.add_argument("--cutoff", default="", help="date the tools became available; groups sessions around it")
    ap.add_argument("--examples", type=int, default=0, help="show N examples per signal")
    args = ap.parse_args()

    root = os.path.expanduser("~/.claude/projects")
    totals = {"main": new_stream(), "subagent": new_stream()}
    for T in totals.values():
        T["collision_sessions"] = collections.defaultdict(set)
    sessions = collections.defaultdict(lambda: dict(cost=0.0, wait_cost=0.0, start="9999", polls=[],
                                                    sleep=0, pgrep=0, used_tools=False))
    for d in sorted(x for x in os.listdir(root) if args.match in x):
        for f in glob.glob(os.path.join(root, d, "**", "*.jsonl"), recursive=True):
            S = scan_file(f, args.since, args.until, args.examples)
            if S is None:
                continue
            kind = "subagent" if "/subagents/" in f else "main"
            sid = (d, f.split(d + "/")[1].split("/")[0].replace(".jsonl", ""))
            X = sessions[sid]
            X["cost"] += S["cost"]
            X["wait_cost"] += S["wait_cost"]
            X["start"] = min(X["start"], S["start"])
            X["polls"] += S["polls_per_job"]
            X["sleep"] += S["sleep_turns"]
            X["pgrep"] += S["pgrep_waiters"]
            X["used_tools"] = X["used_tools"] or S["used_tools"]
            T = totals[kind]
            for k, v in S.items():
                if k in ("start", "last_turn", "used_tools"):
                    continue
                if k == "collision_streams":
                    for name in v:
                        T["collision_sessions"][name].add(sid)
                    continue
                if k == "examples":
                    for kk, vv in v.items():
                        T["examples"][kk] += vv[: max(0, args.examples - len(T["examples"][kk]))]
                elif isinstance(v, (list, collections.Counter)):
                    T[k] += v
                else:
                    T[k] += v

    report = {}
    for kind, T in totals.items():
        jobs = T["polls_per_job"]
        report[kind] = dict(
            input_equiv_tokens=round(T["cost"]),
            wait_tokens=round(T["wait_cost"]),
            wait_share=round(T["wait_cost"] / T["cost"], 4) if T["cost"] else 0.0,
            wait_turns=T["wait_turns"],
            sleep_poll_calls=T["sleep_turns"],
            pgrep_waiters=T["pgrep_waiters"],
            pid_waiters=T["pid_waiters"],
            peer_job_waits=T["peer_job_waits"],
            peer_selector_waits=T["peer_selector_waits"],
            unresolved_job_waits=T["unresolved_job_waits"],
            list_all_calls=T["list_all_calls"],
            process_probe_calls=T["process_probes"],
            monitor_calls=T["monitor_calls"],
            long_background_jobs=T["long_jobs"],
            median_job_minutes=round(statistics.median(T["job_seconds"]) / 60, 1) if T["job_seconds"] else None,
            polls_per_long_job_mean=round(sum(jobs) / len(jobs), 2) if jobs else None,
            polls_per_long_job_median=statistics.median(jobs) if jobs else None,
            long_jobs_polled=sum(1 for p in jobs if p > 0),
            foreground_waits=T["foreground_waits"],
            foreground_wait_hours=round(T["foreground_wait_seconds"] / 3600, 1),
            idle_gap_cache_rewrites=T["gap_rewrites"],
            idle_gap_rewrite_tokens=round(T["gap_rewrite_cost"]),
            edits_during_validation=T["mutations_mid_validation"],
            concurrent_validation_launches=T["concurrent_validation"],
            collisions=dict(T["collisions"]),
            sessions_with_collision={k: len(v) for k, v in T["collision_sessions"].items()},
            dead_suite_outputs=T["dead_suite"],
            empty_filter_outputs=T["empty_filter"],
            closure_incomplete_outputs=T["closure"],
            **{f"marker_{k}": T["markers"][k] for k in MARKERS},
        )
    report["sessions"] = len(sessions)
    report["tool_logs"] = tool_logs(args.since, args.until)

    def med(xs):
        return statistics.median(xs) if xs else None

    groups = collections.OrderedDict()
    for X in sessions.values():
        if args.cutoff and X["start"][:10] < args.cutoff:
            g = f"before {args.cutoff}"
        elif X["used_tools"]:
            g = "used the tools"
        else:
            g = "did not use the tools"
        groups.setdefault(g, []).append(X)
    report["groups"] = {g: dict(
        sessions=len(xs),
        median_wait_share=round(med([x["wait_cost"] / x["cost"] for x in xs if x["cost"]]) or 0, 4),
        median_polls_per_long_job=med([p for x in xs for p in x["polls"]]),
        sleep_polls_per_session=round(sum(x["sleep"] for x in xs) / len(xs), 1),
        pgrep_waiters=sum(x["pgrep"] for x in xs),
    ) for g, xs in groups.items()}
    report["window"] = [args.since, args.until]
    if args.json:
        json.dump(report, sys.stdout, indent=2)
        print()
        return
    print(f"Kandelo build-waiting report, {args.since} .. {args.until} ({len(sessions)} sessions)")
    print("(tokens are input-equivalent: cache read 0.1x, cache write 2x, output 5x)\n")
    print(f"{'session group':24s} {'n':>4s} {'med wait share':>15s} {'med polls/job':>14s} "
          f"{'sleeps/session':>15s} {'pgrep waiters':>14s}")
    for g, v in report["groups"].items():
        print(f"{g:24s} {v['sessions']:4d} {v['median_wait_share']:15.1%} {str(v['median_polls_per_long_job']):>14s} "
              f"{v['sleep_polls_per_session']:15.1f} {v['pgrep_waiters']:14d}")
    print()
    keys = list(report["main"].keys())
    print(f"{'signal':34s} {'main':>14s} {'subagent':>14s}")
    for k in keys:
        a, b = report["main"][k], report["subagent"][k]
        fmt = lambda v: f"{v:,}" if isinstance(v, int) else str(v)
        print(f"{k:34s} {fmt(a):>14s} {fmt(b):>14s}")
    print("\nTool logs (ledger, hook log, local-build timings):")
    for k, v in report["tool_logs"].items():
        print(f"  {k}: {v}")
    if args.examples:
        for kind, T in totals.items():
            for k, v in T["examples"].items():
                print(f"\n[{kind}] {k}:")
                for x in v:
                    print(f"  - {x}")


if __name__ == "__main__":
    main()
