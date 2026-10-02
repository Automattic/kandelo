#!/usr/bin/env python3
"""Replay .claude/hooks/wait-guard.py over past Bash calls in your transcripts.

Why it exists: a deny hook that misfires costs more than it saves, because
agents retry, rephrase, or give up. Replaying it over real history measures
how precise its denials are before anyone installs it.

Shows what the hook would have denied, per rule, with samples to review for
false positives, before (or without) installing it. Local only.

Usage: python3 evals/build-waiting/replay-hook.py [--since D] [--until D] [--samples N] [--match kandelo]
"""
import argparse
import collections
import glob
import json
import os
import random
from importlib.machinery import SourceFileLoader

HERE = os.path.dirname(os.path.abspath(__file__))
guard = SourceFileLoader("wait_guard", os.path.join(HERE, "..", "..", ".claude", "hooks", "wait-guard.py")).load_module()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", default="2026-08-01")
    ap.add_argument("--until", default="9999-12-31")
    ap.add_argument("--samples", type=int, default=8)
    ap.add_argument("--match", default="kandelo")
    args = ap.parse_args()
    root = os.path.expanduser("~/.claude/projects")
    hits, sessions, total = collections.defaultdict(list), collections.defaultdict(set), 0
    for d in (x for x in os.listdir(root) if args.match in x):
        for f in glob.glob(os.path.join(root, d, "**", "*.jsonl"), recursive=True):
            sub = "/subagents/" in f
            sid = f.split(d + "/")[1].split("/")[0].replace(".jsonl", "")
            for line in open(f, errors="replace"):
                if '"tool_use"' not in line or '"Bash"' not in line:
                    continue
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                if not (args.since <= (e.get("timestamp") or "")[:10] < args.until):
                    continue
                for c in (e.get("message") or {}).get("content") or []:
                    if isinstance(c, dict) and c.get("type") == "tool_use" and c.get("name") == "Bash":
                        total += 1
                        payload = {"tool_name": "Bash", "tool_input": c.get("input") or {},
                                   "agent_id": "replay" if sub else None}
                        rule, reason = guard.decide(payload)
                        if reason:
                            hits[rule].append(payload["tool_input"].get("command", ""))
                            sessions[rule].add(sid)
    print(f"{total} Bash calls replayed")
    random.seed(1)
    for rule, cmds in sorted(hits.items()):
        print(f"\n{rule}: would deny {len(cmds)} calls in {len(sessions[rule])} sessions; samples:")
        for c in random.sample(cmds, min(args.samples, len(cmds))):
            print("  - " + c.replace("\n", " \\n ")[:230])


if __name__ == "__main__":
    main()
