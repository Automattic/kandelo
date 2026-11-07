# Agent skill evals

Do the skills in `.claude/skills/` actually help? These tools answer that
question without relying on anyone's history, so a developer on their first
day can use them too.

## 1. Does the skill help at all? (`run.py`)

`run.py` gives Claude the same read-only tasks (porting a package, registering
a runtime workaround, preparing the weekly upstream filing pass) twice:
once with the skills on, and once with them off. It then scores each answer
against a short checklist in `tasks.json` of facts a correct answer must
mention.

```bash
python3 evals/agent-skills/run.py              # all tasks x 2 arms x 3 reps, Sonnet
python3 evals/agent-skills/run.py --reps 1     # quick check
```

- **Isolation:** only project settings load, so your personal hooks and plugins don't skew the result.
- **Read the score first, then the cost.** A cheaper answer that misses checks is not a win.
- **Read the saved answers** (the path is printed) before trusting a score. A regex match is not proof the advice is right.
- **When to run it:** run when a skill changes, not in CI. The default
  runs every task in `tasks.json` in both arms, three times each. Cost
  grows with that inventory; use `--tasks id,id` and `--reps 1` to scope
  a quick check instead of assuming a fixed session count or budget.
- **Adding a skill?** Add tasks for it to `tasks.json` and its name to `SKILLS` in `run.py`. Keep it only if it wins here.

## 2. Is it helping me? (`skill-impact.py`)

```bash
python3 evals/agent-skills/skill-impact.py --since <date you started using the skills>
```

This reads your own Claude Code transcripts on your machine. Nothing is
uploaded. It compares your porting sessions with and without the skills, and
lists things worth a second look:

- the same package rebuilt again right after a summary;
- a full log read anyway;
- your pushback in the conversation;
- every `Skill feedback:` line the skills ask the agent to write.

It describes your sessions only. It is not a way to compare developers:
cost depends far more on the task than on the person.

**New to the repo?** You have no "before". To create one, turn the skills off
for some porting tasks, chosen before you start, and compare.

To turn them off, add this to `.claude/settings.local.json`:

```json
{ "skillOverrides": { "porting-software-to-kandelo": "off" } }
```

## 3. Where did it help or mislead? (feedback lines)

The skill asks the agent to end with
`Skill feedback (<skill>): used …; wrong: …; missing: …`.

When a line says something was wrong or missing, fix the skill.
`scripts/test-agent-skills.sh` in CI catches stale paths and names, but only
people reading this feedback catch advice that is well formed and still wrong.

## What this has decided so far

A waiting skill was tried and removed before landing. Advice checks cost
more with it enabled and did not establish incremental waiting benefits
over the shared guidance. Both arms saw the updated CLAUDE.md, and some
skill-off sessions still read the skill file. The retained changes are
the core waiting guidance, CLI hints and retry regression tests. The
experiment and its limitations are recorded in
`evals/build-waiting/README.md`, tool 1a. Its six scenarios were removed
from this skill-on/off runner, since no waiting skill remains to toggle.

A second skill for diagnosing build failures was tried and removed. Over 3
runs per task it cost about 20% more than no skill ($0.11 versus $0.09 per
run) and was no more correct (0.93 versus 0.96 on the checklist). Build
scripts here already keep their output short, so plain `grep` and `tail`
found the first error just as well.

The porting skill stayed: $0.13 versus $0.24 per run, half the turns, and a
checklist score of 1.00 versus 0.97.

The runtime-workaround skill (`tracking-runtime-workarounds`) stayed after
its first eval. Two runs of one rep each, on the registry already in the
repo, scored 1.00 versus 1.00 and 1.00 versus 1.00 on registering a
workaround, and 1.00 versus 0.00 and 0.75 versus 0.00 on preparing the
weekly filing pass. Without the skill, the agent described the pass from
`CLAUDE.md` and never opened the registry README, so it named none of the
real commands; with the skill, it named all of them. The porting tasks
stayed at 1.00 with the skill on. The one missed check with the skill on
was a regex miss: the answer said not to file in other words. The
registration task shows no score difference because `CLAUDE.md` already
carries the rule; the skill's answers were more concrete (template path,
an existing entry to extend, the cache-key consequence of editing libc
glue). This is a small sample, so rerun it when the skill changes.

## Campaign context trial: pre-registration (2026-11-07)

