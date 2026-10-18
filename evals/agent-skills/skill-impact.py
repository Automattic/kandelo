#!/usr/bin/env python3
"""Are the agent skills helping *you*? A local, personal report.

Reads your own Claude Code transcripts (~/.claude/projects) for Kandelo
checkouts, finds package-porting sessions (>= N edits under
packages/registry/), and compares sessions that used the skills with ones that
did not. It also lists harm signals and every "Skill feedback:" line the
skills asked the agent to write, for you to review.

Nothing leaves your machine. This describes your sessions only; it is not a
way to compare developers (task difficulty drives cost more than people do).

Usage (from anywhere):
  python3 evals/agent-skills/skill-impact.py [--since YYYY-MM-DD] [--match kandelo] [--min-edits 3]
"""
import argparse
import collections
import glob
import json
import os
import re
import statistics
from datetime import datetime

SKILLS = ("porting-software-to-kandelo",)
WRAPPER = re.compile(r"\bbash\s+\S*build-package\.sh\s+([A-Za-z0-9._+-]+)")
FEEDBACK = re.compile(r"Skill feedback[^\n]*", re.I)
PUSHBACK = re.compile(r"\b(that'?s (wrong|not right|incorrect)|wrong (package|pattern|reference)|don'?t copy|stale)\b", re.I)


def ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def new_session():
    return dict(cost=0.0, start=None, edits=0, used=False, greps=0, xtask_reads=0, full_log_reads=0,
                rebuilds=[], log_after_summary=0, pushback=[], wrapper_calls=[], feedback=[])


def scan(root, match):
    sessions, seen = collections.defaultdict(new_session), set()
    for d in [d for d in os.listdir(root) if match in d]:
        for f in glob.glob(os.path.join(root, d, "**", "*.jsonl"), recursive=True):
            S = sessions[(d, f.split(d + "/")[1].split("/")[0].replace(".jsonl", ""))]
            for line in open(f, errors="replace"):
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                m = e.get("message")
                if not isinstance(m, dict):
                    continue
                t = e.get("timestamp")
                if t and (S["start"] is None or t < S["start"]):
                    S["start"] = t
                content = m.get("content")
                texts = [content] if isinstance(content, str) else [
                    x.get("text", "") for x in content or [] if isinstance(x, dict) and x.get("type") == "text"]
                if e.get("type") == "user" and "/subagents/" not in f:
                    text = " ".join(texts)
                    if S["used"] and not text.startswith("<") and PUSHBACK.search(text):
                        S["pushback"].append(text[:140].replace("\n", " "))
                if e.get("type") != "assistant":
                    continue
                for text in texts:
                    S["feedback"] += FEEDBACK.findall(text)
                for c in content if isinstance(content, list) else []:
                    if not (isinstance(c, dict) and c.get("type") == "tool_use"):
                        continue
                    name, inp = c["name"], c.get("input") or {}
                    cmd, path = inp.get("command", "") or "", inp.get("file_path", "") or ""
                    if (name == "Skill" and inp.get("skill") in SKILLS) or any(s in path or s in cmd for s in SKILLS):
                        S["used"] = True
                    if name in ("Edit", "Write") and "packages/registry/" in path:
                        S["edits"] += 1
                    if name == "Bash" and re.search(r"\b(grep|rg)\b.*packages/registry", cmd):
                        S["greps"] += 1
                    if "build_deps.rs" in path or re.search(r"(cat|sed|head).*build_deps\.rs", cmd):
                        S["xtask_reads"] += 1
                    if (name == "Read" and path.endswith(".log") and not inp.get("limit")) or \
                            re.search(r"\bcat\s+\S+\.log\b", cmd):
                        S["full_log_reads"] += 1
                        if S["wrapper_calls"] and t and ts(t) - S["wrapper_calls"][-1][1] < 900:
                            S["log_after_summary"] += 1
                    w = WRAPPER.search(cmd)
                    if w and t:
                        pkg, now = w.group(1), ts(t)
                        if any(p == pkg and now - at < 600 for p, at in S["wrapper_calls"]):
                            S["rebuilds"].append(pkg)
                        S["wrapper_calls"].append((pkg, now))
                u = m.get("usage")
                if u and (m.get("id"), e.get("requestId")) not in seen:
                    seen.add((m.get("id"), e.get("requestId")))
                    S["cost"] += (u.get("input_tokens") or 0) + 2 * (u.get("cache_creation_input_tokens") or 0) \
                        + 0.1 * (u.get("cache_read_input_tokens") or 0) + 5 * (u.get("output_tokens") or 0)
    return sessions


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", default="2026-09-29", help="date the skills became available to you")
    ap.add_argument("--match", default="kandelo", help="substring of ~/.claude/projects dir names to scan")
    ap.add_argument("--min-edits", type=int, default=3)
    args = ap.parse_args()

    sessions = scan(os.path.expanduser("~/.claude/projects"), args.match)
    porting = {k: v for k, v in sessions.items() if v["edits"] >= args.min_edits and v["start"]}
    groups = {
        f"with skills (since {args.since})": [v for v in porting.values() if v["used"] and v["start"] >= args.since],
        f"without skills (since {args.since})": [v for v in porting.values() if not v["used"] and v["start"] >= args.since],
        f"before {args.since}": [v for v in porting.values() if v["start"] < args.since],
    }

    def med(xs):
        return statistics.median(xs) if xs else float("nan")

    print(f"{'porting sessions':34s} {'n':>3s} {'med tokens':>11s} {'registry greps':>14s} "
          f"{'build_deps reads':>16s} {'full-log reads':>14s}")
    for name, vs in groups.items():
        print(f"{name:34s} {len(vs):3d} {med([v['cost'] for v in vs]) / 1e6:10.1f}M "
              f"{med([v['greps'] for v in vs]):14.1f} {med([v['xtask_reads'] for v in vs]):16.1f} "
              f"{med([v['full_log_reads'] for v in vs]):14.1f}")
    print("(medians; tokens are input-equivalent: cache read 0.1x, cache write 2x, output 5x)")

    print("\nReview these sessions that used the skills:")
    shown = False
    for (d, sid), v in sorted(porting.items(), key=lambda kv: kv[1]["start"]):
        notes = []
        if v["used"] and v["rebuilds"]:
            notes.append(f"rebuilt the same package within 10 min of a summary: {sorted(set(v['rebuilds']))}")
        if v["used"] and v["log_after_summary"]:
            notes.append(f"read a full log within 15 min of a summary ({v['log_after_summary']}x)")
        if v["pushback"]:
            notes.append("your pushback: " + " | ".join(v["pushback"][:2]))
        notes += [f"agent: {fb[:200]}" for fb in dict.fromkeys(v["feedback"])]
        if notes:
            shown = True
            print(f"  {v['start'][:10]} {re.sub(r'^-Users-[^-]+-', '', d)}/{sid[:8]}")
            for n in notes:
                print(f"    - {n}")
    if not shown:
        print("  none yet")
    print("\nRule of thumb: after ~5 sessions with the skills, if tokens are not lower or the same warning keeps"
          "\nshowing up, fix the skill (or turn it off) and say so in the PR that changes it.")


if __name__ == "__main__":
    main()
