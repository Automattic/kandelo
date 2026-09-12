# Lane R1 — census of binary and artifact resolution

**Date: 2026-09-11. Status: complete.**

Lane R was scoped as "4,020 lines of `binary-resolver.ts`, target 500,
one resolver in Rust". **The census says the lane is real but it is not
that lane**: almost none of those 4,020 lines is what duplicates, and the
thing that actually duplicates is eight lines of path literal.

## What `host-native` actually reimplemented

Not the resolver. Its entire equivalent is **ten lines**:

```rust
const ARTIFACT_TIERS: &[&str] = &[
    "local-binaries/source-only-v1",
    "local-binaries",
    "binaries",
    "host/wasm",
];

fn artifact_path(file_name: &str) -> PathBuf { /* first existing tier */ }
```

The other 4,010 lines of `binary-resolver.ts` are **policy the native host
does not use**: per-tier identity, package closure rules, how a relative
path expands to candidates, source-only projection authority. That policy
is not duplicated anywhere, so a lane target of 500 — implying ~3,500
lines move — was wrong.

**What duplicates is the tier list and its order.** Nothing else.

## The duplication already caused a measured failure

`host-native`'s own comment records it, and it is worth quoting because
it is the strongest evidence in this census:

> These paths named `local-binaries/` alone. The resolver looks at
> `local-binaries/source-only-v1/` FIRST, and that is the tier a completed
> local build writes […] Measured after a `./run.sh setup` that exited 0:
> `local-binaries/source-only-v1/kernel.wasm` was a regular file built
> that afternoon and exported `kernel_thread_parent_tid_target`, while
> `local-binaries/kernel.wasm` was a symlink […] from seven hours earlier
> and did not. `cargo test -p host-native` failed **39 of 53** with
> `failed to find function export kernel_thread_parent_tid_target`
> against a tree where the build had just succeeded.

**This is exactly the failure mode lane R exists to close, and it has
already happened once.** It was fixed by making the Rust host mirror the
TypeScript tier order — by hand.

## The same fix already happened inside TypeScript, and did not hold

`host/src/binary-tiers.ts` exists because TypeScript itself had two
copies. Its own comment:

> The ROOTS and their order come from `binary-tiers.ts`, which the
> artifact reader's Node source reads too. […] it used to get them from a
> hand-maintained second copy that **drifted in both directions**.

So the repo has already diagnosed this defect, already applied the right
fix — extract the roots and order into one leaf module — and the fix
**stopped at the language boundary**. Rust then made a third copy.

## The real count: eight independent spellings

Production (non-test) occurrences of the source-only tier path:

| File | Spellings |
|---|---|
| `tools/xtask/src/local_build.rs` | 7 |
| `crates/host-native/src/lib.rs` | 2 |
| `host/src/binary-tiers.ts` | 1 |
| `tools/xtask/src/build_deps.rs` | 1 |

**Eight**, across the *writer* and both *readers*. `xtask local-build` is
what publishes into the tier, and it spells the destination seven times
independently of the two things that read it.

## The gate was measuring the wrong thing

`binaryResolverTypeScript` (4,020 → 500) would be satisfied only by
deleting policy that is not duplicated, and would be untouched by fixing
the duplication that is.

**Replaced by `artifactTierPathSpellings`** — independent production
spellings of the tier path. **Ceiling 8, target 1.**

## Revised increments

- **R1 — this census.** Done.
- **R2 — one declaration of the tier roots and their order**, in
  `crates/shared`, generated into TypeScript the way ABI constants already
  are. `binary-tiers.ts` becomes the generated consumer rather than a
  hand-maintained authority.
- **R3 — `xtask` writes to the shared constant**, closing the
  writer/reader split that caused the 39-of-53 failure.
- **R4 — `host-native` consumes it** and `ARTIFACT_TIERS` is deleted.
- **`binary-resolver.ts`'s policy is not lane R work.** It is not
  duplicated, the native host does not use it, and touching it would be
  scope the census does not support.

## Estimate

From **4–8 agent-days, medium** to **2–4 agent-days, medium-high**. The
lane is one shared constant and four consumers, not a resolver migration.

## What this census did not establish

- **Whether `binary-resolver.ts`'s 4,010 lines of policy are
  right-sized.** The census establishes only that they are not duplicated
  in Rust. They may still be too large; that is not lane R's question.
- **Whether the seven `local_build.rs` spellings are all the same concept.**
  They were counted by pattern, not read individually. R2 must read them.
- **Whether `host/wasm` (tier 4) has the same problem.** Only the
  source-only tier was counted.
