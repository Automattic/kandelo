# Lane T5 — diagnosis of `fork-instrument-coverage.test.ts`

**Date: 2026-09-11. Status: complete.**

Lane T carried one open question: **41 of 49 suite timeouts live in this
single file — is that one defect or forty?** Until it was answered the
lane's estimate was "unknown until T5".

## CORRECTION (2026-09-12, during T6)

**The root cause stated below is wrong, and the error is kept rather than
edited out.** This census blamed the harness's 10,000 ms
`runCentralizedProgram` budget and called the file "marginal — 15% of
headroom, sinks under load."

Implementing T6 found the real binding limit: **Vitest's default
`testTimeout` is 5,000 ms** — `resolved.testTimeout ??= resolved.browser
.enabled ? 15e3 : 5e3` in the installed vitest 4.1.11 — and
**`host/vitest.config.ts` never set it.** Against an 8.4–9.6 s job that is
not marginal, it is **deterministic**: every test exceeded it on every
machine under any load.

The two clocks are different things and the census conflated them. The
harness's 10,000 ms bounds **the guest program's run** ("Program timed out
after Xms"); Vitest's bounds **the test's wall clock**, which includes the
per-test kernel instantiation that dominates the 8.5 s.

**What survives:** the measurements (8,409 / 8,506 / 9,573 ms), the finding
that all 41 pass when given room, and the conclusion that this is one cause
rather than forty. **What does not:** "marginal", "15% headroom", and
"sinks under load". It was always over.

**Why the error is instructive:** the census measured carefully and then
attributed the failure to the first timeout it found in the test file,
without checking whether a second, lower one applied. A number in the file
you are reading is not automatically the number that binds.

## The answer as originally written: neither

It is **a timeout budget set 15% above the measured cost of the work.**

Run on a quiet machine with `--testTimeout=20000`:

```
Test Files  1 passed (1)
     Tests  41 passed | 2 expected fail | 8 skipped (51)
  Duration  489.62s (import 49.55s, tests 371.16s)
  exited with code 0
```

**All 41 pass.** Nothing in the file is broken.

## The margin, measured

Per-test durations across the 34 tests the reporter timed:

| | |
|---|---|
| minimum | **8,409 ms** |
| median | **8,506 ms** |
| mean | **8,626 ms** |
| maximum | **9,573 ms** |
| over 8,000 ms | **34 of 34 (100%)** |
| over 9,000 ms | 4 |

**The harness default is 10,000 ms** — `timeout: expected.timeout ?? 10_000`,
commented "fork tests are short".

So the median test has **1,494 ms of headroom (15%)**, and the slowest four
have **under 500 ms**. Every test in the file sits just under the line, and
they all sit there *together*, because they all do the same work through
the same `runFixture` → `runCentralizedProgram` harness.

## Why it looked like forty defects

Because 41 tests share one cost profile and one budget, **any load pushes
all of them over at once**. The plan already records the hazard that
makes this routine: a package build takes the machine to load 100 and
invalidates every timing-sensitive check (H-7).

That also explains the observation that confused an earlier pass — "40
failed, 1 passed, and it reproduces in isolation, so it is not
contention." Both halves were true and the conclusion was still wrong.
It is not contention *in the sense of another process stealing the CPU*,
and it is not 40 independent defects either. **The file barely passes on
a quiet machine**, so isolation does not rescue it and load does not have
to be dramatic to sink it.

## The real finding: 8.5 seconds per test

The budget is the symptom. The question lane T should carry forward is
why a fork-coverage fixture costs **8.5 seconds**, when the fixtures
themselves are small C programs that fork and print.

41 tests × ~8.5 s = **371 s of test time**, plus **49.55 s of import**, for
a file that exercises fork instrumentation. The cost is flat across every
test — minimum 8,409 ms, maximum 9,573 ms, a 14% spread — which is the
signature of **fixed per-test setup dominating**, not of the fixtures
doing different amounts of work.

`runCentralizedProgram` stands up a kernel per test. That is the thing to
measure.

## Increments

- **T5 — this diagnosis.** Done, and partly wrong; see the correction above.
- **T6 — set `testTimeout` in `host/vitest.config.ts`. DONE**, as an
  explicit stopgap. Not the harness's 10 s budget, which was never the
  binding limit.
- **T7 — measure where the 8.5 s goes.** If it is per-test kernel
  instantiation, amortising it across the file is worth more than the
  timeout change and would cut ~6 minutes from one file.
- **T8 — re-examine the other 8 timeouts** outside this file. They were
  never the bulk and have not been diagnosed.

## Effect on lane T

The lane's headline — "one file carries 28% of failures" — was accurate
but pointed at the wrong cause. **The file is not failing; it is
marginal.** That changes the work from "debug 40 tests" to "make one
harness cheaper, and stop treating a 15% margin as a passing grade."

**Estimate: 5–10 agent-days at "unknown until T5" becomes 3–6, medium.**
T6 is an hour. T7 is the lane.

## What this diagnosis did not establish

- **Where the 8.5 s actually goes.** The flat distribution points at fixed
  setup; nobody has profiled it. That is T7 and it is the substance.
- **Whether the 8 non-`fork-instrument` timeouts share this cause.** They
  were not run — and with the true cause known (a 5 s default against slow
  tests) this is now much more likely than when the census was written. Any
  test in the suite costing over 5 s was failing for the same reason.
- **What the file costs under CI's machine**, as opposed to this one. The
  margin measured here is a best case.
