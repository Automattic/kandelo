#!/usr/bin/env python3
"""Supervise SQLite project-unit lanes with durable run state.

The existing SQLite wrappers run one host invocation and write per-run
summaries. This script adds the orchestration layer needed for long SQLite
convoys: isolated lane directories, process-group supervision, atomic
current-run state, and aggregate outcome lists that only fold terminal,
DB-backed jobs.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import signal
import sqlite3
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def write_json_atomic(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)


def read_host_status(path: Path) -> dict[str, int]:
    statuses: dict[str, int] = {}
    if not path.exists():
        return statuses
    with path.open(newline="", encoding="utf-8", errors="replace") as f:
        for row in csv.reader(f, delimiter="\t"):
            if len(row) == 2:
                try:
                    statuses[row[0]] = int(row[1])
                except ValueError:
                    pass
    return statuses


@dataclass
class Lane:
    name: str
    patterns: list[str]
    port: int | None = None
    run_dir: Path | None = None
    tmp_dir: Path | None = None
    command_log: Path | None = None
    launch_command: list[str] = field(default_factory=list)
    pid: int | None = None
    started_utc: str | None = None
    started_monotonic: float | None = None
    finished_utc: str | None = None
    status: str = "pending"
    exit_code: int | None = None
    stop_reason: str | None = None
    last_log_mtime: float | None = None
    last_db_terminal_count: int | None = None
    last_db_terminal_change: float | None = None


class Supervisor:
    def __init__(self, args: argparse.Namespace, lanes: list[Lane]) -> None:
        self.args = args
        self.lanes = lanes
        self.results_root = Path(args.results_root).resolve()
        self.current_run = Path(args.current_run).resolve() if args.current_run else self.results_root / "current-run.json"
        self.outcome_dir = self.results_root / "outcome-lists"
        self.summary_json = self.results_root / "summary.json"
        self.summary_md = self.results_root / "summary.md"
        self.running: dict[str, subprocess.Popen[bytes]] = {}
        self.counts = {
            "pass": 0,
            "fail": 0,
            "skip": 0,
            "incomplete": 0,
            "invalid": 0,
        }

    def setup(self) -> None:
        self.results_root.mkdir(parents=True, exist_ok=True)
        self.outcome_dir.mkdir(parents=True, exist_ok=True)
        for name in ["passed-jobs.tsv", "failed-jobs.tsv", "skipped-jobs.tsv", "incomplete-jobs.tsv"]:
            (self.outcome_dir / name).write_text(
                "lane\thost\tjobid\tstate\tdisplaytype\tdisplayname\tcases\terrors\tms\treason\n",
                encoding="utf-8",
            )
        for index, lane in enumerate(self.lanes, start=1):
            lane.run_dir = self.results_root / "runs" / lane.name
            lane.tmp_dir = lane.run_dir / "tmp"
            lane.command_log = lane.run_dir / "command.log"
            lane.run_dir.mkdir(parents=True, exist_ok=True)
            lane.tmp_dir.mkdir(parents=True, exist_ok=True)
            if self.args.host == "browser" and lane.port is None:
                lane.port = self.args.base_port + index - 1

    def lane_command(self, lane: Lane) -> list[str]:
        assert lane.run_dir is not None
        assert lane.tmp_dir is not None
        env_args = [
            f"TMPDIR={lane.tmp_dir}",
        ]
        if self.args.host == "browser":
            if lane.port is None:
                raise ValueError(f"browser lane {lane.name} has no Vite port")
            env_args.extend([
                f"SQLITE_TEST_VITE_PORT={lane.port}",
                "SQLITE_TEST_VITE_REQUIRE_BASE_PORT=1",
            ])
        runner = [
            "bash",
            "scripts/run-sqlite-project-unit-tests.sh",
            "--host",
            self.args.host,
            "--permutation",
            self.args.permutation,
            "--jobs",
            str(self.args.jobs),
            "--timeout-ms",
            str(self.args.timeout_ms),
            "--results-root",
            str(lane.run_dir),
        ]
        if self.args.explain:
            runner.append("--explain")
        runner.extend(lane.patterns)
        if self.args.no_dev_shell:
            return ["env", *env_args, *runner]
        return ["scripts/dev-shell.sh", "env", *env_args, *runner]

    def start_lane(self, lane: Lane) -> None:
        assert lane.command_log is not None
        lane.launch_command = self.lane_command(lane)
        (lane.run_dir / "launch-command.json").write_text(
            json.dumps({"argv": lane.launch_command, "cwd": str(REPO_ROOT)}, indent=2) + "\n",
            encoding="utf-8",
        )
        (lane.run_dir / "launch-command.txt").write_text(
            " ".join(sh_quote(part) for part in lane.launch_command) + "\n",
            encoding="utf-8",
        )
        log = lane.command_log.open("wb")
        proc = subprocess.Popen(
            lane.launch_command,
            cwd=REPO_ROOT,
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        log.close()
        lane.pid = proc.pid
        lane.started_utc = utc_now()
        lane.started_monotonic = time.monotonic()
        lane.status = "running"
        lane.last_log_mtime = lane.command_log.stat().st_mtime if lane.command_log.exists() else time.time()
        lane.last_db_terminal_change = time.time()
        (lane.run_dir / "pid").write_text(f"{proc.pid}\n", encoding="utf-8")
        self.running[lane.name] = proc

    def terminate_lane(self, lane: Lane, reason: str) -> None:
        proc = self.running.get(lane.name)
        lane.stop_reason = reason
        if proc and proc.poll() is None and lane.pid is not None:
            try:
                os.killpg(lane.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            deadline = time.time() + self.args.kill_grace_seconds
            while time.time() < deadline and proc.poll() is None:
                time.sleep(0.2)
            if proc.poll() is None:
                try:
                    os.killpg(lane.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        lane.status = "stopped"

    def update_stale_state(self, lane: Lane) -> None:
        if lane.status != "running":
            return
        now = time.time()
        if self.args.stale_log_seconds > 0 and lane.command_log and lane.command_log.exists():
            mtime = lane.command_log.stat().st_mtime
            if lane.last_log_mtime is None or mtime > lane.last_log_mtime:
                lane.last_log_mtime = mtime
            elif now - lane.last_log_mtime >= self.args.stale_log_seconds:
                self.terminate_lane(lane, f"stale command.log for {self.args.stale_log_seconds}s")
                return
        if self.args.stale_db_done_seconds > 0:
            terminal = current_db_terminal_count(lane, self.args.host)
            if terminal is None:
                return
            if lane.last_db_terminal_count is None or terminal != lane.last_db_terminal_count:
                lane.last_db_terminal_count = terminal
                lane.last_db_terminal_change = now
            elif lane.last_db_terminal_change and now - lane.last_db_terminal_change >= self.args.stale_db_done_seconds:
                self.terminate_lane(lane, f"no terminal DB job movement for {self.args.stale_db_done_seconds}s")

    def write_current_run(self, status: str) -> None:
        active = []
        for lane in self.lanes:
            active.append({
                "lane": lane.name,
                "status": lane.status,
                "pid": lane.pid,
                "port": lane.port,
                "run_dir": str(lane.run_dir) if lane.run_dir else None,
                "tmp_dir": str(lane.tmp_dir) if lane.tmp_dir else None,
                "command_log": str(lane.command_log) if lane.command_log else None,
                "patterns": lane.patterns,
                "started_utc": lane.started_utc,
                "finished_utc": lane.finished_utc,
                "exit_code": lane.exit_code,
                "stop_reason": lane.stop_reason,
                "argv": lane.launch_command,
            })
        data = {
            "schema_version": 1,
            "bead_id": self.args.bead_id,
            "suite": "SQLite project-unit Tcl harness",
            "host": self.args.host,
            "permutation": self.args.permutation,
            "worktree": str(REPO_ROOT),
            "result_dir": str(self.results_root),
            "status": status,
            "updated_utc": utc_now(),
            "progress": {
                "selected_lanes": len(self.lanes),
                "completed_lanes": sum(1 for lane in self.lanes if lane.status in {"terminal", "incomplete", "invalid"}),
                "counts": self.counts,
            },
            "current_run": {
                "lanes": active,
                "process_patterns": [
                    "scripts/run-sqlite-project-unit-tests.sh",
                    "scripts/browser-sqlite-official-runner.ts",
                    "vite --host 127.0.0.1 --strictPort",
                ],
            },
            "stale_thresholds": {
                "shell_timeout_seconds": self.args.shell_timeout_seconds,
                "stale_log_seconds": self.args.stale_log_seconds,
                "stale_db_done_seconds": self.args.stale_db_done_seconds,
                "kill_grace_seconds": self.args.kill_grace_seconds,
            },
            "outcome_lists": {
                "passed": str(self.outcome_dir / "passed-jobs.tsv"),
                "failed": str(self.outcome_dir / "failed-jobs.tsv"),
                "skipped": str(self.outcome_dir / "skipped-jobs.tsv"),
                "incomplete": str(self.outcome_dir / "incomplete-jobs.tsv"),
            },
            "expected_next": {
                "deterministic": status == "running",
                "next_action": "wait for supervised lanes to reach a terminal, incomplete, or invalid boundary" if status == "running" else "inspect summary and choose the next explicit shard set",
            },
        }
        write_json_atomic(self.current_run, data)

    def run(self) -> int:
        self.setup()
        self.write_current_run("running")
        pending = list(self.lanes)
        run_started = time.time()
        while pending or self.running:
            while pending and len(self.running) < self.args.max_parallel:
                self.start_lane(pending.pop(0))
                self.write_current_run("running")
            for lane in self.lanes:
                if lane.status == "running":
                    self.update_stale_state(lane)
            for lane in self.lanes:
                proc = self.running.get(lane.name)
                if not proc:
                    continue
                exit_code = proc.poll()
                if exit_code is None:
                    if lane.started_monotonic and time.monotonic() - lane.started_monotonic > self.args.shell_timeout_seconds:
                        self.terminate_lane(lane, f"supervisor shell timeout {self.args.shell_timeout_seconds}s")
                        exit_code = proc.poll()
                    else:
                        continue
                lane.exit_code = exit_code
                lane.finished_utc = utc_now()
                self.running.pop(lane.name, None)
                classify_lane(lane, self.args.host, self.outcome_dir, self.counts)
                self.write_current_run("running" if (pending or self.running) else "safe_boundary")
            time.sleep(self.args.poll_interval)
        final_status = "complete" if self.counts["incomplete"] == 0 and self.counts["invalid"] == 0 else "safe_boundary"
        self.write_summary(final_status)
        self.write_current_run(final_status)
        return 0 if final_status == "complete" else 1

    def write_summary(self, status: str) -> None:
        lane_summaries = []
        for lane in self.lanes:
            lane_summaries.append({
                "lane": lane.name,
                "status": lane.status,
                "exit_code": lane.exit_code,
                "stop_reason": lane.stop_reason,
                "run_dir": str(lane.run_dir),
                "patterns": lane.patterns,
            })
        summary = {
            "status": status,
            "updated_utc": utc_now(),
            "result_dir": str(self.results_root),
            "current_run": str(self.current_run),
            "counts": self.counts,
            "lanes": lane_summaries,
            "outcome_lists": {
                "passed": str(self.outcome_dir / "passed-jobs.tsv"),
                "failed": str(self.outcome_dir / "failed-jobs.tsv"),
                "skipped": str(self.outcome_dir / "skipped-jobs.tsv"),
                "incomplete": str(self.outcome_dir / "incomplete-jobs.tsv"),
            },
        }
        write_json_atomic(self.summary_json, summary)
        lines = [
            "# SQLite Project Unit Supervised Run",
            "",
            f"Status: `{status}`",
            f"Result dir: `{self.results_root}`",
            f"Current run: `{self.current_run}`",
            "",
            "## Counts",
            "",
            f"- pass: {self.counts['pass']}",
            f"- fail: {self.counts['fail']}",
            f"- skip: {self.counts['skip']}",
            f"- incomplete: {self.counts['incomplete']}",
            f"- invalid: {self.counts['invalid']}",
            "",
            "## Lanes",
            "",
            "| Lane | Status | Exit | Reason | Patterns |",
            "|---|---:|---:|---|---|",
        ]
        for lane in self.lanes:
            lines.append(
                f"| `{lane.name}` | `{lane.status}` | {lane.exit_code if lane.exit_code is not None else '-'} | "
                f"{lane.stop_reason or '-'} | {' '.join(f'`{p}`' for p in lane.patterns) or '-'} |"
            )
        lines.extend([
            "",
            "## Outcome Lists",
            "",
            f"- passed: `{self.outcome_dir / 'passed-jobs.tsv'}`",
            f"- failed: `{self.outcome_dir / 'failed-jobs.tsv'}`",
            f"- skipped: `{self.outcome_dir / 'skipped-jobs.tsv'}`",
            f"- incomplete: `{self.outcome_dir / 'incomplete-jobs.tsv'}`",
            "",
        ])
        self.summary_md.write_text("\n".join(lines), encoding="utf-8")


def sh_quote(value: str) -> str:
    if not value:
        return "''"
    safe = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_+-=.,/:"
    if all(ch in safe for ch in value):
        return value
    return "'" + value.replace("'", "'\"'\"'") + "'"


def current_db_terminal_count(lane: Lane, host: str) -> int | None:
    if not lane.run_dir:
        return None
    db = lane.run_dir / host / "testrunner.db"
    if not db.exists():
        return None
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=1)
        row = con.execute(
            "SELECT coalesce(sum(state IN ('done','failed','omit')), 0) FROM jobs"
        ).fetchone()
        con.close()
        return int(row[0]) if row else None
    except sqlite3.Error:
        return None


def classify_lane(lane: Lane, host: str, outcome_dir: Path, counts: dict[str, int]) -> None:
    assert lane.run_dir is not None
    host_status = read_host_status(lane.run_dir / "host-status.tsv").get(host)
    db = lane.run_dir / host / "testrunner.db"
    if not db.exists():
        lane.status = "invalid"
        counts["invalid"] += 1
        write_incomplete(outcome_dir, lane, host, "-", "invalid", "lane", " ".join(lane.patterns), 0, 0, 0, "no testrunner.db")
        return
    try:
        con = sqlite3.connect(str(db))
        has_jobs = con.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='jobs' LIMIT 1"
        ).fetchone()
        if not has_jobs:
            lane.status = "invalid"
            counts["invalid"] += 1
            write_incomplete(outcome_dir, lane, host, "-", "invalid", "lane", " ".join(lane.patterns), 0, 0, 0, "testrunner.db has no jobs table")
            con.close()
            return
        total, done, failed, omit, running, ready = con.execute(
            """
            SELECT count(*),
                   coalesce(sum(state='done'), 0),
                   coalesce(sum(state='failed'), 0),
                   coalesce(sum(state='omit'), 0),
                   coalesce(sum(state='running'), 0),
                   coalesce(sum(state='ready'), 0)
              FROM jobs
            """
        ).fetchone()
        rows = con.execute(
            """
            SELECT jobid, state, displaytype, displayname, coalesce(ntest, 0),
                   coalesce(nerr, 0), coalesce(span, 0)
              FROM jobs
             ORDER BY jobid
            """
        ).fetchall()
        con.close()
    except sqlite3.Error as exc:
        lane.status = "invalid"
        counts["invalid"] += 1
        write_incomplete(outcome_dir, lane, host, "-", "invalid", "lane", " ".join(lane.patterns), 0, 0, 0, f"sqlite read error: {exc}")
        return

    terminal = total > 0 and running == 0 and ready == 0 and total == done + failed + omit
    if not terminal:
        lane.status = "incomplete"
        counts["incomplete"] += int(running + ready) if running + ready else 1
        for jobid, state, dtype, name, cases, errors, ms in rows:
            if state not in {"done", "failed", "omit"}:
                write_incomplete(outcome_dir, lane, host, jobid, state, dtype, name, cases, errors, ms, "nonterminal testrunner DB state")
        if running + ready == 0:
            write_incomplete(outcome_dir, lane, host, "-", "incomplete", "lane", " ".join(lane.patterns), 0, 0, 0, f"nonterminal DB state with host_status={host_status}")
        return

    lane.status = "terminal"
    for jobid, state, dtype, name, cases, errors, ms in rows:
        if state == "done":
            counts["pass"] += 1
            append_outcome(outcome_dir / "passed-jobs.tsv", lane, host, jobid, state, dtype, name, cases, errors, ms, "sqlite state done")
        elif state == "failed":
            counts["fail"] += 1
            append_outcome(outcome_dir / "failed-jobs.tsv", lane, host, jobid, state, dtype, name, cases, errors, ms, "sqlite state failed")
        elif state == "omit":
            counts["skip"] += 1
            append_outcome(outcome_dir / "skipped-jobs.tsv", lane, host, jobid, state, dtype, name, cases, errors, ms, "sqlite testrunner omit")


def write_incomplete(
    outcome_dir: Path,
    lane: Lane,
    host: str,
    jobid: Any,
    state: str,
    dtype: str,
    name: str,
    cases: Any,
    errors: Any,
    ms: Any,
    reason: str,
) -> None:
    append_outcome(outcome_dir / "incomplete-jobs.tsv", lane, host, jobid, state, dtype, name, cases, errors, ms, reason)


def append_outcome(
    path: Path,
    lane: Lane,
    host: str,
    jobid: Any,
    state: str,
    dtype: str,
    name: str,
    cases: Any,
    errors: Any,
    ms: Any,
    reason: str,
) -> None:
    with path.open("a", newline="", encoding="utf-8") as f:
        writer = csv.writer(f, delimiter="\t", lineterminator="\n")
        writer.writerow([lane.name, host, jobid, state, dtype, name, cases, errors, ms, reason])


def parse_lane(value: str) -> Lane:
    parts = value.split(":", 2)
    if len(parts) != 3:
        raise argparse.ArgumentTypeError("--lane must be NAME:PORT:PATTERN[,PATTERN...]")
    name, port_text, patterns_text = parts
    port = None if port_text in {"", "-"} else int(port_text)
    patterns = [p for chunk in patterns_text.split(",") for p in chunk.split() if p]
    return Lane(name=name, port=port, patterns=patterns)


def read_manifest(path: Path) -> list[Lane]:
    lanes: list[Lane] = []
    with path.open(newline="", encoding="utf-8") as f:
        for row in csv.reader(f, delimiter="\t"):
            if not row or row[0].startswith("#") or row[0] == "lane":
                continue
            if len(row) < 3:
                raise ValueError(f"manifest row needs lane, port, patterns: {row}")
            port = None if row[1] in {"", "-"} else int(row[1])
            patterns = [p for chunk in row[2:] for p in chunk.split() if p]
            lanes.append(Lane(name=row[0], port=port, patterns=patterns))
    return lanes


def build_lanes(args: argparse.Namespace) -> list[Lane]:
    lanes: list[Lane] = []
    if args.manifest:
        lanes.extend(read_manifest(Path(args.manifest)))
    if args.lane:
        lanes.extend(args.lane)
    if not lanes:
        lanes.append(Lane(name="lane-001", port=args.base_port if args.host == "browser" else None, patterns=args.patterns))
    for index, lane in enumerate(lanes, start=1):
        if not lane.name:
            lane.name = f"lane-{index:03d}"
    return lanes


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("patterns", nargs="*", help="patterns/tests for the implicit single lane")
    parser.add_argument("--bead-id", default=os.environ.get("GC_BEAD_ID", ""), help="bead ID for current-run metadata")
    parser.add_argument("--host", choices=["node", "browser"], default="node")
    parser.add_argument("--permutation", choices=["veryquick", "full", "all"], default="all")
    parser.add_argument("--jobs", type=int, default=1)
    parser.add_argument("--timeout-ms", type=int, default=600_000)
    parser.add_argument("--results-root", default=str(REPO_ROOT / "test-runs/sqlite-project-unit-supervised" / datetime.now().strftime("%Y%m%d-%H%M%S")))
    parser.add_argument("--current-run", default="", help="current-run.json path (default: <results-root>/current-run.json)")
    parser.add_argument("--manifest", default="", help="TSV with lane, port, patterns columns")
    parser.add_argument("--lane", action="append", type=parse_lane, help="lane as NAME:PORT:PATTERN[,PATTERN...]")
    parser.add_argument("--base-port", type=int, default=5200)
    parser.add_argument("--max-parallel", type=int, default=1)
    parser.add_argument("--shell-timeout-seconds", type=int, default=900)
    parser.add_argument("--stale-log-seconds", type=int, default=0)
    parser.add_argument("--stale-db-done-seconds", type=int, default=0)
    parser.add_argument("--kill-grace-seconds", type=int, default=10)
    parser.add_argument("--poll-interval", type=float, default=1.0)
    parser.add_argument("--explain", action="store_true")
    parser.add_argument("--no-dev-shell", action="store_true")
    args = parser.parse_args(argv)
    if args.max_parallel < 1:
        parser.error("--max-parallel must be >= 1")
    if args.host == "browser" and args.max_parallel > 1:
        ports = []
        for lane in build_lanes(args):
            ports.append(lane.port)
        concrete = [p for p in ports if p is not None]
        if len(concrete) != len(set(concrete)):
            parser.error("browser lanes must use unique ports")
    return args


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    lanes = build_lanes(args)
    supervisor = Supervisor(args, lanes)
    return supervisor.run()


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
