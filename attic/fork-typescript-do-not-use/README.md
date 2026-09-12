# Set aside — do NOT import, do NOT reuse

These files are the host-side fork implementation as it stood at commit
`312d27ce9`. They were moved here deliberately, and **the build is expected to
be broken** while they sit here.

**This snapshot SHRINKS, by design.** A file is deleted from it the moment its
replacement lands, because the lane's goal is that the original implementation
is deleted and not merely bypassed. So the set here is whatever has not been
replaced yet, not a complete copy of `312d27ce9`, and imports between the files
that remain may dangle. That is expected: nothing here is compiled
(`host/tsconfig.json` includes only `src`) and nothing here is a specification.

Deleted so far, with what replaced each:

| file | replaced by |
|---|---|
| `fork-module-host-capabilities.ts` | `host/src/fork-module-host-capabilities.ts` — the two host functions, with the Wasm capability floor recorded beside each |
| `fork-module-instance.ts` | `host/src/fork-module-instance.ts` — region reservation, PIC placement, the three reference-typed tables, the staging slab |
| `fork-reference-wire.ts` | nothing: its one live symbol was a hand-maintained twin of `crates/shared`'s `WPK_FORK_REFERENCE_TRANSACTION_OWNER`, which the ABI generator already emits |

## Why

The `2026-09-12-lane-f-migration-census.md` measurement: 19,791 live lines of
fork TypeScript, of which 9,050 were a second implementation of wire formats
Rust already implements, and 8,061 were orchestration the module does not own.
Only ~2,700 lines were a true engine floor plus a thin call layer.

Migrating file-by-file kept reproducing the same shape: an algorithm moved to
Rust, its data model and driver stayed in TypeScript. The maintainer's decision
was to invert the exercise — set the whole TypeScript implementation aside,
build fork capture and replay entirely in the Rust fork-module, and let the
required host imports be **discovered by what Wasm genuinely cannot express**
rather than inherited from what the TypeScript happened to do.

## The rule for this directory

**Nothing here is a specification and nothing here is a reference to port.** A
comment in these files asserting that something "must" be host-side is exactly
the claim the new work is supposed to test independently. Several such comments
have already been shown wrong.

Read them only to answer "what behaviour existed", never "how must it be done".

## What did NOT move, and why

- **`host/test/fork-*.test.ts` stay where they are.** They are the closest thing
  to a behavioural specification of what fork must do, and they should go red
  and stay visible. They are the acceptance target, not the implementation.
- **`worker-main.ts` (5,958 code lines), `process-lifecycle.ts` (3,359) and
  `kernel-worker.ts` carry fork logic inline** and could not be moved without
  taking the whole host with them. They must be reduced in place. Their fork
  content is not counted in the 19,791 above.
