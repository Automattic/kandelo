# Build-waiting tools: how we judge them

Kandelo builds and test suites often run for 10 to 40 minutes. Agents waiting
on them spend tokens on poll loops. They wait on the wrong process, edit the
tree while a run is reading it, and collide with each other's runs. This
directory holds the measurements that decide whether each tool built to fix
that is worth keeping.

The plan below was written and committed **before** the tools were built.
When a tool changes, update its section here in the same change.

## How the numbers are produced

`wait-impact.py` reads your own Claude Code transcripts (`~/.claude/projects`,
Kandelo checkouts only). Nothing is uploaded.

```bash
python3 evals/build-waiting/wait-impact.py --since 2026-08-01 --until 2026-09-30   # baseline
python3 evals/build-waiting/wait-impact.py --since <tools date> --cutoff <tools date>
python3 evals/build-waiting/wait-impact.py ... --examples 5   # show what each signal matched
```

Tokens are *input-equivalent*: a cache read counts 0.1x, a cache write 2x,
and output 5x, the same weighting as `evals/agent-skills`.

`run.py` is a controlled A/B test. It runs the same short, fake waiting tasks
headless, once with the tools available and once without, and compares
correctness, turns, and cost. You get an answer in minutes instead of waiting
weeks for transcripts.

The signals are heuristics. Before trusting one, read its `--examples`.
Every signal below was checked that way against the baseline. Error strings
are counted only in output that a build or test produced, not in a grep that
quotes them.

## Baseline: Aug 1 to Sep 29, 2026, 107 sessions, no tools

| Signal | Main sessions | Subagents |
|---|---:|---:|
| Input-equivalent tokens, total | 3.61 B | 3.25 B |
| Tokens on *wait turns* (every tool call in the turn only sleeps, peeks at a log, or probes processes while a background job runs) | 288 M (8.0%) | 561 M (17.3%) |
| Cache rewrites after an idle gap of 5 min or more | 339 (329 M tokens) | 1,253 (938 M tokens) |
| Foreground tool calls blocking 5 min or more | 652 (88 h) | 507 (67 h) |
| Long background jobs (2 min or more), median duration | 1,900, 11.8 min | 1,414, 13.0 min |
| Wait turns per long job, median / mean | 2 / 11.6 | 5 / 11.6 |
| `sleep` calls | 2,981 | 2,348 |
| `until/while … pgrep -f` waiters | 213 | 157 |
| `ps`/`pgrep`/`lsof`/`du -s` probes | 2,544 | 2,024 |
| Edits to the worktree while a test run was outstanding | 29 | 20 |
| Locked runs (vitest, `run.sh test`, `ci-run-test-suite.sh`, `npm ci`) launched while another was running in the same worktree | 5 | 8 |
| Program-index race errors (sessions affected) | 9 (7) | 26 (6) |
| … of which "index target changed before publication" | 3 (3) | 11 (4) |
| … of which "package registry changed while generating" | 8 (6) | 22 (5) |
| `npm ci` `EEXIST` races (sessions affected) | 1 (1) | 0 |
| Silent empty suites (`Discovered 0 tests`) | 5 | 3 |
| "Package artifact closure is incomplete" seen in run output | 55 | 77 |

The per-session median wait share is 2.9%. The cost is concentrated in long
build and test campaigns, not spread evenly across sessions.

**What this says before any tool exists:**

- Waiting costs real money. The biggest item is **subagents rewriting their
  prompt cache after a long foreground wait**: 938 M tokens. That is more than
  all of their poll turns combined. A subagent's cache lives 5 minutes, so
  every long blocking call pays to rewrite its whole context.
- Poll loops come next: 849 M tokens across main sessions and subagents.
- Collisions are real but rare: the program-index race hit 13 sessions. The
  `npm ci` race hit 1 session, so a tool aimed only at that race has little
  to win.
- Closure-incomplete errors are common (132 occurrences). Each one means a
  test run was started on a tree that could not resolve its artifacts.

## Each tool, its measure, and its keep rule

**Judge after about 5 sessions that used a tool, or after a `run.py` A/B,
whichever comes first.** Compare a tool against sessions in the same window
that did not use it, not only against the baseline, so drift in the kind of
work does not count as impact. When a tool fails its rule, revise it once and
re-measure. If it fails again, remove it and record why in this file. That is
what happened to the build-diagnosis skill (see `evals/agent-skills`).

### 1. `scripts/agent-job`: start, wait, status, result

This runs a command in the background with its log, process ID, and exit
status recorded. Waiting is keyed on the process ID, never on a name
pattern.

