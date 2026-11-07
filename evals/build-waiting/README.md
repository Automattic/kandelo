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

**Harm found in use (2026-10-01): a several-word command lost its
quoting.** `agent-job start -- scripts/dev-shell.sh bash -c 'cd host && npx
vitest …'` joined its words with plain spaces. The inner `bash -c` received
only `cd`, and the vitest run went outside the dev shell, from the repo
root. Every result of that 45-file run was invalid: it used the wrong vitest
config and toolchain, and reported link errors and timeouts. This counts
toward the "recorded exit status is wrong" harm signal (1 session so far).

- **Fix (2026-10-02):** several words are re-quoted with `shlex.join`; one
  word is still run verbatim as a shell string.
- **Regression test:** `python3 evals/build-waiting/test_agent_job.py`.
  It fails on the old join and passes on the fix. It also checks that
  job keys, and with them the timing history, are unchanged for
  `./run.sh setup`, `./run.sh local-build`, `ci-run-test-suite.sh`, and
  dev-shell vitest runs.

### 1a. Session-specific waiting guidance and start hints (2026-11-02)

**Final decision: remove the waiting skill before landing.** The advice
checks below showed higher skill-on cost without demonstrating fewer
waiting or re-arm turns. Both arms received the updated CLAUDE.md, and
some skill-off sessions still read the skill file, so checklist gains
did not isolate an incremental skill benefit. Remove the skill, mirror,
discovery pointers, runner registration and its six skill-on/off tasks.
Retain the clearer core guidance, CLI hints, retry corrections and three
regression tests. Useful operational warnings now live in the validation
guide. No skill retention decision remains pending.

**Measure the retained guidance and hints:** use `wait-impact.py` and
manual transcript review to count wait turns, re-arms, polling incidents
and lost results for jobs expected to exceed ten minutes. Separate
interactive main, headless main and subagent sessions. Compare similar
commands and durations with the old guidance/hints; do not treat the
historical skill-on/off scores as evidence for these retained changes.
Review after five eligible sessions of each type, with a manual
checkpoint on 2026-11-16 even if a group is still pending. This is a
documented checkpoint, not scheduled automation.

Keep the new hints if at least four of five interactive sessions use one
background waiter per job, median re-arms are zero, no polling loop is
written and no result is lost; headless sessions must collect final
status and subagents must return whole-tree build needs. Any misleading
hint or lost result caused by the advice means revise once, then judge
the next five sessions of that type. Remove an extra hint that still
fails. Claim cost savings only after a comparable real-session measure
supports them. Revisit a smaller skill only if agents still miss the
waiter and a clean experiment can test its incremental value.

#### Original skill experiment (historical)

The original proposal and checks are preserved below as evidence of the
rejected experiment. Their skill-specific retention rules and pending
skill judgments are superseded by the final decision above.

Plan committed before writing `waiting-on-kandelo-jobs`. The mechanism
already exists; this change tests whether a discoverable skill gets agents
to choose the right waiter. On 2026-11-02 a main session used `start`, then
hand-written Monitor loops over status files, checking every 30-60 seconds
and expiring every 30 minutes. Each expiry needed a re-arm turn. This is
one reported incident, not a measured transcript baseline.

- **Exposure:** record whether the skill was available and loaded, plus
  whether the new `start` hint was present. Compare with same-window
  sessions without the skill and the preceding 14 days. Keep job duration,
  command family, hook version and session type alongside each record.
  Do not attribute a combined skill/hint effect to either alone.
- **Measure:** run `wait-impact.py --since <date> --until <date> --json`
  and `--examples 10` over local transcripts. Report wait-turn count and
  wait-token share, sleeps, PID/name waiters, peer waits, collisions,
  edits during validation and empty suites. Its long-job cutoff is two
  minutes; manually restrict this evaluation to jobs expected to exceed
  ten minutes. Preserve raw reports locally, outside tracked source.
- **Manual annotations:** the analyzer groups main sessions and subagents,
  but does not distinguish interactive from headless mains or detect
  Monitor loops, re-arms, skill exposure or lost results reliably. Review
  each eligible job's tool calls and completion output. Record interactive
  main, headless main, or subagent; own or peer job; waiter launches;
  re-arm turns (restarting an expired waiter); Monitor/status-file/list
  polling incidents; and lost or incorrectly reported results. Count one
  loop as one incident, and report unknown session types separately.