Status: rotation trial not run. The checkpoint helper and advisory context
reminder are implemented; automatic worker rotation is not enabled.
The graphics baseline in `evals/build-waiting/README.md` covers 12,114
deduplicated assistant messages and 715.48M input-equivalent tokens.
An independent source-transcript pass matched every usage row. Among
37 subagents with at least 100 messages, median context by life quarter
was 130k / 267k / 351k / 404k. Median per-agent mean turn cost by quarter
was 24.5k / 40.0k / 62.6k / 73.5k. These are descriptive statistics,
not evidence that replacing an agent preserves quality.

**Primary candidate:** hand off at a completed phase to a fresh subagent
using a notes file, with no inherited conversation. Keep the coordinator
responsible for long builds and suites under the existing waiting rules.
Do not rotate an agent merely because a turn counter expires.

**Offline hypothesis:** one reset after message 100 in each qualifying
subagent, preserving later work and cache outages, models 186–231M fewer
input-equivalent tokens with a 100k–50k replacement context. This charges
2x for the entire fresh context, including instructions, notes and source
reads, and 5x for a 2k-token note. It retains new tail creation and stops
savings at the next context reduction greater than 20%. An additional
100k input-equivalent tokens of dispatch/setup per handoff reduces that
to 183–228M. The checkpoint is a sensitivity calculation, not a safe
handoff classifier. Savings overlap the existing wait-cache estimate;
do not add them. The untested assumption is that notes preserve enough
reasoning to continue without extra recovery work.

**Trial fixed before running:**

- Select six independent, reproducible phase checkpoints from future
  campaigns before seeing either outcome: three implementation-to-focused-
  validation transitions and three diagnosis-to-fix transitions. Eligibility
  is at least 100 messages, at least 250k input-context tokens, and an
  enumerated next-phase acceptance checklist. Record eligible checkpoints
  skipped and why. Use isolated snapshots; do not run in the historical
  graphics workspace or mutate its jobs.
- At each checkpoint, an outgoing agent writes a note in an isolated fork
  before arm assignment; preserve the original checkpoint for control.
  Charge note generation only to treatment. Target 2k tokens; record
  actual length. Include worktree,
  commit and dirty paths, decisions/invariants and rejected approaches,
  exact evidence paths and limits, live job ownership, unresolved failures,
  and the next check. Control continues the original conversation;
  treatment starts fresh with the note and reads required guidance and
  relevant source. Verify the control really retains its prefix: the
  current fresh-session skill runner alone cannot implement this trial.
- Pin model, effort, tools, instructions, artifacts and acceptance checks.
  Alternate arm order and isolate ports, logs and job ownership. Stop each
  arm on phase completion or after 60 further assistant messages; count an
  unfinished phase as incomplete. Apply the same limit to one preselected
  following phase to capture recovery. Do not choose checkpoints retrospectively
  because they happen to save tokens.
- Before any model calls, estimate cost from the six historical continuation
  windows plus notes, dispatch, fresh reads and a recovery allowance; record
  that estimate and an explicit run budget. Cherry-pick `ea82add28e` before
  using `evals/build-waiting/run.py` or the agent-skills runner. Save complete
  streams and deduplicate assistant usage by message id, taking maximum
  output per id and accounting for every background-wait segment.

**Measure:** primary outcome is total input-equivalent tokens per accepted
completed phase, including outgoing notes, coordinator dispatch, fresh
startup/reads and recovery through the following phase. Use
`input + 0.1 cache_read + 2 cache_creation + 5 output`; report dollars
separately. Also report all six paired totals, input context per turn,
turns, wall time, additional reads, duplicated validation and incomplete
phases. A reviewer blind to the arm checks requirements, actual test
evidence, invariants/rejected approaches, and unresolved failures; a
cheaper incomplete or falsely green answer is not an accepted phase.

**Keep rule:** adopt a short dispatch/handoff rule only if accepted phase
count and every quality check are at least as good, there are no false
greens or lost required decisions, aggregate tokens per accepted phase
fall at least 20%, and cost falls in at least five of six pairs. Otherwise
leave guidance unchanged. After adoption, review five real campaigns;
any handoff-caused correctness failure, or recovery erasing the cost win
in two campaigns, suspends the rule pending revision. Six pairs support
a local adoption decision, not a universal quality claim.