- **Measure:** median wait turns per long job; wait-token share; `pgrep -f`
  waiters; idle-gap cache rewrites in subagents. Sources: transcripts, plus
  `run.py`'s `wait-and-report` task (turns, cost, correct exit code).
- **Keep if:**
  - in sessions that use it, median wait turns per long job is ≤ 1, and
    wait-token share is at most half that of same-window sessions that do not
    use it;
  - and in `run.py` it is at least as correct and at most as costly as the
    no-tools arm.
- **Harm signals:**
  - a run whose recorded exit status is missing or wrong;
  - the full log read within 15 min of `agent-job result` in most uses, which
    means the result added nothing;
  - user pushback.

  Any of these in 2 or more sessions means revise or remove.

**Pre-landing smoke test (2026-09-30, 1 rep, Sonnet): harm found, guidance
revised.** The first guidance said to run `agent-job wait` in the
background and end the turn. A headless session did exactly that and ended
without an answer (score 0.00). The no-tools arm ran the 2.5-minute build
in the foreground in one call (score 1.00).

What changed in response:
- runs under the Bash tool's 10-minute limit now go in the foreground;
- `agent-job wait` defaults to a 540 s timeout and is simply repeated;
- ending the turn to wait is limited to interactive main sessions;
- `run.py` gained a 12-minute task, where waiting actually matters.

**A/B after the revision (2026-09-30, 3 reps per arm, Sonnet,
`run.py`):**

| task | arm | score | cost $ | turns | waits |
|---|---|---:|---:|---:|---:|
| wait-and-report (2.5 min) | tools-on | 1.00 | 0.072 | 3.0 | 0.0 |
| wait-and-report (2.5 min) | tools-off | 0.00 | 0.064 | 2.0 | 0.0 |
| long-build (12 min) | tools-on | 1.00 | 0.100 | 5.7 | 2.0 |
| long-build (12 min) | tools-off | 0.00 | 0.064 | 2.0 | 0.0 |
| quiet-build (2.5 min, silent) | tools-on | 1.00 | 0.065 | 2.0 | 1.0 |
| quiet-build (2.5 min, silent) | tools-off | 1.00 | 0.063 | 2.0 | 0.0 |

Scores came to 9/9 with the tools and 3/9 without.

- **Why tools-off failed:** each failed run put the build in the
  background and ended the turn ("I'll report back when it finishes"). A
  headless session stops there.
- **What tools-on did:** ran the short builds in one foreground call, and
  waited on the 12-minute build with two `agent-job wait` calls.
- **Cost:** the correctness clause holds, but the cost clause as written
  ("at most as costly") does not. Raw cost was $0.079 against $0.064 per
  run (+23%), mostly one turn spent reading the guidance. Per correct
  answer, it was $0.079 against $0.192.
- **Scope:** the A/B covers headless sessions, which end their turn the same
  way subagents do. It does not cover interactive main sessions, where a
  completion notice would have rescued the tools-off arm.

### 2. Tree-change stamp (part of `agent-job result`): REMOVED

When the tracked working tree changes between a job's start and its end, the
result says `tree changed during run`.

- **Measure:**
  - stamps raised, from the agent-job ledger;
  - false stamps, where the run's own tracked outputs caused the change.
    Review each one.
  - Baseline: 49 edits during outstanding test runs.
- **Keep if:** no false stamps. One false stamp means fix the comparison;
  two means remove the stamp.

### 3. Build progress: local-build events + `agent-job status`

`local-build` writes its scheduler events (ready, running, finished, failed)
as JSON lines to the file named by `KANDELO_LOCAL_BUILD_EVENTS`, which
`agent-job` sets. `agent-job status` then shows nodes done out of total and
what is running, with each process's command line and age.

- **Measure:** process probes per session. Baseline: 4,568 in 107 sessions,
  about 43 per session.
- **Keep if:** probes per session in sessions that use `agent-job status` are
  at most half of same-window sessions that do not.
- **Harm signals:** status reports a phase or progress that the log
  contradicts. Review this in `--examples`.

### 4. Vitest suite-health line

A reporter prints `[suite-health]` at the end of every vitest run. It gives
the counts of files and tests discovered, run, skipped, and failed before
executing (load errors), grouped by cause. It warns on zero tests, a
dominant load error, or skips.

- **Measure:** warnings raised (counted from `[suite-health] WARN` lines in
  transcripts), each reviewed as real or false. The baseline for silent
  failures is unknowable, because the failure is silence: 8 visible
  `Discovered 0 tests` lines, and the lane F record of 116 of 202
  "expected" failures being one missing module.
- **Keep if:** at least 80% of the first 20 warnings are real.
- **Remove if:** precision is below 80% after one revision.

### 5. Conformance XFAIL reason check

