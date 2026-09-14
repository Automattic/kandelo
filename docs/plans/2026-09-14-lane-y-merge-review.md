# Lane Y/V merge review — 2026-09-14

Reviewed `brandonpayton/lane-y-image-writer` @ `5fe08d499` for merge into the
campaign branch. The merge is **resolved and parked on
`scratch/lane-y-merge-eval` @ `42e1ed350`**, not landed: it turns on a
maintainer decision recorded below.

## Claims checked rather than trusted

Every structural claim in the lane's merge brief held:

| claim | verdict |
|---|---|
| merge-base `df968847e` | correct |
| 106 files changed on the lane side | correct |
| `Cargo.lock` and `docs/surface-budget.json` auto-merge | correct |
| `tools/xtask/src/perturb.rs` is the single conflict | correct |
| merged budget: `sffsModuleEntryPoints` 22, `kernelWorkerTypeScript` 32717, `memoryFsTypeScript` 8141, `committedBinariesWithoutProducer` 15 | all four correct |
| `cargo check -p xtask` passes after resolution | correct, with `--target aarch64-apple-darwin` |

The conflict resolution the lane specified is right, and is not the obvious
one: the sentinel removal must precede the `Ran::TimedOut` match, because a
trial that hangs takes the `continue` and would otherwise leak its sentinel
into the next trial.

`cargo check -p xtask` fails with a bare invocation because `.cargo/config.toml`
sets `target = "wasm32-unknown-unknown"`, so `zstd-sys` tries to assemble an
amd64 `.S` for wasm. That is the environment, not the merge.

**Lane Y's closure condition is met**: `imageBuilderFilesystemImporters`
36 -> 0. This settles the discrepancy raised earlier the same day, where the
lane was being described as closed while its gate stood untouched at 36.

## The decision this merge turns on

`sffsModuleEntryPoints` was raised **19 -> 20 -> 21 -> 22** across the lane.
At the merge-base that surface had `ceiling` 19, `slack` 0 and `target` 19 —
sitting exactly on its goal.

It was **not raised silently.** Each step carries a written argument in the
budget's own `why`, and each records a search for an export that could be
retired instead, including two folds considered and rejected with reasons:
`sm_mkdir`/`sm_mkdir_parents` would make a boolean decide which path a call
operates on, and folding `sm_image_read` into `sm_export_image_read` would
make a flag decide whether a read mutates the tree it is reading.

Perturbed to confirm the raise is not cosmetic:

```
sffsModuleEntryPoints is 22, above its ceiling of 21.
memoryFsTypeScript is 8141, above its ceiling of 8140.
```

The module genuinely declares 22. **There is no version of this merge that
keeps 19** — refusing the raise makes the merge red.

What is being bought is not yet banked. The lane argues the twenty-second
entry retires `MemoryFileSystem`'s last runtime role and deletes roughly
11,900 lines of a format implemented twice, but that deletion is not in this
merge and the lane says so plainly: *"what is complete is the unblocking, not
the deletion."* `memoryFsTypeScript` falls only 8501 -> 8141 here. The
maintainer would be accepting a permanent +3 on the image builders' ABI
against a promised reduction.

One distinction worth keeping: `sffsModuleEntryPoints` counts the Rust
module's `sm_*` exports, which is the image builders' call surface. It is a
real surface, but it is not the runtime host API a second host must
reimplement, so it is not the V4 surface.

## A stale expectation in the brief

The brief predicts `surface budget 81/81`. The merged tree yields **85
passing**. The four extra tests are `committedBinariesWithoutProducer`, the
lane N surface added on the campaign branch after the lane forked. 85 is the
correct post-merge number; 81 is not evidence of damage.

## What this review did NOT establish

Only the static surface-budget gate was run. The lane's post-merge rebuild
(`crates/sffs-module/build-wasm.sh`, then `./run.sh setup`) was **not** run,
and neither were `cargo test -p runtime-core`, `cargo run -p xtask -- perturb
--validate`, nor the browser suite. The lane's figures of 167 passed / 14
failed in the browser, 2175+ runtime-core tests, and 291 perturb trials are
therefore **unconfirmed here**. They must be run before any completion claim,
in the order the lane gives, because a stale module artifact surfaces later as
"Package artifact closure is incomplete" in unrelated browser specs.