- **Controlled check:** add read-only tasks to `evals/agent-skills` for
  interactive, headless, subagent and peer waiting. Run the skill-on/off
  comparison and read the saved answers, not just regex scores. Require
  correct exit/result handling first; compare turns and cost second.
  These advice tasks do not prove actual interactive notification delivery.
- **Judge:** review after the first five eligible interactive sessions,
  and separately after five headless sessions and five subagent build
  requests. Publish a checkpoint on 2026-11-16 even if samples are short;
  mark unfilled groups pending rather than claiming success. Review the
  controlled check before landing, and retain its sample size and limits.
- **Keep if:** the controlled answers are at least as correct with the
  skill, with a strict improvement on at least one waiting decision;
  at least four of five interactive sessions use one background
  `wait <id> --timeout 0` per job, median re-arms are zero, no session
  writes a Monitor/sleep/status polling loop, and median wait turns per
  job are at most one. Wait-token share should fall by at least half
  against comparable sessions without the skill. Headless sessions must
  all collect final status through foreground waits without ending early;
  subagents must all return whole-tree build needs to their parent.
- **Revise/remove:** any lost result, wrong-session waiter, collision or
  invalid validation claim caused by the advice triggers revision. Revise
  once if a filled group's keep rule fails, then judge the next five of
  that type; remove the skill if it fails again. Remove the extra start
  hint if it remains unused or misleading after that revision. If skill-on
  never improves a decision in the controlled check, revise once and
  rerun before keeping it. Higher cost without better correctness or
  fewer waiting turns is a failure, not a saving.

Do not extend the wait-guard hook in this experiment. A follow-up that
blocks Monitor/background loops needs its own baseline, denial-precision
and evasion measures under tool 8, including legitimate monitor commands.

**Pre-landing advice checks (2026-11-02): provisional, not a savings
claim.** Ran the four waiting tasks with the host Claude CLI's
`--model sonnet`, one repetition per arm, three times (24 read-only
headless sessions). The second sample followed a clarification that
setup/local-build must be passed directly to `start --`, without an
outer dev-shell wrapper. The third followed committing the skill, after
an earlier answer said its glob could not find the untracked file.
All runs completed without runner errors.

| Sample | Arm | Checklist score | Mean cost $ | Mean turns |
|---|---|---:|---:|---:|
| Initial | skill on | 0.958 | 0.124 | 1.75 |
| Initial | skill off | 0.771 | 0.096 | 1.00 |
| Clarified launch | skill on | 0.958 | 0.079 | 2.75 |
| Clarified launch | skill off | 0.875 | 0.065 | 1.25 |
| Tracked skill | skill on | 0.833 | 0.115 | 1.50 |
| Tracked skill | skill off | 0.729 | 0.090 | 1.00 |

Scores above re-check saved answers using the experiment's final
matchers. Two matchers initially missed correct advice: `start` accepts
an omitted `--`, and "when the build finishes, re-dispatch" means build first.
A third was corrected between samples to accept "zero discovered tests".
Raw answers, original scores and re-scored records remain locally under
`.context/wait-skill-eval*`; no transcripts are checked in.

Reading every answer showed why these numbers are only a smoke check:

- Both arms usually chose the right waiter from the updated CLAUDE.md.
  These tasks do not establish an improvement in interactive waiting.
- Answers that read the skill gave concrete suite-health, Playwright
  port and inner-export guidance. Several other answers, including
  skill-on answers, merely said they would load it and relied on notes.
  Availability is not proof of loading or following the skill.
- Some interactive answers still wrapped setup in the dev shell or
  omitted `agent-job result`; the launch clarification did not reliably
  fix answers that never read it. Some subagent answers assumed the
  parent was interactive. These remain risks to review in transcripts.
- Skill-on answers cost more and took more turns. That bought more
  complete advice in these samples, not measured waiting-token savings.

