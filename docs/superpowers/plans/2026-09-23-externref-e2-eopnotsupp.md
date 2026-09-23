# Externref stage E2: a fork carrying a host externref fails with EOPNOTSUPP

Decision (maintainer, 2026-09-23): fork keeps Wasm-GC and static-root
reference support and drops raw host externrefs. A host capability a guest
needs belongs behind a kernel object (fd/device), which fork already shares.
E1 (`a48708322`) deleted the cross-worker host-import transport (host
TypeScript only).
E2 removes the rest of the host-externref path on every host and makes the
boundary truthful.

## Behaviour after E2

- Capture: when the guest encodes a live externref, the existing order is
  unchanged -- the activation's own GC layouts are tried first, so an
  externref that wraps the program's own GC object (`extern.convert_any`)
  still captures as a GC node. Only a genuine host object reaches the
  host-handle fall-through, and that fall-through now fails the capture with
  `EOPNOTSUPP` inside the module (no host import is consulted).
- The existing seal-failure path turns the capture errno into `fork()`
  returning `-EOPNOTSUPP`, no child created, parent intact -- on Node,
  browser and native alike.
- Replay never meets an externref recipe, so the externref replay steps go.

## Removals (Rust)

- `crates/fork-module`: the `__wpk_fork_externref_handle` injector seam and
  the `__wpk_fork_host_externref_handle` host import; `resolve_externref`
  host import; `DRIVE_OP_EXTERNREF_TRANSIT` handling; `fm_externref_handle`,
  `externref_handle_impl`; the captured-externref set
  (`fm_captured_externref`, `fm_captured_externref_count`,
  `reset_captured_externrefs`); `EXTERNREFS_RESOLVED` stats field if nothing
  else reports through it (check the `fm_stats` field contract and its pin).
- `crates/fork-codec`: the externref node kind in the recipe graph only if
  no remaining path produces it (GC struct/array fields of externref type
  holding a host object must also refuse -- check `gc_codec`/`drive_plan`
  for externref leaves and make them refuse with EOPNOTSUPP at capture, not
  silently null).
- `crates/fork-module-inject`: the externref-transit shim and the
  `resolve_externref` import wiring.
- `crates/fork-instrument`: `externref_provenance.rs` (the
  production-site provenance wrapper pass) and
  `WPK_FORK_REFERENCE_IMPORT_PROVENANCE_EXTERNREF` in `crates/shared` if the
  pass has no other purpose. This changes the guest import contract: ABI 44
  is unreleased, so regenerate `abi/snapshot.json` (no ABI_VERSION bump) and
  rebuild every fork-instrumented artifact.
- `crates/host-native`: `ExternrefRegistry`, `define_resolve_externref`,
  the `__wpk_fork_host_externref_handle` binding,
  `EXPECTED_FORK_MODULE_HOST_IMPORT_COUNT` 7 -> 5;
  `smoke_fork_externref_reconstructs` becomes a test that the fork returns
  EOPNOTSUPP and the parent survives; keep/retarget
  `smoke_fork_gated_externref_parent_survives`.

## Removals (host TypeScript)

- `ForkExternrefTokenCache`, the broker's generations/leases
  (`createGeneration`/`acquireFork`/`closeGeneration`), the whole
  `fork-reference-broker.ts` and `fork-externref-process-owner.ts` if nothing
  else remains, `externrefGenerationId` in the worker protocol and
  worker-main, the captured-externref handover read/write
  (`writeCapturedExternrefHandover`, `EXTERNREF_HANDOVER_*`),
  `capturedExternrefHandles`/`stageExternrefHandover` in the backend,
  `resolve_externref` and `__wpk_fork_host_externref_handle` in
  `fork-module-host-capabilities.ts` and their bindings in
  `fork-module-instance.ts`, and the kernel-worker-side generation
  lifecycle in `process-lifecycle.ts` and both kernel-worker entries.
- Budget: `forkModuleHostImports` 7 -> 5 and every other surface this
  touches, all BANKED.

## Tests

- New, both JS hosts: a guest that holds a host externref (from a plain
  local host import) live across `fork()` gets `-EOPNOTSUPP`, no child, and
  continues -- through a real worker, not by poking the module.
- Native: the retargeted smoke test above.
- Keep green: GC/static-root/funcref/exnref fork tests, including an
  `extern.convert_any` GC-wrapping externref if a fixture exists (add one if
  not -- it is the case most at risk of being refused by mistake).
- Delete the externref reconstruction tests
  (`fork-module-externref-replay`, `fork-module-externref-capture-seam`,
  `fork-externref-handover`, `fork-externref-host-parity`,
  `fork-provenance-externref-wrapper`, broker/process-owner tests) once
  their behaviour is gone; fold anything still meaningful into the new
  EOPNOTSUPP tests.

## Docs

`docs/fork-reference-support.md`: externref moves to "unsupported
boundary: EOPNOTSUPP", with the reason and where host capabilities belong.
`docs/posix-status.md` if it lists fork reference kinds.

## Validation

Full rebuild (`./run.sh setup`, `scripts/build-programs.sh`,
`crates/host-native/fixtures/build-fixtures.sh`), `cargo xtask
verify-fresh`, `cargo test -p host-native` (compare against the 8
pre-existing `__wpk_fork_ref_gc_allocate` failures), `cargo test -p
fork-codec -p fork-instrument`, the fork sweep, the pthread/dlopen suites,
`abi` snapshot check, surface budget, and a browser fork test for parity.

## Existing coverage to keep and to adjust

- `crates/fork-instrument/tests/module_gc_codec_node.rs` already proves the
  most at-risk case: an `extern.convert_any` view of a GC object is encoded
  as the typed object, not given a host handle (`verify_externalized_cycle`,
  ~line 655). Keep it green. The same test stores a host token INSIDE a GC
  object and expects "one broker leaf"; under E2 that case must instead make
  the fork fail with EOPNOTSUPP -- split it so the externalized-view half
  stays and the embedded-host-object half asserts the refusal.
- `crates/fork-codec/src/reference_recipes.rs:41` `Externref { handle }` is
  the recipe node kind. Remove it only if every producer is gone; otherwise
  the decoder must reject it loudly.

## Left over from E1

- Doc comments naming deleted TypeScript files:
  `crates/wasm-artifact-module/src/lib.rs:15`,
  `crates/wasm-artifact-module/Cargo.toml:18`,
  `crates/fork-codec/src/exception_codec.rs:42`.
- `worker-main.ts` still requires `externrefGenerationId`, and the test
  helper `TestProcessReferenceOwners` still models generations.
