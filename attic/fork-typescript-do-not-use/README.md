# Set aside — do NOT import, do NOT reuse

These 39 files are the host-side fork implementation as it stood at commit
`312d27ce9`. They were moved here deliberately, and **the build is expected to
be broken** while they sit here.

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