At this stage the proposal was to keep the skill pending real-session
review, with the 2026-11-16 checkpoint unchanged. Neither notification
delivery, re-arm reduction nor lost-result prevention was exercised by
advice tasks. The new start hints have a separate executable regression test:
both printed commands return a failing job's actual exit status; the
test fails on the old hint. The declared dev shell passed all 15
agent-job tests, all 6 wait-guard tests, and the skill path/frontmatter/
mirror checks (3 skills). Runtime and browser suites were not run for
these guidance and CLI-output changes.

**Adversarial-review corrections (2026-11-02).** The first independent
review reproduced two unsafe retry decisions: a completed job exiting
124 could be mistaken for an unfinished job, and repeating a peer
selector could switch to a replacement job. The skill, validation guide,
CLAUDE.md and CLI help/hints were revised to distinguish a still-running
wait-window notice from a final `FAILED (exit 124)` result. Timeout output prints an
executable `resume with:` command pinned to the original id.

The declared dev shell passed 17 agent-job tests and the 3-skill checks.
Coverage now includes completed exit-124 results with bounded and
unbounded waits, and executing a printed peer retry after the original
failed and a replacement started. Both updated CLI-guidance regression
tests fail on the preceding script. The hook was not changed.

Ran two new read-only retry scenarios, one repetition per arm (four
headless sessions, CLI `--model sonnet`); read all four answers. Re-scored
the saved answers after correcting a missed synonym ("newer") and adding
a timeout-unit check that the first checklist lacked:

| Arm | Checklist score | Mean cost $ | Mean turns |
|---|---:|---:|---:|
| Skill on | 1.000 | 0.120 | 2.50 |
| Skill off | 0.875 | 0.118 | 2.50 |

All four answers correctly treated a completed exit 124 as final and
pinned peer retries to the original id. One skill-off answer proposed
`--timeout 540000` while calling it nine minutes; that flag is seconds,
so it is not a valid bounded headless wait. The original regex score
missed this error. Raw and re-scored records are local under
`.context/wait-skill-retry-eval*`. The shared updated guidance is available
to both arms, so this small advice sample verifies the corrected
decisions without isolating the skill's effect or demonstrating savings.
The real-session skill judgment remained pending at that stage; the
final decision above subsequently removed the skill.

### 1b. Waiting on another workspace's build: `list --all`, commits, `wait --peer`

Several Conductor workspaces on one machine often build the same tree, and
they share the build cache. An agent that needs a build another workspace is
already running does better to wait for it than to start a second one. The
job records were always machine-wide, and `agent-job wait <id>` always
worked on any job, but `agent-job list` showed only the caller's worktree,
so a peer's build could not be found. On 2026-10-02 an agent waited on a
peer's `./run.sh prepare-browser` by polling `kill -0 <pid>` instead.

What was added (2026-10-02):

- `agent-job list --all` lists jobs from every worktree, with a worktree
  column.
- `start` records the job's git `HEAD` and its uncommitted changes to
  tracked files. `list --all`, `status`, and `wait` show both, and how
  that commit relates to the caller's `HEAD`: same commit, ancestor,
  descendant, diverged, or unrelated. The build cache is keyed on inputs,
  so the closer the commit, the more of a peer's build the caller's own
  run can reuse.
- `agent-job wait --peer <text>` waits on the one running job whose
  command contains `<text>`. When no job matches, or more than one does,
  it exits 2 and lists the candidates. It never picks one.
- The wait-guard hook (tool 8) used to deny a `pgrep -f` waiter with the
  advice "for a process you did not start, `while kill -0 <pid>`". A
  peer's build is such a process, so the hook was pointing agents at
  exactly the hand-rolled wait this section counts. Its denials now name
  `list --all` and `wait --peer` first, and keep `kill -0` only for
  processes that no agent-job started. An installed copy goes stale with
  this change: `python3 .claude/hooks/install-hooks.py --user --check`
  reports it, and running the same command without `--check` updates it.
- `CLAUDE.md` gained one sentence pointing at `list --all` and
  `wait --peer`, so agents that never open `validation.md` see it.

