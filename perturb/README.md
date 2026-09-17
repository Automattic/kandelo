# Mutation trials

Specs for `xtask perturb`, which applies a source mutation, runs a verifier,
reverts, and reports. Run one with:

```sh
cargo run -q -p xtask -- perturb perturb/<spec>.json
```

## What a spec is for

Hazard H-2 says a guard that cannot fail is not a guard. These are the trials
that proved each guard in lane Y's image-builder work can fail — kept so the
proof survives the session that produced it, and so a future change that
quietly removes a guard is noticed rather than discovered later by a wrong
image.

A surviving mutant fails the run, because nearly always it means a missing
test. **Every trial here is expected to be KILLED**; a green run is the
contract.

## Accepted survivors are NOT encoded here

Three mutations in this work survive for reasons no test can remove, and they
are documented in the source next to the code rather than as always-red trials:

- `sm_alloc` dropping its `max(len, 1)` — the mutation is undefined behaviour
  that produces no observable wrong value.
- `sm_write_file` treating any `Ok` as success — the short-write branch is
  unreachable because `rootfs::write` never returns a short count; it defends a
  contract rather than an input.
- `chown` dropping its `-1` → `0xffff_ffff` mapping — behaviourally identical,
  because JavaScript coerces arguments to a wasm `u32` with ToInt32.

Encoding them here would make a committed spec permanently red, which teaches
people to ignore the gate. Keeping the reason beside the code keeps it where
the next reader already is.

## A mutation that does not compile is not a kill

Every spec carries a `build` command that must succeed before the verifier
runs. Without it, a mutation that fails to COMPILE is indistinguishable from
one the tests caught — both make `cargo test` exit non-zero — and the harness
reports "killed".

That produced a real false positive here. A trial replaced `rootfs::lstat` with
`rootfs::stat`, a function that does not exist, and was recorded as evidence
that a test detected symlink-following behaviour. It proved only that the
compiler rejected a typo. The trial is gone; the behaviour it was meant to
cover is asserted directly instead, by a test that checks a symlink reports
mode `0o777` rather than its target's mode.

An invalid mutation now fails the run, because a trial that proves nothing is a
gap in the evidence rather than a pass.

## A deleted guard takes its spec with it

`mkrootfs-sdef-guard.json` was deleted on 2026-09-17, four trials, when
`tools/mkrootfs/src/cli/sdef-reader-guard.ts` was deleted. The guard refused
any image whose deferred files the CLI's reader could not see, because the
verbs read with `MemoryFileSystem` (which sees `KLZY`) while the builder writes
`SDEF`; all three verbs read with `KandeloImageFs` now, so there is no second
reader left to disagree with.

The empty-file convention `deferred-until-v4.json` uses does not apply here.
That stub still names a file that exists, so `--validate` can read it; a stub
naming a deleted source is reported ROTTED on every run, which is the same
permanently-red gate this file warns against above. When the guarded code is
gone, delete the spec and leave the reasoning beside what replaced it — in this
case a retirement note in `tools/mkrootfs/test/builder.test.ts`, where the
three tests it verified used to be.

## Deferred is not accepted

`deferred-until-v4.json` holds two trials that are **not** part of the green
contract and are **not** accepted survivors either. They cannot be killed today
because the export turns base files and lazy members into empty stubs without
consulting its byte source — lane V's V4 hazard, reproduced and pinned in
`crates/kandelo-image-module/src/lib.rs`. When V4's identity contract lands, that source
becomes reachable and both trials become killable.

**They are the tests that will prove V4 is finished.** Move them back into
`kandelo-image-module-abi.json` then. The distinction from an accepted survivor is
worth keeping: one can never be killed, the other cannot be killed *yet*, and
collapsing them would lose the fact that someone owes work here.