**Deferred alternatives, evaluated separately:** a soft 12k-character
read-output bound models about 22.7M fewer tokens (3.2%) before extra
reads, assuming four characters per token; sampled large outputs were
relevant source/tests. It must allow deliberate expansion. Shortening
guidance has short-task A/B support in the build-waiting README, but no
campaign quality result. For either alternative, use the same six-pair
quality gate, count expansion/recovery costs, change only that variable,
and require at least 10% lower tokens per accepted phase in five of six
pairs. Do not combine these interventions with the handoff trial.

### Checkpoint/reminder implementation gate

`scripts/agent-checkpoint` stores required handoff sections and records the
worktree, HEAD, tracked diff hash and status. Its `check` command checks
format and that recorded state, not the truth of the note or test results.
The independent Claude Code and Codex adapters inject one advisory reminder per agent at
250k recorded input-context tokens. It never denies a tool, ends a session,
spawns a worker or asks the user to arrange a handoff.

Before installation, run offline regression tests for correct parent/child
attribution, latest usage after compaction, parallel one-time delivery,
malformed/missing input, immutable notes, stale tracked state, and preserving
other hooks during install/check/uninstall. No model calls are needed.

Pre-registered operational measure: select 20 source transcripts evenly
across the graphics manifest, compare the bounded-tail usage parser with a
full-record reference, and invoke each hook twice with isolated cache state.
Keep this implementation only with 20/20 correct context readings, no tool
decisions or user messages, no repeated reminders, reminder text under 2k
characters, and p95 process wall time below 250 ms on the measured machine.
Record results locally; this is an operational gate, not a token-saving or
quality claim. The graphics workspace and its jobs remain read-only.

After five real reminder uses per client, inspect note creation and recovery costs
under the handoff trial's accounting. At least four notes must be produced
at real phase milestones and judged adequate by their coordinator. Any
lost required decision, premature completion caused by the reminder, or
two cases requiring the user to relay context means disable/revise it.
Do not promote automatic rotation without the primary six-pair keep rule.

Run the offline checks with:

```bash
scripts/dev-shell.sh python3 -B evals/agent-skills/test_context_checkpoint.py
scripts/dev-shell.sh python3 -B evals/build-waiting/test_wait_guard.py
```

Operational result (2026-11-07, local macOS, repository dev shell): all 15
checkpoint/installer regression tests and six existing wait-guard tests
passed. The 20-transcript check matched 20/20 full-record references, with
zero repeat reminders across 40 process invocations. Median process time
was 46 ms, p95 72 ms, and longest reminder 1,093 characters, satisfying
the operational gate. Raw measurements and the replay script are local in
`.context/context-growth/checkpoint-measurement.json` and
`measure-checkpoint.py`. Agent compliance, recovery cost and quality remain
unmeasured; no model sessions ran and the rotation gate remains closed.

Codex extension measure, fixed before running: sample 20 inactive Kandelo
rollouts from November 1–6, stratified as ten main and ten child threads,
evenly by sorted path within each group. Exclude files modified in the last
hour, pin source hashes, compare the bounded parser to full-record latest
input usage and call each adapter twice with isolated cache state. Reject
changing source files rather than attributing a mismatch to the parser.
Apply the same 20/20, no tool decisions/user messages/repeated reminders,
under-2k-character reminder and 250 ms p95 operational gate. Add regressions
for cached-input/session-total confusion, compaction, parent/child identity,
parallel delivery, both Codex config representations and preserved trust
records. Codex registration is distinct from its required hook trust review.

The first replay stopped at a rollout without any token-count records.
The reference comparator was corrected to accept missing usage as an
explicit silent case, retaining the original 20 selected files. Report
available/missing usage counts separately; absence of usage is not a zero
context estimate or a reason to substitute a more convenient transcript.

Codex extension result (2026-11-07, local macOS, repository dev shell):
22 checkpoint/installer tests and six wait-guard tests passed. All 20
Codex rollouts matched the full-record reference: 19 had usage, one had
none and stayed silent. Five reminders were issued on first invocation,
none repeated across 40 calls. Median process time was 46 ms, p95 49 ms,
and longest reminder 1,093 characters. A fresh Claude replay still matched
20/20, with zero repeated reminders and p95 101 ms. Both adapters meet the
operational gate. Codex source hashes and raw measurements are local in
`.context/context-growth/codex-checkpoint-measurement.json`; replay uses
`measure-codex-checkpoint.py`. These are offline process/rollout checks,
not proof of live client compliance or reduced campaign cost. No model
sessions ran; automatic rotation remains gated by the quality trial.