- **Measure,** per session, with `wait-impact.py`. A *peer wait* means
  waiting on a process the session did not start.
  - `peer_job_waits`: `agent-job wait` on a job whose recorded worktree
    is not the session's, plus every `wait --peer`. The worktree comes
    from the job's `meta.json` on this machine; `unresolved_job_waits`
    counts waits whose job directory is gone;
  - `peer_selector_waits`: `wait --peer` alone;
  - `list_all_calls`: `agent-job list --all`;
  - hand-rolled waits, from `pid_waiters` (`until`/`while … kill -0`),
    `pgrep_waiters`, and `sleep` polls. Whether such a wait targets a peer
    takes reading: the PID usually comes from a `ps` listing or a pid file,
    not from a launch the analyzer can match. Review them with
    `--examples`. `pid_waiters` and the three counts above skip heredoc
    bodies, which quote commands without running them.
  - **Baseline, Aug 1 to Oct 2, 2026 (121 sessions):** 241 `kill -0`
    waiters (147 in main sessions, 94 in subagents) and 384 `pgrep -f`
    waiters. Most wait on the session's own runs. Several in the
    `--examples` sample find their PID with `pgrep -f "run.sh
    prepare-browser"` or a shared `/tmp/*.pid` file, which can be another
    workspace's run. The 2026-10-02 `kill -0` wait on a peer's
    `prepare-browser` is the one confirmed case. `agent-job` peer waits:
    none before this change, other than this change's own smoke test.
- **Keep `list --all` and the commit fields if:** over the first 10
  sessions that wait on a peer's build, by either method, at least 8 do it
  with `agent-job`, and hand-rolled peer waits happen in at most 2.
- **Keep `--peer` if:** at least one of those 10 sessions uses it, and it
  succeeds more often than it exits 2 for ambiguity. If no session uses
  it, remove it: `list --all` plus `wait <id>` covers the same need.
- **Harm signals:**
  - a commit relation that `git merge-base` contradicts;
  - an agent that reused a peer build of an unrelated or diverged commit
    and then hit a stale-artifact or closure error;
  - `--peer` exiting 2 in two sessions where the agent then fell back to
    a hand-rolled wait.

  Any of these means revise; a second failure means remove.

**A recording defect fixed along the way (2026-10-02).** The new tests,
which start many jobs at once, crashed `start` once. `start` and the
supervisor both rewrite `meta.json`, through the same temporary file, and
whichever writes second drops the other's field: `start`'s copy lacks
`child_pid`, and the supervisor's copy was read before `start` added
`supervisor_pid`. Without `supervisor_pid`, a running job reads as LOST
and `wait` returns at once with exit 125. Reproduced on the old script by
injecting a 0.5 s delay into `start`:

- 37 of 40 jobs started at once lost `child_pid`;
- in a second run, 8 of 10 lost `supervisor_pid`, and 5 of 6 running
  `sleep 15` jobs were listed as LOST while still running.

Each writer now uses its own temporary file, and the supervisor waits for
`start`'s write before adding `child_pid`. With the same injected delay,
0 of 40 jobs lost a field, and 6 of 6 running jobs were listed as
running. None of the 66 jobs in the real ledger at the time had lost a
field, so the race needs a slow `start`.

**A second defect found by the same tests (2026-10-02): no `ps` inside
the dev shell.** Under `scripts/dev-shell.sh`, PATH has no `ps`.
`agent-job status` on a running job crashed, and so did a `wait` that
timed out: it exited 1 instead of 124, so "still running" read as a
failure. `status` now falls back to `/bin/ps`, and without any `ps` it
says the process list is unavailable. A regression test runs `wait` with
no `ps` on PATH. It fails on the old code (exit 1) and passes now
(exit 124).

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

When a run has failures, the reporter also prints `info:` lines with the
machine's load at the start and end of the run, the other `agent-job` jobs
still running, and each failed test's duration. They state facts and never
excuse a failure.

- **Measure:** for failures whose line shows high load or other jobs, how
  often a quiet rerun passed, and whether a transcript used the line to
  decide on that rerun.
- **Keep if:** the line marks most load-caused failures, which then pass when
  rerun quietly, and real regressions under load are still investigated.
- **Remove if:** readers start dismissing failures because of it, or it never
  changes a decision.

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

**Keeping installed copies current (2026-10-02).** `--user` installs a
copy, so a hook change merged to main reaches nobody until they re-run the
installer. That mattered once already: after #1464 changed the advice for
waiting on another workspace's build, installed copies kept recommending
`while kill -0 <pid>`.