Every expected failure (XFAIL) in the libc, POSIX, and Sortix suites carries
the reason it fails. The runner checks that the failure output matches that
reason, so an XFAIL that fails for a different reason is reported.

- **Measure:** XFAILs whose failure does not match their reason. The first
  full run is the baseline. The 2026-09-25 record found 3 mislabeled XFAILs
  by hand.
- **Keep if:** the first full run, or any later run, catches a mismatch that
  was real.
- **Remove if:** maintaining the reason patterns costs more edits than the
  mismatches it catches over 60 days.

### 6. Program-index lock (xtask)

Generating `program-packages.json` takes a file lock, so two runs wait for
each other instead of failing. The lock is released when its holder dies, so
it cannot be left stale.

- **Measure:** program-index race errors. Baseline: 35 errors in 13 sessions
  over 2 months. Also measured: time spent waiting on the lock, from the
  `waiting for program-index lock` lines.
- **Keep if:** there are zero race errors after it lands, and no lock wait
  exceeds the holder's own run time.
- **Remove if:** it causes any hang.

**Built (2026-09-30), and it fixes the smaller half.** Two different errors
were counted together above:

- **"Index target changed before publication" (14 in 7 sessions):** a
  writer snapshotted the index *before* taking the lock, so a
  byte-identical rename by another writer made it fail. The lock is now
  taken first, and an identical index is not rewritten. Three regression
  tests fail on the old order and pass on the new.
- **"Package registry changed while generating" (30 in 11 sessions):** a
  hashed build input changes between the two projection passes. That is
  a different cause, and it is not fixed. The lead, unconfirmed: inputs
  such as `host/src/generated/abi.ts` being rewritten during concurrent
  runs. The keep rule applies to the first error only; the second is an
  open defect.

### 7. `npm ci` lock and up-to-date skip (`ci-run-test-suite.sh`)

The baseline gives this little to win: 1 race in 2 months. It is worth
building only for the time it saves. It skips `npm ci` locally when the
lockfile, Node version, and installed tree are unchanged, and always runs it
in CI.

- **Measure:** seconds saved per local suite run (logged), and races (target
  0).
- **Keep if:** median time saved per local run is ≥ 15 s.
- **Remove if:** a skipped install ever leaves a stale `node_modules` that
  fails a run.

**Result (2026-09-30): removed before landing.** With a warm npm cache,
`npm ci` for the repo root plus `host/` took 3.2 s, and the skip path took
0.1 s. That saves about 3 s per local run, well under the 15 s rule. Since
races were also rare (1 in 2 months), neither half earned its code. Revisit
only if `npm ci` becomes slow, or if races recur.

### 8. Wait-pattern hook (personal, `~/.claude/hooks`)

A PreToolUse hook denies poll loops (`until`/`while` with `sleep`), `pgrep -f`
waiters, and standalone `sleep` of 30 s or more. It points the agent at
`agent-job wait`. Every denial is logged with its command.

- **Measure:**
  - `sleep` calls and `pgrep -f` waiters per session versus baseline (49.8
    sleeps per session, 370 waiters);
  - precision of denials, reviewed from the log;
  - evasions: the same wait rewritten to get past the hook, such as Python
    `time.sleep` or `timeout … tail -f`.
- **Keep if:**
  - sleeps per session fall by at least 80%;
  - at least 90% of denials are real wait loops;
  - and evasions occur in fewer than 1 session in 5.

**Installing it:** run `python3 .claude/hooks/install-hooks.py --user`.
It is idempotent and keeps a `.bak`; `--check` reports a stale copy and
`--uninstall` removes it. The hook acts only in checkouts that have
`scripts/agent-job`. To judge the rule, count from the date it was
installed, which is recorded in `hook-log.jsonl` by its first entry.

### 8b. Subagent long-wait guard (same hook)

The largest baseline cost is subagents blocking on long builds, at 938 M
tokens. This rule turns standing guidance into enforcement: a subagent that
needs a build expected to take more than 5 minutes returns that need to its
parent instead of waiting. In subagents only, the hook denies foreground
`./run.sh setup`, `local-build`, and full-suite runs, plus any command whose
recorded median (tool 10) is over 5 min. It tells the subagent to report
back what it needs built.

- **Measure:** idle-gap cache rewrites in subagents, against the 938 M
  baseline.
- **Keep if:** those rewrite tokens per subagent session fall by at least
  50%.
- **Harm signals:** subagents ending blocked on a build the parent could not
  provide, or a parent stalled waiting on a subagent's request. Review from
  the denial log; 2 or more sessions means revise.
- **Feasibility check:** this relies on the hook input identifying a
  subagent. If it does not, the rule is dropped, and this file says so.

### 9. `local-build plan --status` with time estimate

