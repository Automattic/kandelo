# Stage T: delete fork code that only tests reach, and those tests

Decision (maintainer, 2026-09-23): fork-related code whose only callers are
tests is deleted together with the tests that exercise it. Where a JS test
proves behaviour that production relies on only through a test-only seam,
the behaviour must stay covered: either a Rust test already covers it, or
the JS test is rewritten onto production entry points. Runs after E2 (the
externref removal), so anything E2 already removed is skipped here.

## T1 -- host TypeScript used only by tests (census 2026-09-23)

Delete (verify each against the tree at the time; E1/E2 may have taken some):

- `host/src/fork-anyref-transit.ts` (whole file; `FORK_TRANSIT_STAGING_SLOT`
  dead). Six tests use `ForkAnyrefTransitTable` as a helper
  (fork-transit-relocation, fork-module-drive-shim, fork-module-drive-r1-trace,
  fork-module-gc-replay, fork-module-exnref-replay,
  host/test/fork-module-faithful-guest.ts): switch them to the module's raw
  exported table, as abi-version.test.ts:135 does. Delete
  fork-anyref-transit.test.ts.
- `host/src/fork-reference-capture-module.ts`: production calls only
  `begin()`. Fold it as `ForkModuleContinuationBackend.captureBegin()`
  (draft: scratchpad batch2.patch), delete the file and
  host/test/fork-capture-module-fixture.ts (imported by nothing).
- `fork-continuation.ts`: `invokeForkContinuationBegin`,
  `ForkContinuationGuestAddress`, `ContinuationAllocate`,
  `ContinuationDeallocate`; trim fork-continuation.test.ts.
- `fork-activations.ts`: `ForkActivations.get`, unread `module` field,
  written-never-read `staticRoots` map in the catalog sink.
- `fork-table-state-owners.ts`: `ownsState` (rewrite its 12 tests to observe
  the publish sink), `releaseActivation` (but see T4 bug 2 first -- dlclose
  may need it WIRED, not deleted).
- `vfork-lifetime.ts`: `activeCount`, `failedExecAttempts` and
  `noteFailedExec`'s ignored return value.
- `fork-module-instance.ts`: `transitTable` option; unread return fields
  `staticBytes`, `shadowStackBytes`, `gcTransitTable`, `capabilities`; the
  unread `ptrWidth` option.
- `fork-module-host-capabilities.ts`: `resolvedCount`,
  `distinctReferenceCount`, the `resolved` counter, `issued()`.
- `fork-replay-gate.ts`: `currentPhase` getter.
- `fork-guest-imports.ts`: `FORK_GUEST_HOST_OBJECT_IMPORTS`.
- `fork-resume-catalog.ts`: `FORK_RESUME_CATALOG_EXPORT`.
- `constants.ts:195` `wasmHasCompleteForkInstrumentation` and
  `wasm-artifact-driver.ts:977` `describeWasmForkArtifactContractFailures`
  (test-only; `wa_fork_contract` in wasm-artifact-module then has no JS
  caller -- check native) and their wasm-binary-parse.test.ts asserts.
- Both kernel-worker entries: remaining unused fork imports and destructured
  fields (`tsc --noUnusedLocals` lists them).
- worker-main.ts leftovers from the dead-code pass: optional fields of
  `ProcessDylinkActivationOwnerOptions` its two callers always supply;
  null guards that only narrow types (make the variables block-scoped
  consts); `initData.tlsOffset ?? initData.tlsAllocAddr` (deprecated field);
  unread `forkScratchAddr`/`forkScratchBytes` and `cwd` init fields.
- NOT fork, leave unless asked: `buildKernelImportsForTest`,
  `__testCreateProcessTableReplicationOwner`, the kernel-worker test hooks,
  the vfork start-failure fault injection (they exercise live code).

## T2 -- fork-module exports used only by tests (13)

`crates/fork-module/src/lib.rs`:
- Delete: `fm_arena_selftest` (its own doc sets the give-back condition, which
  is met), `fm_activation_module_buffer` (+ `activation_module_buffer_impl`;
  maintainer: no reason to keep -- the module builds the continuation
  manifest itself), `fm_module_state_arena` (+ `ForkChunkList::release_count`),
  `fm_capture_claim_gc`, `fm_capture_gated_placeholder` (+ fork-codec
  `push_gated_placeholder` and its test if nothing else calls it),
  `fm_capture_define_gc` (+ `CAPTURE_KIND_EXNREF`), `fm_capture_validate`,
  `fm_capture_serialize`/`_serialized_len`/`_record_header_size`
  (+ `CAPTURE_SERIALIZED`), `fm_capture_interned` (+ `CAPTURE_INTERNED`).
- Demote to internal (drop the export, keep the body):
  `fm_capture_intern`, `fm_capture_vector_get`.
- Tests: delete fork-arena-allocation.test.ts, fork-module-state-arena.test.ts;
  capture-graph JS tests are deleted where fork-codec Rust tests cover the
  logic (reference_segments_writer.rs, reference_graph_builder.rs,
  reference_transaction.rs; host-native GC smoke tests). The census lists 10
  files wholly dependent on `captureArena`/`captureGraph` -- for each, keep
  it only if it proves something no Rust test and no real-worker test does,
  and then rewrite it onto production entries (`__wpk_fork_ref_gc_*`,
  `fm_funcref_slot_to_recipe`, `fm_static_root_recipe`, `__wpk_fork_ref_exn_*`).
- Coverage gaps that MUST be closed on production entries before deleting
  the JS tests that cover them: the module's vector declared-count check
  (`__wpk_fork_ref_vector_*`), the record arena's duplicate (activation,
  kind) refusal and payload zeroing, "the module frees exactly what it
  mapped" (ForkChunkList). crates/fork-module has no Rust tests (wasm-only
  cfg) -- consider whether these belong as Rust tests of a host-buildable
  core instead of JS tests.
- `crates/fork-module/tests/harness-capture.mjs`: delete the ~200 lines
  that test only the removed exports; rewire the sections that used them to
  seed; keep the 13 sections that test production guest-facing exports.
- Budget: `forkModuleHostEntries` and
  `forkModuleEntriesWithoutProductionCaller` bank down by 13; the latter's
  prose about "pending capability" is corrected.

## T4 -- bugs found by the audits (reproduce first)

1. Table reconcile never wired: `archiveControlAddr`/`tableOwner` are never
   passed to `ForkModuleContinuationBackend`, so `fm_set_format` gets 0,0 and
   the module's `__wpk_fork_module_state_table_reconcile` always answers 0.
   After any dlopen publishes a generation, the guest's guard calls reconcile
   on every guarded table access and applies nothing. Probe: count reconcile
   calls in fork-dlopen-replay-e2e; then wire the address (host-native's
   comment at guest.rs:6484 states the requirement) and decide whether the TS
   `createProcessTableReplicationOwner` path becomes redundant.
2. dlclose leaves stale host state: `ForkTables`, `ForkTableStateOwners`
   (`releaseActivation` never called), the merged function catalog and
   `ForkMergedStaticRoots.registered` keep a closed activation.
3. `ForkMergedStaticRoots.clear()` is never called in production, so every
   fork pins the previous fork's static roots.
4. Possible: a static-root import in a fork child may bind null (read before
   `fill()`); and the module's dirty set is keyed on owner alone, so owner 1 of
   activation 0 and owner 1 of a side activation share a slot.