- **The rule:** every change to a rule or a denial message bumps
  `HOOK_VERSION` in `wait-guard.py`. Comment-only changes do not bump it.
  Main agents refresh existing user installations after merging; initial
  installation remains opt-in.
- **The notice:** when the checkout an agent works in has a higher
  `HOOK_VERSION` than the installed copy, the hook shows the user a
  one-line notice to reinstall, once per session. It goes to the user
  (`systemMessage`), not the model, and does not approve or deny the
  call. A checkout with a lower version, as on an older branch, is
  silent.
- **No self-update from a checkout:** the copy reads the checkout's version
  as text and never runs or copies the checkout's file. A user-level hook
  that updated itself from whatever repository is open would let any
  branch change what runs on every Bash call.
- **Agent maintenance (2026-11-07):** `CLAUDE.md` cues main agents to
  fetch `origin main` and run
  `python3 .claude/hooks/install-hooks.py --user --update-from-main`
  at task start and after merging hook changes. This mode updates only
  existing opt-ins, takes both hook and installer from fetched
  `origin/main`, and refuses a version downgrade. A lock serializes
  concurrent automatic updates. It does not execute feature-branch code
  as the global hook, or require a Conductor-specific setup script.
  No additional model calls were made to validate this maintenance mode.
- **Versioned log:** every `hook-log.jsonl` entry records `version`, and
  `wait-impact.py` reports decisions per version (`by_version`). Judge a
  changed rule or message only on entries from the version that has it.
  Entries without the field come from versions 1 (#1455) and 2 (#1464,
  2026-10-02), and are told apart by date.
- **Limit:** copies installed before version 3 cannot give the notice;
  agents' task-start cue also updates existing unversioned copies.
  Maintenance requires a main agent reading the new guidance; it is not
  a service that runs immediately on a GitHub merge without an agent.
- **Tests:** `python3 evals/build-waiting/test_wait_guard.py` and
  `test_install_hooks.py`. The latter's six isolated-Git tests cover
  merged-source provenance, opt-in, downgrade refusal, legacy updates,
  idempotence, settings/backup preservation and failure without main.

### 8b. Subagent long-wait guard (same hook)

The largest baseline cost is subagents blocking on long builds, at 938 M
tokens. This rule turns standing guidance into enforcement: a subagent that
needs a build expected to take more than 5 minutes returns that need to its
parent instead of waiting. In subagents only, the hook denies foreground
`./run.sh setup`, `local-build`, and full-suite runs. It tells the subagent
to report back what it needs built. Recorded-duration lookup is not
implemented.

- **Measure:** idle-gap cache rewrites in subagents, against the 938 M
  baseline.
- **Keep if:** those rewrite tokens per subagent session fall by at least
  50%.
- **Harm signals:** subagents ending blocked on a build the parent could not
  provide, or a parent stalled waiting on a subagent's request. Review from
  the denial log; 2 or more sessions means revise.
- **Feasibility check:** this relies on the hook input identifying a
  subagent. If it does not, the rule is dropped, and this file says so.

**Subagent wait windows, plan before measuring (2026-11-07).**

The graphics baseline at `3700f32cb4` found 187 subagent wakes from
`agent-job wait`, with a median 9.1-minute gap and 412k-token context.
They cost 153M input-equivalent tokens, 21% of that workflow. After
3–4.75-minute gaps, 0/74 subagent turns rebuilt their cache; after
6–10-minute gaps, 194/194 did. Main-session caches survived gaps up to
an hour. The projected 153M → 22M cost with shorter windows is an
estimate, not measured savings. Source transcripts and the analysis in
madrid are read-only; local copies are in `.context/graphics-baseline`.

- **Boundary:** local agent tooling and Claude Code's prompt cache;
  no guest/kernel, Node/browser host, ABI, or package change.
- **Design:** keep the main-session 540 s default and interactive
  background `--timeout 0`. Split CLI hints by session type. Subagents
  use foreground `--timeout 240` for targeted work; whole-tree builds,
  full suites and other known long jobs return to the parent. Preserve
  explicit timeouts in retry hints. The opt-in hook uses `agent_id` to
  deny subagent `agent-job wait` calls without a literal positive
  timeout, or with a total window over 270 s in one Bash call. The
  margin leaves time for scheduling, status output and the next request
  inside the observed five-minute cache boundary. This is a guardrail,
  not a guarantee about scheduler delay or arbitrary shell programs.