Before a build starts, this prints which nodes are cache hits, which will
build, and an estimated duration from recorded timings (tool 10).

- **Measure:** estimate accuracy, from the ledger's predicted versus actual
  duration, and use before `setup`/`local-build`.
- **Keep if:** the median absolute error is ≤ 50% over 10 or more builds,
  and the plan itself takes ≤ 10 s.
- **Remove if:** it is still inaccurate after one revision, or it goes
  unused across 10 sessions that ran long builds.

### 10. Timing history

Per-node build durations go into the shared build cache. Per-job durations
go into the agent-job ledger. Tool 9 uses them for estimates, and
`agent-job wait` uses them for sensible default timeouts.

- **Measure:** judged through tool 9's accuracy and tool 1's wait turns per
  job. On its own, it is kept only if tool 9 or tool 1 is kept.

### 11. Closure preflight

A fast check, run before a test suite, that the tree's package artifacts
resolve as one closure. It catches "Package artifact closure is incomplete"
in seconds instead of mid-suite.

- **Measure:** closure-incomplete errors in test output. Baseline: 132. They
  should now come from the preflight instead. Also measured: preflight run
  time.
- **Keep if:**
  - closure errors in test output fall by at least 80%;
  - the preflight runs in ≤ 10 s;
  - and it never fails on a tree that the suite then runs cleanly.

## Status after building (2026-10-01)

Pre-landing evidence only. The transcript-based keep rules need about 5 real
sessions with the tools before they can be judged.

| # | Tool | Evidence so far | Against its rule |
|---|---|---|---|
| 1 | `agent-job` | A/B 9/9 correct vs 3/9 without; +23% raw cost per run | Correctness met; raw-cost clause not met; transcripts pending |
| 2 | Tree-change stamp | Fired 5 times during development, all for edits the run never read | Removed: saves no tokens |
| 3 | Build progress | Real 154-node build: `status` showed 143/154 done, running nodes with ages, and the process tree | Transcript measure pending |
| 4 | `[suite-health]` | Probe files: 3 load failures grouped to one cause and warned; zero-test run warned; full suite (482 files) raised no false warning | Precision pending (needs 20 warnings) |
| 5 | XFAIL reasons | All 47 verified; found 3 real defects | Met: caught a real mismatch on the first run |
| 6 | Program-index lock | Fixes "index target changed" (14 of 44 baseline errors); 3 regression tests | Pending; the other 30 errors are a separate open defect |
| 7 | `npm ci` skip | Saved about 3 s per run | Failed; removed before landing |
| 8 | Wait-guard hook | Replay over 118,477 past Bash calls: 20/20 sampled sleep-poll denials and 12/12 pgrep-waiter denials were real. The harness already blocks about 40% of leading sleeps | Not installed; opt-in |
| 8b | Subagent guard | Hook input carries `agent_id`; end-to-end denial of `./run.sh setup` in a subagent confirmed | Not installed; opt-in |
| 9 | `local-build --plan` | Plan takes 2.3-6 s; first estimate 610 s against 1,095 s actual (44% error, load average ~100) | 1 of 10 builds |
| 10 | Timing history | node-durations.jsonl and runs.jsonl recording | Judged through tools 1 and 9 |
| 11 | Closure preflight | Catches a broken closure (negative test); 2.7 s warm, 12 s cold, 46 s cold at load ~100 | Warm runs meet 10 s; cold runs do not |

## Token-efficiency review (2026-10-01)

The maintainer asked that everything in this change contribute to token
savings: directly, by cutting turns, or indirectly, by preventing rework. A
false green that surfaces later costs a re-investigation, plus re-validation
of every commit that cited it.

- **Tree-change stamp (tool 2): removed.** It aimed at rework, but as built
  it caused more. All 5 stamps raised during development came from edits the
  run never read, so its "re-run before citing" advice would only have added
  runs. It is worth reconsidering only if narrowed to changes in source the
  run plausibly read.
- **XFAIL reason checks and zero-test guards (tool 5): kept.** They cost
  nothing per run and prevent rework from false greens.
  - On 2026-09-25, the conformance suites had been failing before any test
    started, unnoticed.
  - Lane F once cited an empty Sortix suite as a pass.
- **`[suite-health]` skipped-files line: kept.** It costs one line per run.
  Fully skipped files are how the Ruby fork tests went silently untested in
  2026-09.

The measurement scripts stay. They are how a part that saves nothing gets
found and removed.

## What the analyzer cannot see

- **Main-session idle gaps include the user's own think time.** That is why
  the cache-rewrite claim above rests on subagents.
- **Whether an edit made during a run was actually read by it.** The count
  is an upper bound.
- **Work in other tools or machines.**
