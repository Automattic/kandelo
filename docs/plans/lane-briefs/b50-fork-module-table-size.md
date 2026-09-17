# B50 — after the lane F merge, no process that forks can start

Paste everything below into the lane F agent.

---

Your lane's merge into `brandonpayton/rust-first-abi44-reconcile` landed as
`3ea310260` and **broke fork for every process**. This is that defect. The
filed record is `## B50` in `docs/plans/2026-09-11-MASTER-PLAN.md`; this brief
is self-contained.

## Where to work

Your existing worktree and branch:

    cd /Users/brandon/kandelo-lane-f          # brandonpayton/lane-f-fork-inversion

Fix it there and I will re-merge. Do not commit on
`brandonpayton/rust-first-abi44-reconcile` or
`brandonpayton/epoll-kernel-route`, and do not merge to main — the maintainer
is the sole merger.

## The failure

    fork-module: fork-module instantiation failed: LinkError:
    WebAssembly.Instance(): table import 1 is smaller than initial 2, got 0
      at instantiateForkModule (host/src/fork-module-instance.ts:600)
      at centralizedWorkerMain (host/src/worker-main.ts:3643)

## The module contradicts itself

`wasm-objdump -j Import -x host/wasm/fork_module32.wasm` on a freshly built
module:

    table[0] type=funcref initial=2 <- env.__indirect_function_table
    table[1] type=funcref initial=0 <- env.__wpk_fork_function_catalog

So the module's own import requires `__indirect_function_table` at
**initial=2**.

The host does not invent a size. It reads the module's `dylink` `MEM_INFO`
record — `host/src/fork-module-instance.ts:160-170`, the third LEB after
`memorySize` and `memoryAlign` — and passes it straight through at line 243:

    __indirect_function_table: new WebAssembly.Table({
      element: "anyfunc",
      initial: info.tableSize,
    }),

That parse yields **0**. The module therefore declares one number in its import
section and a different one in the `dylink` section it ships for exactly this
purpose, and the host believes the `dylink` section.

## Where to look first

`crates/fork-module-inject/src/main.rs` writes that section:

- `body.table_size(catalog)` at **line 635** and **line 740**
- `INDIRECT_TABLE_SIZE_IMPORT = "fm_indirect_table_size"` at line 174, with a
  thunk rewrite at line 753

The shape to check: `table_size` is being given the **catalog** table's size,
while the `initial=2` the linker emitted belongs to `__indirect_function_table`.
Those are two different tables — `table[1]` and `table[0]` — and the
`dylink` record describes the indirect one. Confirm that before changing
anything; this is a reading of the code, not a measurement.

## Ruled out already, by measurement

- **Not staleness.** The fork module and the kernel were both rebuilt in the
  same `./run.sh setup` that failed — the run reports `SUCCEEDED kernel/wasm32`
  and the module artifact is newer than the merge.
- **Not the merge resolution.** The five conflicts were `surface-budget.json`,
  `surface-budget.test.ts`, the plan's lane table, and two comment-only `.ts`
  hunks. No table or dylink code was touched by the resolution.

## Reproduce

    cd /Users/brandon/kandelo-lane-f
    ./scripts/dev-shell.sh bash crates/fork-module/build-wasm.sh
    ./scripts/dev-shell.sh bash -c \
      'wasm-objdump -j Import -x host/wasm/fork_module32.wasm | grep -i table'

If `initial=2` appears there while the host's `tableSize` parse gives 0, you
have it without a full build.

**The first question, and it decides whose defect this is:** does this
reproduce in YOUR worktree? Your closure reports six package tests red from an
unrelated pkg-config path defect, so a real fork may not have been exercised
after your final commits. If your worktree reproduces it, it is lane F's. If it
does not, say so immediately — then it is something the merge produces and I
need to know.

## Two findings from your own worktree, taken read-only 2026-09-16

**Your built module has THREE table imports; the merged build has two.**
`/Users/brandon/kandelo-lane-f/host/wasm/fork_module32.wasm` (built 15:01):

    table[0] funcref initial=2 <- env.__indirect_function_table
    table[1] funcref initial=0 <- env.__wpk_fork_function_catalog
    table[2] funcref initial=0 <- env.__wpk_fork_drive_table

The module built from the merge has no `__wpk_fork_drive_table` import at all.
`DRIVE_TABLE_IMPORT` is present in the source I merged
(`crates/fork-module-inject/src/main.rs:67`), so the same source produced
different modules — which points at the INJECTOR or its inputs, not at the
module crate. Check whether the merge's build ran a stale
`fork-module-inject`, or whether it takes an input that differs between the
two trees.

**Your branch has moved past what I merged.** I merged `56020b54a`; your tip
is now `046c7530f`, three commits further. If any of those three touch this,
say so first and I will re-merge rather than have you fix something twice.

## The guard that should have caught it

`host/test/fork-module-instance.test.ts` passes **6/6** against the broken
tree, because it exercises a fixture rather than the shipped
`host/wasm/fork_module32.wasm`. The surface budget was 109 green. Nothing
short of building and booting a real kernel catches this today.

**Add a test that instantiates the real artifact**, whichever way the defect
resolves. Perturb it until it fails — the natural perturbation is to write a
wrong `tableSize` into the dylink record and confirm the test refuses it.

## Non-negotiables

- Run `cd host && npx vitest run test/surface-budget.test.ts` **before every
  commit** and read its verdict lines. Use the `host/` form.
- **Gate on exit codes, never on piped output.** `./run.sh setup | tail` gives
  you `tail`'s status and reports success for a failed build.
- **Never raise a ceiling to make a check pass.**
- **Perturb every new guard until you have seen it fail**, and quote the
  failure text.
- **A perturbation that cannot reach the code proves nothing** (H-25). Confirm
  the code you changed is on the path the verifier exercises — that is exactly
  how this defect survived a green 109-test budget.
- If a fix does not work, revert it rather than leaving an unproven edit.
- ABI stays at **44**. No `ABI_VERSION` bumps.
- Deferrals are the maintainer's call. Land the safe part, then stop and argue
  it — what, why, cost, follow-up — and ask.

## Done looks like

`./run.sh setup` reaches real exit code 0 and `"outcome":"succeeded"`, with
`coreutils-docs`, `shell` and all six browser products building. Then say what
you did **not** establish — in particular whether the browser suite was run.

Your three standing provisional raises — `forkTypeScript` 890,
`forkPlatformTypeScript` 1631, `forkModuleHostImports` 6 → 7 — are **not** part
of this. The maintainer has left them outstanding deliberately, to be answered
before PR #1350 merges. Do not repay or re-argue them here.
