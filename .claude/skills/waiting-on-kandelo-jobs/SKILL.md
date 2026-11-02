---
name: waiting-on-kandelo-jobs
description: Use when about to start, or waiting on, a Kandelo job that can exceed ten minutes, including ./run.sh setup, local-build, build-musl.sh, build-programs.sh, xtask bootstrap, full Vitest, Playwright suites, dEQP or graphics CTS runs, POSIX/libc-test/Sortix suites, benchmarks, or a peer workspace's build.
---

# Waiting on Kandelo Jobs

Read `docs/agent-guidance/validation.md` "Waiting on long builds and suites"
for the [authoritative contract](../../../docs/agent-guidance/validation.md#waiting-on-long-builds-and-suites).
Paths below are relative to the repo root.

## Choose the launch

- **Under ten minutes:** one foreground Bash call, output to a log file:
  `cmd > .context/x.log 2>&1; echo exit=$?`. Read the exit code.
- **Can exceed ten minutes:** `scripts/agent-job start -- <cmd>`; keep
  the printed job id. Several words after `--` are an argv, preserving
  each argument; one quoted word is a shell string run verbatim by Bash:

  ```bash
  scripts/agent-job start -- ./run.sh setup
  scripts/agent-job start -- scripts/dev-shell.sh bash -c 'cd host && npx vitest run'
  scripts/agent-job start -- "scripts/dev-shell.sh bash -c 'cd host && npx vitest run'"
  ```

  Use the dev shell for build/test commands; `./run.sh` enters it itself.
  For setup/local-build, pass `./run.sh` directly after `start --`, without
  an outer dev-shell wrapper: that wrapper drops build progress events.
  Preserve the requested command/options. The Vitest examples are
  alternatives: run only one.
- **Subagent needs a whole-tree build or full suite:** report the command
  and need to the parent, which chooses its own session's waiter below.
  Build first, then dispatch subagents; long waits expire their prompt
  cache and rewrite context.

## Choose the waiter by session type

- **Interactive main session:** run
  `scripts/agent-job wait <id> --timeout 0` once with the Bash tool's
  `run_in_background: true`. Act on its single completion notification
  and collect the result. Do not write Monitor, `until`, or `sleep` loops
  over status files or `agent-job list`: expiry creates re-arm turns.
- **Headless main session or subagent's allowed targeted job:** repeat
  foreground `scripts/agent-job wait <id>` (up to nine minutes per call).
  Repeat only when the wait-window notice says `agent-job: still running`.
  Exit 124 alone is ambiguous: `FAILED (exit 124)` is a completed failed
  job, not a reason to retry. Never end the turn while waiting: execution
  stops there and the result is lost.
- **Peer workspace build:** discover it with
  `scripts/agent-job list --all`, check its worktree/commit, then wait on
  its id or `scripts/agent-job wait --peer <text>` using the session rule
  above. After a selector wait times out, retry with the resolved id from
  `waiting on <id>` or `resume with:`, never with `--peer` again: another
  job can match later. No match or ambiguity exits 2; rediscover or choose
  an id from the candidates. A job can also exit 2; read its final status.
  Never wait on its PID or `pgrep -f`. Your own build can then reuse
  matching cached inputs; a peer's result alone does not validate yours.

If the client yields a running terminal session, resume that same session
to collect completion. Use `scripts/agent-job status <id>` for a specific
progress question, never as a polling waiter.

## Read the result

Run `scripts/agent-job result <id>` for the exit status, log tail and
`[suite-health]` lines. A LOST result is a failed run, not a pass. Read
suite-health warnings and discovered/run/skipped counts; zero tests or
load failures cannot support a passing-suite claim. Search the saved log
around relevant errors instead of reading it whole.

## Traps

- `pgrep -f` can match the waiting shell itself, so the waiter never ends.
- Two Vitest/prepare-browser runs in one tree collide on program-index
  generation; serialize them and respect `start`'s locked-run refusal.
- Always set a free worktree-specific `KANDELO_PLAYWRIGHT_PORT` for
  Playwright suites: `reuseExistingServer` can silently test another
  tree's server on a shared port.
- `scripts/dev-shell.sh` drops outer environment variables; export suite
  variables inside `bash -c`, e.g.
  `scripts/dev-shell.sh bash -c 'export KANDELO_PLAYWRIGHT_PORT=5197; cd apps/browser-demos && npx playwright test'`
  (choose a free port for this worktree).
- Never mutate a tree while a job validates it: mixed inputs invalidate
  evidence and can break program-index publication. Finish or stop the
  job before editing, then validate the final tree.

## Feedback

End your final report with one line:
`Skill feedback (waiting-on-kandelo-jobs): used <what>; wrong: <what or none>; missing: <what or none>`