- **Identity check:** inspect CLI environment/process evidence and
  capture a main and a subagent probe in the controlled check. Prefer
  hook identity over inferring identity from a process name or adding
  a global timeout that also shortens main-session waits.
- **Replay:** run `replay-hook.py` over the graphics transcripts;
  review a deterministic sample of at least 20 new-rule denials (all
  if fewer), plus main-session and quoted-text controls. Report policy
  precision separately from actual observed wait durations: a completed
  job may return immediately even with an unsafe requested window.
- **Controlled check:** one baseline/candidate pair, Sonnet, with one
  foreground subagent per session waiting on a 660 s fixture job.
  Both start with the same default wait request; baseline uses the
  pre-change hook and CLI, candidate uses this change. Load a fixed
  context before waiting so a rebuild is visible. Capture hook inputs,
  safe environment/process probes, raw model streams and persisted
  subagent transcripts. Score the exit status and error line against
  fixture output. Inspect usage at each wake, including cache reads
  and creation, rather than inferring a cache hit from elapsed time.
- **Accounting:** cherry-pick `ea82add28e`, preserving authorship;
  use session-total `modelUsage`, sum turns across result segments,
  and retain raw streams. Check its aggregation with regression tests.
- **Cost estimate before model calls:** about $0.50–$2 total on Sonnet
  for the pair with modest fixed context; cap each session at $1.50
  ($3 combined). No repeated statistical trial or large graphics replay
  with models. Replay and unit tests make no model calls.
- **Measure:** denial precision, correct completion, actual subagent
  idle gaps and cache creation/read tokens at wakes, input-equivalent
  tokens and billed session cost, tool calls, wall time, and unchanged
  main-session wait behavior. Record model/client versions and limits.
- **Keep if:** at least 90% of sampled denials target executable
  subagent waits with unsafe windows, no main-session denial, both
  arms report the fixture result correctly, and candidate wakes avoid
  the baseline's full-context rebuild with lower wake token cost.
  If the controlled check cannot reproduce a baseline rebuild, report
  it as inconclusive; do not claim measured cache savings. Retain the
  narrow policy only as a guardrail supported by historical evidence.
- **Revise/remove if:** a main session is restricted, results are lost,
  or a denial encourages polling/evasion. Review the first five real
  subagent uses; two blocked-parent or evasion incidents require revision.

**Identity and replay (2026-11-07).** Claude Code 2.1.316's controlled
main/subagent probes had the same environment variable names and the
same Claude process ancestor within each session. Both had `CLAUDECODE=1`
and `CLAUDE_CODE_ENTRYPOINT=sdk-cli`; neither exposed
`CLAUDE_CODE_AGENT_ID` or `CLAUDE_AGENT_ID`. These probes do not establish
a portable environment/process discriminator. Hook inputs did distinguish
them: no main `agent_id`, and a distinct nonempty id on subagent Bash
calls. The CLI therefore prints separate hints instead of guessing its
caller; the hook enforces the bound using the supplied identity.

```bash
python3 evals/build-waiting/replay-hook.py --since 2026-11-01 --until 2026-11-04 --match kandelo-moscow --samples 25
```

The replay covered 11,627 Bash calls. The new rule flagged 296 calls from
25 subagents. A separate pass over the normalized turns found the same
296 calls and 10 main-session waits, with zero new-rule main denials.
Review of 25 randomly selected denials (seed 1, normalized transcript
order) found 25 wait command sites with unsafe requested windows; 23/25
actually reached `agent-job`, while two failed shell glob expansion first.
That is 92% executable-wait precision, meeting the 90% policy threshold.
Only 15/25 sampled calls actually lasted over 270 s; the policy deliberately
requires a bounded request even when a job happens to have finished.

