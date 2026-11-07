#!/usr/bin/env python3
"""Recompute controlled-wait wake costs from saved subagent transcripts.

Usage: python3 evals/build-waiting/summarize-subagent-wait.py <run-directory>
An idle wake here follows a Bash agent-job wait by more than 30 seconds.
Short hook-denial retries are included in session totals, not in wake totals.
"""
import datetime
import json
import pathlib
import sys

from run import input_equivalent


def turns(path):
    messages = {}
    for line in path.open():
        event = json.loads(line)
        message = event.get("message") or {}
        if event.get("type") != "assistant" or not message.get("id"):
            continue
        key = message["id"]
        if key not in messages:
            messages[key] = dict(at=event["timestamp"], usage=dict(message.get("usage") or {}), tools={})
        turn = messages[key]
        turn["usage"]["output_tokens"] = max(turn["usage"].get("output_tokens") or 0,
                                             (message.get("usage") or {}).get("output_tokens") or 0)
        for content in message.get("content") or []:
            if isinstance(content, dict) and content.get("type") == "tool_use":
                turn["tools"][content["id"]] = content
    return list(messages.values())


def summarize(record):
    wakes, calls = [], []
    for path in sorted(pathlib.Path(record["evidence"]).glob("subagents/*.jsonl")):
        ts = turns(path)
        for turn in ts:
            calls.extend(turn["tools"].values())
        for prev, turn in zip(ts, ts[1:]):
            waits = [t["input"].get("command", "") for t in prev["tools"].values()
                     if t.get("name") == "Bash" and "agent-job wait" in t["input"].get("command", "")]
            gap = (datetime.datetime.fromisoformat(turn["at"].replace("Z", "+00:00")) -
                   datetime.datetime.fromisoformat(prev["at"].replace("Z", "+00:00"))).total_seconds()
            if waits and gap > 30:
                wakes.append(dict(at=turn["at"], gap_seconds=round(gap, 3), commands=waits,
                                  usage=turn["usage"], input_equivalent=input_equivalent(turn["usage"])))
    return dict(arm=record["arm"], score=record["score"], cost_usd=record["cost_usd"],
                session_tokens=record["tokens"], seconds=record["seconds"],
                fixture_exit=(record.get("fixture_result") or {}).get("exit_code"),
                subagent_tool_calls=len(calls),
                subagent_wait_calls=sum(t.get("name") == "Bash" and "agent-job wait" in
                                        t["input"].get("command", "") for t in calls),
                wake_tokens=sum(w["input_equivalent"] for w in wakes), wakes=wakes)


if __name__ == "__main__":
    root = pathlib.Path(sys.argv[1])
    rows = [summarize(json.loads(p.read_text())) for p in sorted(root.glob("subagent-wait.*.[0-9]*.json"))]
    (root / "wake-summary.json").write_text(json.dumps(rows, indent=2) + "\n")
    print(json.dumps(rows, indent=2))
