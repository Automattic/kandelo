# Lanes I and X — census of the two surfaces added without evidence

**Date: 2026-09-11. Status: complete.**

When the six new lanes were characterized, two **existing** lanes were
judged to have the same hole lane V had — a small gate on a large body —
and each gained a line-count surface with a guessed target:

- **Lane I** — `kernelHostImportTypeScript` (`kernel.ts`, 4,774 → 1,200)
- **Lane X** — `processExecTypeScript` (`process-lifecycle.ts` +
  `exec-target.ts`, 5,426 → 1,500)

Both guesses were mine and neither had evidence. **Both are wrong, in
opposite directions.**

## Lane I — the target was far too aggressive

`kernel.ts` implements the 72 host imports; its `host_*` definitions span
**3,771 of its 4,775 lines**. The question is what that job costs when
done well.

`crates/host-native` supplies the same surface through **71
`linker.func_wrap` calls**, spanning **7,646 lines** of `guest.rs`.

That span is interleaved with other code and is **not a clean
measurement** — it is an upper bound, not the cost of the imports alone.
But it is enough to refute the guess: **there is no evidence the import
implementations can shrink to 1,200 lines**, and the one host that does
the job in Rust does not do it in less.

**Lane I's real lever is the number of imports, not the lines per
import.** That lever already has a gate: `hostImportFunctions`, 72 → 40.

The line target is therefore re-derived as proportional to the import
reduction it accompanies: 4,774 × (40 / 72) ≈ **2,650**. That is a
consequence of the lane succeeding, not an independent goal, and the
surface's `why` now says so.

## Lane X — the surface was measuring the wrong thing entirely

`processExecTypeScript` counted `process-lifecycle.ts` (4,836) +
`exec-target.ts` (590).

**`process-lifecycle.ts` is `createProcessLifecycle<W>` — the shared
implementation both worker entries call**, and the E1 census credits it
as the consolidation that already happened: 72 members shared between the
browser and Node entries. **Shrinking it is not a goal; deleting it would
undo lane E's win.**

Meanwhile the exec-target authority has **already largely moved to the
kernel**. Eight exports exist —
`kernel_exec_target_prepare`, `_probe`, `_read`, `_size`, `_cancel`,
`_shebang`, `_resolve_shebang`, `_artifact_policy` — and what remains in
`exec-target.ts` is mostly **decoding what the kernel returns**
(`decodePreparedExecShebang`, `decodeExecTargetArtifactPolicy`,
`readPreparedExecTarget`) plus actually launching, which is a host
service.

So the "hole" was not a hole. A 12-reference gate
(`parseShebangReferences`) on this body is appropriate, because **the body
is the thing the campaign wants**.

**`processExecTypeScript` is withdrawn.** Lane X's closure returns to
`parseShebangReferences` → 0.

## The lesson, recorded because it cost two wrong gates

The heuristic "a small gate on a large body is a hole" produced one
correct catch (lane V, where `memoryFsTypeScript` really was unmeasured)
and **two false positives in a row**. A large body is only a hole if the
body is *wrong*. Lane X's body is the shared implementation the campaign
spent effort creating.

**Adding a gate is a claim about what should shrink, and it needs the same
evidence as any other claim.** Neither of these had it.

## What this census did not establish

- **What `kernel.ts`'s import implementations would cost done well.** The
  7,646-line `guest.rs` span is an upper bound with other code inside it;
  nobody has attributed lines to individual imports on either side.
- **Whether 2,650 is right for lane I.** It is arithmetic on the import
  reduction, not a measurement — and the surface says so.
- **Whether `exec-target.ts`'s 590 lines are all decoding.** The exported
  names were read; the bodies were not.