Across all 296 flagged calls, 194 had Bash-call elapsed time over 270 s,
24 returned in under 30 s, and median elapsed time was 519.7 s. Elapsed
time includes any other commands in the same Bash call, so it is not an
exact measure of time inside `wait`. These are historical classifications,
not measured savings. Full reviewed commands, result excerpts and the
duration script are local in `.context/replay-samples.md`,
`.context/replay-details.json` and `.context/analyze-wait-replay.py`.
Existing-rule denials are outside this new rule's precision sample.

**Controlled result (2026-11-07).** One pair on macOS 27.2 arm64,
Claude Code 2.1.316, alias `sonnet` resolved to `claude-sonnet-5-5`.
Both sessions used the same current guidance and explicit experimental
prompt; only the CLI and hook differed. The baseline took them from
`1b6f3783d3`. Each session delegated one foreground subagent, read the
same 600-record context file (two reads, because the first was truncated),
then tried the default wait. The fixture requested 660 s and actually
took 669.1/668.7 s. Both reported exit 3 and the exact `frob_widget`
error, confirmed against the saved fixture logs and result records.

| Measure | Baseline | 240 s candidate |
|---|---:|---:|
| Correct result | 1/1 | 1/1 |
| Blocking waits | 2 | 3 |
| Extra denied default wait | 0 | 1 |
| Subagent tool calls, including reads and denials | 5 | 7 |
| Gaps at wait wakes, seconds | 543.8, 114.3 | 243.9, 243.9, 166.4 |
| Cache creation tokens at those wakes | 41,023; 876 | 530; 523; 862 |
| Cache read tokens at those wakes | 2,384; 43,407 | 43,274; 43,804; 44,327 |
| Input-equivalent tokens at wait wakes | 90,801 | 20,466 |
| Whole-session input-equivalent tokens | 231,870 | 167,404 |
| Session cost, USD | 0.320160 | 0.237803 |
| Wall time, seconds | 678 | 677 |

The baseline rebuilt about 95% of its prompt after the 543.8 s gap.
Every candidate wake read the existing prefix, creating only the new
suffix. Wake input-equivalent tokens were 77% lower in this pair;
whole-session tokens were 28% lower and billed cost 26% lower, including
the denial and extra wait. Combined cost was $0.558, below the estimate
and caps. The keep rule is met for this controlled check: correct
completion, preserved short-window caches, and lower measured wake cost.

**Limits:** one pair, roughly 43–45k-token subagent contexts, a synthetic
job, and an explicitly directed first wait. This measures the cache
mechanism, not natural adoption, parent handoff, large contexts, or
workflow-wide savings. It does not turn the historical 18% projection
into a measurement. CLI defaults and main-session hook controls were
tested; a separate main-session long-wait A/B was not run. Arbitrary
scripts, aliases, non-wait commands and scheduling stalls can still
outlive the cache. The first-five-real-uses harm review remains pending.

Raw streams, fixture records/logs, identity probes, copied subagent
transcripts and measured source snapshots/hashes are local under
`.context/subagent-cache-eval-auth`. `wake-summary.json` comes from:

```bash
python3 evals/build-waiting/summarize-subagent-wait.py .context/subagent-cache-eval-auth
```

The final loop-parser refinement produced identical decisions and reasons
on all 10 captured Bash calls (`decision-equivalence.json`). The collector
was corrected to resolve macOS `/tmp` aliases; persisted transcripts from
this pair were recovered read-only, and a regression test covers their
collection. An initial pair could not authenticate inside the dev shell
and used zero model tokens/$0; only those harness-owned fixtures were
terminated with SIGTERM. The measured pair used the macOS Keychain client
for CLI authentication, with dev-shell Python and fixture tools.

**Validation and rollout:** dev-shell `test_wait_guard.py` (9 tests),
`test_agent_job.py` (18), and `test_run.py` (3) passed, as did Python
compilation and `git diff --check`. Runtime/browser/conformance suites
were not run: this changes only local agent tooling. `HOOK_VERSION` is
now 4. Main agents refresh an existing installation with
`python3 .claude/hooks/install-hooks.py --user --update-from-main` after
fetching main; a first installation still uses explicit `--user` opt-in.

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
| 1b | Peer waits (`list --all`, commits, `--peer`) | 8 tests (two worktrees, old records, `--peer` exits 2 on none and on several, `wait` without `ps`) | Pending: 10 sessions that wait on a peer |
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
