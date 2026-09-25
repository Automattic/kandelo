> Status: APPROVED WITH RULINGS (2026-09-25) — see "Maintainer rulings" at the end; they override the open questions. Measured at fabc04f52; since then 3d214db8a merged image/cache-key and suite/ABI-marker work, which does not change the fork-module entry surface or the numbers below. Open questions at the end need rulings before stage 1a starts.

# Lane F super plan: one fork path in Rust for Node, browser and host-native

All numbers and line references are from commit `fabc04f52`, read with `git show`. I didn't edit, build or run anything. Code-line counts use the counter in `host/test/surface-budget.test.ts` (`codeLinesInSource`), which I re-implemented read-only.

One input path was wrong in the brief. The prior admit brief is `docs/plans/2026-09-16-fork-admit-activation-brief.md`, not `docs/superpowers/plans/…`.

---

## Why

Today the fork sequence is written three times: once in `centralizedWorkerMain`, once in `centralizedThreadWorkerMain`, and once in `crates/host-native/src/guest.rs`. Each host calls a fine-grained `fm_*` entry for each fact and each phase. Every such entry leaves a seeding loop behind in every host. The copies have already drifted in ways that break things:

- **Two reference graphs on native.** Native feeds its own `NativeReferenceCapture`, while the module's parent replay reads the module's own builder. This breaks native fork with references.
- **A different child protocol on native.** Native uses `fm_begin_reference_replay` + `fm_build_gc_plan` + `fm_child_reconstruct`. The JS hosts use `fm_attach_child`, whose plan also drives module-state restore and finish.
- **Missing seeds on native.** Native never seeds the exception codec, the host-exception owner or the table-state owners.

Lane F's goal is that Node, browser and host-native all run one fork sequence written in Rust. Hosts should supply only what they alone can:

- Worker spawn.
- Wasm instantiation, including `__wpk_fork_host_materialize_dlopen_archive`.
- JS object identity.
- The child import-object Proxy.
- `Table.set` / `Table.get` for reference values.
- The trap guard.

## Measured baseline

### The closure conditions

| surface | now (= banked ceiling) | closure | status |
|---|---|---|---|
| `forkTypeScript` (`host/src/fork-module-*.ts`) | 623 | ≤ 2500 | **already met.** Backend 414, instance 169, host-capabilities 40. The 2500 bound looks like a relic of the old glob; see open question 1 |
| `forkModuleHostEntries` | 43 | ≤ 5 | the binding constraint |
| `workerMainForkTypeScript` | 2802 | ≤ 1200 | the binding constraint. Whole file 5001, minus 2199 in `WORKER_MAIN_OTHER_LANES` |

Related surfaces that will move:

| surface | ceiling | makeup |
|---|---|---|
| `forkPlatformTypeScript` | 1349 | 11 named files |
| `forkRestoredHostFloor` | 664 | `fork-continuation` 131, `fork-merged-static-roots` 23, `fork-replay-gate` 166, `fork-resume-catalog` 70, `vfork-lifetime` 274 |
| `forkModuleEntryPoints` | 56, slack 2 | |
| `forkModuleInjectorHelpers` | 13 | |

### The 43 host entries, grouped by role

The split checks out as 56 − 13 injector-only = 43. Callers: TS = `host/src`, N = `crates/host-native`. Line numbers are declarations in `crates/fork-module/src/lib.rs`.

| role | entries | callers |
|---|---|---|
| **Activation seeding and placement** (11) | `fm_set_format` 7902 | TS, N |
| | `fm_set_activation_resume_catalog` 8100 | TS, N |
| | `fm_set_activation_template_id` 2733 | TS, N |
| | `fm_set_activation_gc_codec` 8173 | TS, N |
| | `fm_set_activation_exception_codec` 3087 | TS |
| | `fm_set_activation_imports` 2634 | TS |
| | `fm_set_host_exception_owner` 8223 | TS, N |
| | `fm_place_activation_catalog` 8133 | TS, N |
| | `fm_place_activation_static_roots` 8144 | TS, N |
| | `fm_drive_table_base` 8376 | TS, N |
| | `fm_publish_resume_assignment` 11973 | TS, N |
| **Identity and election** (3, host-only facts) | `fm_set_identity_group` 1555, `fm_set_import_provenance` 2485 | TS |
| | `fm_set_activation_table_state_owner` 8064 | TS; N only in a comment |
| **Parent lifecycle** (9) | `fm_capture_begin` 8847, `fm_parent_begin_capture` 8607, `fm_parent_seal_capture` 8526, `fm_journal_image_len` 7938, `fm_parent_abort_seal` 8672, `fm_parent_replay` 8448, `fm_parent_finish` 8703, `fm_abort` 7949, `fm_borrowed_replay_workspace` 11647 | |
| **Child install** (8) | `fm_set_borrowed_workspace` 8215, `fm_child_seed` 7988, `fm_child_seed_borrowed` 8028, `fm_attach_child` 11504 (TS only), `fm_gc_plan_count` 8405 | |
| | `fm_begin_reference_replay` 8244, `fm_build_gc_plan` 8389, `fm_child_reconstruct` 8492 | N only |
| **Child-side lookups** (6) | `fm_decode_reference_graph` 10981, `fm_decoded_node_field` 11058, `fm_funcref_ordinal` 8259, `fm_static_root_slot` 8271, `fm_child_import_plan` 11374, `fm_child_import_plan_field` 11411 | the last two are TS only |
| **Peer tables** (2) | `fm_capture_peer_tables` 11345, `fm_restore_from_arena` 11463 | |
| **Release** (1) | `fm_resume_slots` 11895 | |
| **Diagnostics** (3) | `fm_phase` 5612, `fm_stats` 11781, `fm_last_errno` 11988 | |

### Fork TypeScript per file (code lines)

- **Module-facing:** `fork-module-backend` 414, `fork-module-instance` 169, `fork-module-host-capabilities` 40.
- **Thin layer:** `fork-child-imports` 320, `fork-import-identity` 223, `fork-activations` 182, `fork-guest-sections` 167, `fork-guest-imports` 138, `fork-child-references` 98, `fork-table-state-owners` 70, `fork-resume-table` 63, `fork-tables` 49, `fork-phase` 28, `fork-mechanism-trace` 11.
- **Restored floor:** `vfork-lifetime` 274, `fork-replay-gate` 166, `fork-continuation` 131, `fork-resume-catalog` 70, `fork-merged-static-roots` 23.
- **Total `fork-*` / `vfork-*`:** 2636.

### `worker-main.ts` fork share (2802)

| declaration | code lines | location |
|---|---|---|
| `centralizedWorkerMain` | 1225 | 3065–5121 |
| `centralizedThreadWorkerMain` | 747 | 5874–6808 |
| `createProcessDylinkActivationOwner` | 221 | 793–1080 |
| `createProcessTableReplicationOwner` | 79 | |
| `sendForkSyscall` | 49 | |
| `continuationMmap` / `continuationMunmap` | 47 / 35 | |
| `hasCompleteForkInstrumentation` | 44 | |
| `createForkPeerTableCheckpoint` | 23 | |

`centralizedWorkerMain` also contains two branches that are not fork logic but are counted: the WASI branch (about 90 lines) and the uninstrumented branch (about 110 lines).

### host-native fork sequencing in `guest.rs` (non-comment lines)

| code | lines | location |
|---|---|---|
| Section parsers + `GuestForkFormat` | 118 | 5360–5579 |
| `ForkEntry` / `ForkCoordState` / `NativeReferenceCapture` | 283 | 5580–6184 |
| `ForkModule` + `instantiate_fork_module` + `place_resume_thunks` | 324 | 6185–7034 |
| Launch-time seeding | ~165 | 7300–7600 |
| `kernel_fork` closure | ~74 | 7780–7910 |
| Native capture-import host functions (`gc_lookup` / `gc_claim` / `gc_define`, …) | 415 | 8380–9000 |
| Drive bind + reference replay | 170 | 9404–9751 |
| `run_fork_capable_entry` | 208 | 9752–10149 |
| Seal + launch | 195 | 10150–10520 |
| Module-state arena writer | 82 | 1510–1659 |
| Static-root / GC provenance registries | 206 | 4848–5250 |

That is about **2,200 code lines**, plus a thread duplicate in `run_worker_thread` (10680–11233; fork seeding at 10807–10970).

The native `fm_*` order today:

1. `fm_set_format` → `fm_set_activation_resume_catalog` → `seed_activation_template_id` → `fm_set_activation_gc_codec`, at launch (7504–7590).
2. `place_resume_thunks`, then `bind_fork_phase_flip_drive_table`.
3. In `kernel_fork`: `fm_capture_begin` → `fm_parent_begin_capture(ch, empty_module_state_root, 0, 0)` (7874).
4. On the unwind exception: `fm_parent_seal_capture` → `fm_journal_image_len` → **native `write_module_state_arena` of its own graph** (10224) → SYS_FORK → `fm_begin_reference_replay(empty_root)` + `fm_build_gc_plan` + `fm_drive_execute` → `fm_parent_replay`.
5. Child: `fm_child_seed(empty_root, root)` → `drive_reference_replay` → `fm_child_reconstruct` (9848–9890).
6. Borrowed child: `fm_set_borrowed_workspace` → `fm_child_seed_borrowed(arena_root, …)` → `fm_child_reconstruct`.

---

## Step 1: coarse entries

### Starting point: the prior brief's objection

The 2026-09-16 brief proved two things. The module cannot read the guest *image*: it is up to 53 MB, and the staging slab is 192 KiB (`fork-module-instance.ts:113`). And locating a section is two host lines (`WebAssembly.Module.customSections`).

The maintainer's "section-byte parsing moved into Rust" is therefore the shape to build:

- **The host locates** each section and stages its **bytes**.
- **The module decodes and validates** them.
- **The host keeps** only facts it alone owns: template id (SHA-256 of the image), activation id, catalog table lengths, and object identity.

The brief's test still applies to every sub-stage: *does a new host end up knowing less?* It does here. The host stops decoding four formats (linked frames, module-state descriptor, resume catalog, the exception-owner derivation). It stops sequencing about 10 seed calls. It stops doing base arithmetic.

### 1A. `fm_admit_activation`: descriptor

This is a new codec in `crates/fork-codec/src/activation_admission.rs`, shared by the module and by host-native. The TS writer is about 25 lines, pinned against the codec by a test in the style of `fork-module-backend.test.ts`. It is staged in the slab; all fields are little-endian.

```
AdmissionHeader (fixed, 64 bytes)
  magic "KFAA" u32, version u16, header_size u16
  activation_id u32          HOST   (dylink claims ids; 0 = main)
  flags u32                  HOST   bit0 BORROWED_CHILD (no identity publish),
                                    bit1 FORK_CHILD
  template_id [32]u8         HOST   SHA-256 of image (cannot enter memory)
  section_count u32
SectionRef[section_count] { kind u32, offset u32 (from descriptor start), len u32 }
  kind: LINKED_FRAMES | MODULE_STATE | RESUME_CATALOG | GC_CODEC |
        EXCEPTION_CODEC | IMPORTED_GLOBALS (KFIG) | IMPORTED_TABLES (KFIT)
  bytes: HOST locates (customSections / native wasmparser), copies verbatim
```

**Derived by the module**, where the host does it today:

| fact | today |
|---|---|
| ptr width + `fixed_prefix_size`, with the full format check | `readLinkedFrameFormat`, `fork-continuation.ts`, ~70 lines |
| module-state ptr-width check | `readForkModuleStatePointerWidth`, `fork-guest-sections.ts`, ~35 lines |
| resume ordinals, plus the ordinal == local-slot check native does (`guest.rs:5540`) | |
| GC and exception codecs | |
| the host-exception owner: smallest admitted activation that has an exception codec | `worker-main.ts` ~4180; native never seeds it |
| KFIG/KFIT seeding, keeping today's "same bytes = no-op" rule | `fork-import-identity.ts:seedActivationSections` |

**Replaces:**

- `fm_set_activation_resume_catalog`
- `fm_set_activation_template_id`
- `fm_set_activation_gc_codec`
- `fm_set_activation_exception_codec`
- `fm_set_activation_imports`
- `fm_set_host_exception_owner`

`fm_set_format` shrinks to per-worker facts only: `(archive_control_addr, channel_base)`. Pointer width and `fixed_prefix` come from activation 0's admission. The name is kept, and it must be called first, as today.

**Returns** 0 or errno, like other seeds.

Admission happens **before instantiation**, which is where `setup()`, `prepareActivation` and the child planner already seed. Every fact the child and the parent need is then present from one call.

### 1B. `fm_bind_activation`: post-instantiation placement, packed row out

`fm_bind_activation(activation_id, func_catalog_len, static_root_len) -> ptr`

It returns a module-owned row, like `fm_publish_resume_assignment`:

```
{ drive_base u32, func_catalog_base u32, static_root_base u32,
  resume_ptr u32, resume_count u32 }
```

The host needs this row because it performs the reference-typed floor:

- `Table.set` of the drive bindings (`bindActivationDrive`).
- The funcref catalog copy (`forkActivationCatalogSink.registerCatalog`).
- Static-root mirror sizing (`ForkMergedStaticRoots.take`).
- The guest's `__wpk_fork_place_resume_thunks(ptr, count)`.

**Replaces** `fm_place_activation_catalog`, `fm_place_activation_static_roots`, `fm_drive_table_base` and `fm_publish_resume_assignment`.

Net effect of 1A + 1B: 10 entries become 2, so **43 → 35**.

### Sub-stages for 1A/1B

Each is one or two commits.

**1a. Rust (additive).**
- Write the codec, decoders and module entries. Old entries stay alive. fork-codec already has `catalogs.rs` and `module_state.rs`; the linked-frame descriptor decoder moves out of `fork_contract.rs` / `guest.rs` into fork-codec.
- Tests: fork-codec unit tests with hand-perturbed descriptors (bad magic, duplicate kind, wrong ptr width, ordinal ≠ slot) must each fail.
- Validate with `cargo test -p fork-codec -p fork-module-inject`, then build the module with `scripts/dev-shell.sh bash crates/fork-module/build-wasm.sh`.

**1b. TS switch.**
- `ForkModuleContinuationBackend`: `setup()` and the six `setActivation*` / `place*` methods become `admitActivation(desc)` + `bindActivation()`.
- `ForkActivations.register` calls bind and uses the row.
- Remove `fixedPrefixSize` from `ForkActivation`, and drop `sides()` / `stageSides`. The module already knows each admitted activation's prefix, so `fm_parent_begin_capture` and `fm_child_seed` can ignore `sides_ptr`. That signature change lands in 1d.
- Delete `fork-resume-catalog.ts` (70) and the reader half of `fork-continuation.ts` (~70; `writeForkContinuationAnchor` / `readForkContinuationAnchor` stay).
- Delete `readForkModuleStatePointerWidth` and `readForkModuleStateRoot` (the root read can move into `fm_child_install`, stage 1e).
- Delete the section scans in `worker-main.ts` (4140–4190) and the GC/exception seeding loops in the install block (~4560–4610).
- In `createProcessDylinkActivationOwner`, delete the format and ptr-width checks and the resume-catalog seed (843–880). Its thread twin goes too (6074–6113).
- Both worker paths change in the same commit, because `worker-main` is shared by Node and browser.

**1c. host-native switch.**
- Replace `read_linked_frame_fixed_prefix_size`, `read_fork_resume_catalog_records` and `read_gc_codec_descriptor_section` with a section *locator* built on the already-present `wasmparser` dependency (about 20 lines). This also deletes the hand-written `find_custom_section` / `read_leb_u32` walk.
- `GuestForkFormat` shrinks to `{template_id, sections}`.
- Replace the three per-purpose scratch pages (catalog, GC codec, template id; 6600–6700) with one one-page staging slab plus `fm_admission_buffer` for larger admissions, mirroring TS. Note this touches the `compute_fork_module_region` math.
- Replace `place_resume_thunks` and `bind_fork_phase_flip_drive_table` with `fm_bind_activation`.
- Side effect: native gains exception-codec and host-exception-owner seeding for free, which is a parity fix.
- 1b and 1c can run in **parallel worktrees** after 1a.

**1d. Delete the old entries.**
- Remove the 10 old `fm_*` entries and the `sides` arguments.
- Bank `forkModuleHostEntries` (43→35) and `forkModuleEntryPoints` (56→48).

**Budget effect of 1a–1d (estimates):**

| surface | change |
|---|---|
| `forkPlatformTypeScript` | −170 to −200 (`fork-guest-sections` loses its decoders and keeps SHA-256 + root read; activations, import-identity and resume-table shrink) |
| `forkRestoredHostFloor` | about −140 |
| `forkTypeScript` | about −80 |
| `workerMainForkTypeScript` | about −120 |
| host-native | about −250 lines |

**Tests** (through real workers and guests):

- Existing: `fork-dlclose-activation`, `fork-activation-release`, `fork-dlopen-replay-e2e`, `fork-from-dlopen-side-module-e2e`, `fork-module-backend.test.ts` (re-pin drive-slot and row layout), `fork-module-staging-rewind.test.ts` (the admission mapping).
- New: `fork-admission-refusal.test.ts`. It admits a real instrumented guest whose staged linked-frame bytes are corrupted, and expects the named errno at admission, not at capture.
- Mutation check: remove each module-side validation (ptr-width mismatch, ordinal/slot check) and confirm the test fails. Record the build key per mutation.
- Native: re-run the full `cargo test -p host-native --target aarch64-apple-darwin`. The bare command runs zero tests and exits 101. Passing set must be ≥ 56.

**Risks:**

1. **Slab capacity.** RESOLVED 2026-09-25. 1b first grew the slab to four pages to fit intl.so's 252,753-byte admission. The maintainer then chose a one-page slab plus `fm_admission_buffer(len)`: the module maps an exact-size buffer for a larger admission (php.wasm, php-fpm.wasm, intl.so) and `fm_admit_activation` releases it, accepted or refused. Every non-php admission measured fits one page (largest wget.wasm, 54,880 B). Intended to fold into one module-owned staging entry that answers from a module-owned slab when a request fits.
2. **COW children.** A copied child inherits the parent's module region and re-admits. Every section seed must be a byte-compare no-op. The GC codec seed currently refuses a re-seed with EINVAL (`set_activation_gc_codec_impl`), so change it to a byte-compare.
3. **Parent seeding change.** GC and exception codecs are now seeded on the **parent** too, where today they are seeded only in the child. Check that the capture reads nothing differently.

### 1E. Child install: `fm_child_install`

```
fm_child_install(pid, borrowed_base, borrowed_bytes) -> 0 | errno
```

The module:

1. Reads activation 0's launch root from the archive control word it already knows (`archive_control_addr`), and the module-state root from that root's prefix. `readProcessLaunchRoot` and `readForkModuleStateRoot` both leave the host. A borrowed child's launch root is its owner's `forkBufAddr`; it is already passed as `forkOwnerControlAddr` through `fm_set_format`.
2. Carves the borrowed workspace when `borrowed_bytes` is non-zero.
3. Runs `child_seed` or `child_seed_borrowed`, then `attach_from_arena_impl` (7324). That covers seed, exnref admission, adopting the inherited arena, reconstruction plus attach steps, and rewind-begin.
4. Grows its own `__wpk_fork_ref_gc_transit` to the plan's max recipe + 2. This needs an injected `table.grow` shim. Native does the growth in Rust today (9690–9730); TS relies on capture-time growth.
5. Drives the plan through the existing drive shim.
6. Nulls the static-root mirror afterwards with the existing `__wpk_fork_table_null` shim. This deletes `worker-main.ts:4668–4675`.

**Replaces** `fm_set_borrowed_workspace`, `fm_child_seed`, `fm_child_seed_borrowed`, `fm_attach_child` and `fm_gc_plan_count`. On native it also replaces the host calls to `fm_begin_reference_replay`, `fm_build_gc_plan` and `fm_child_reconstruct`. Those three move to injector-only or are deleted. Net **35 → 28**.

This single entry also removes the native/JS child-protocol divergence. Native currently never drives the attach steps (module-state restore/finish), so a native child never restores guest global/table state. That is directly relevant to step 4.

What stays host: `forkMergedStaticRoots.fill` before install. It is a reference `Table` copy. Optional stage 1k removes it.

**Sub-stages:**

- **1e.** Rust entry + injected grow shim. `fork-module-inject` gets one helper; `forkModuleInjectorHelpers` may rise by 1, which that surface allows.
- **1f.** TS switch. Collapse `installChild` / `driveRestoredPlan` and delete the borrowed-workspace plumbing in `worker-main` (3230–3260).
- **1f-native.** Native `ChildReplay` / `ChildBorrowedReplay` both call `fm_child_install`. This is sequenced with step 4b (below), because install reads the **module's** arena and native parents still write their own.

**Tests:**

- Existing: `fork-memory-clone-guest`, `fork-borrowed-replay-workspace`, `exnref-local-fork-fresh-worker`, `funcref-/static-root-/gc-view-*-fork-fresh-worker`, `fork-module-exnref-replay`.
- Browser: `vfork-lifecycle` (9), `gc-reference-cycle-fork-module-worker`.
- New: a transit-growth test. The child's plan has a max recipe above the inherited transit length. Perturb by removing the grow call; it should trap.

### 1G. Child-side lookups: `fm_child_plan`, packed rows

```
fm_child_plan() -> ptr  // header {activation_count, row_count, order_ptr}
Row (24 B): { activation u32, import_ordinal u32, resolve u8, type_code u8,
              flags u16, a u32, b u32 /* or bits_lo/hi */ , dep_activation u32 }
resolve ∈ RAW_F64 | RAW_I64 | NULL | FUNC_CATALOG_SLOT(a) | STATIC_ROOT_SLOT(a)
         | PROVIDER_GLOBAL(a=activation,b=owner) | PROVIDER_TABLE(...)
         | SAVED_BASE_SCALAR(bits) | KEEP_BASE
```

**Built from pieces the module already has:**

- the decoded graph (`decode_reference_graph_impl`);
- `child_import_plan`;
- `requireCompatible` (the kind × declared-type admissibility, `fork-child-references.ts`);
- `dependenciesFor` / `instantiationOrder` (the module holds both provider edges and reference owners, which the header of `fork-child-imports.ts` says only the host had);
- the duplicate-base-import agreement check (`savedMutableGlobalImport`).

**Replaces** `fm_decode_reference_graph`, `fm_decoded_node_field`, `fm_child_import_plan`, `fm_child_import_plan_field` and the host's use of `fm_funcref_ordinal` and `fm_static_root_slot`. The last two remain injector helpers. Net **28 → 23**.

**What the host keeps:**

- The Proxy with positional reads (`importsForActivation`).
- `Table.get` on catalog slots.
- The provider export lookup.
- One archive-order equality check. Even that could move by staging the archived order into the call.

`fork-child-references.ts` (98) is deleted. `fork-child-imports.ts` drops from 320 to about 140. In `worker-main.ts`, 4249–4295 drops to about 10 lines.

**Tests:** `fork-child-imports.test.ts` becomes a real-guest test, plus `fork-dlopen-replay-e2e` with a provider cycle; the module must refuse it with a named errno. Perturb the order algorithm. This stage is TS only; native has no multi-activation child imports.

**Runs in parallel with** 1e/1f after 1d.

### 1H. Identity: `fm_publish_bindings`

```
fm_publish_bindings(activation, rows_ptr, count)
```

Each row is one observation, "slot X of activation A is object-group G":

```
{space u8, role u8 (EXPORT_CATALOG | IMPORT), ordinal_or_owner u32,
 kind u8, group u32, bits u64}
```

This is **one abstraction**: what object a catalog export or import resolved to. It is not a mixed dispatch, so it passes the §195 test.

**Replaces** `fm_set_identity_group` and `fm_set_import_provenance`, and **deletes** `fm_set_activation_table_state_owner`. The module elects the table-state owner itself, as the lowest `(activation, owner)` in each table-space group. The host already publishes those groups from the same walk (`ForkImportIdentity.publishCatalogs`). `ForkTableStateOwners` (70) shrinks to about 10 lines. `ForkTables.markTableMutation` keeps a `WeakMap<Table, group>` and passes the group; the module maps it to the canonical owner inside `__wpk_fork_module_state_table_dirty_mark`. Net **23 → 21**.

- **Native:** publishes one group per private `__wpk_fork_table_N` export. That is exactly the missing election behind the ignored `smoke_fork_externref_table`.
- **Tests:** `dlopen-pthread-table-replication`, `fork-import-identity`, `fork-identity-release`, plus a new aliased-table test: two activations import one Table and a dlclose re-election occurs. Perturb the election to pick the highest coordinate.
- **Risk:** the ordering of elections against `releaseActivation`. Today the host publishes the "false" updates before the "true" ones (`elect`). The module must do the same internally.

### 1I. Parent lifecycle folds (both hosts)

- **Fold `fm_capture_begin` into `fm_parent_begin_capture`.** Every host calls them back to back (TS 3960 / 6300; native 7874 / 10950).
- **Seal returns a packed row.** `fm_parent_seal_capture` returns `{image_ptr, image_len, borrowed_prefix_bytes, borrowed_scratch_bytes}`. This deletes `fm_journal_image_len` and `fm_borrowed_replay_workspace` as host calls.
- **Mid-unwind abort moves into the module.** The injected `__wpk_fork_frame_reserve`, on a 0 result, performs abort-seal + abort-replay itself and records the errno. `fm_parent_finish(abort=1)` then returns that errno.
  - This deletes both host wrappers (`worker-main.ts:4340`, `6479`), `forkAbortErrno` / `threadForkAbortErrno`, and `fm_parent_abort_seal` as a host entry.
  - It also closes a native gap: native never wrapped reserve, so a native mid-unwind ENOMEM is unhandled today.

Net **21 → 17**. Tests: P-11 (`p_11_fork_continuation_enomem`), `fork-module-backend-coarse-failures`, `fork-module-capture-drive` seal-failure. Perturb the in-module abort path.

### 1K. Optional: guest-emitted catalog placement shims

`__wpk_fork_place_function_catalog(base)` and `__wpk_fork_place_static_roots(base)` would be emitted by fork-instrument, like `__wpk_fork_place_resume_thunks`. They remove the last per-slot `Table.get` / `Table.set` loops in `forkActivationCatalogSink` and `ForkMergedStaticRoots`.

This is an ABI content change to fork-instrument exports. It is allowed because ABI 44 is unreleased: regenerate `abi/snapshot.json`, no bump, and rebuild the instrumented fixtures. It adds no host entries. It is worth doing for the host-floor claim; the saving is about 40 TS lines and the native equivalent.

### Measuring each step

Record `forkModuleHostEntries`, `forkPlatformTypeScript`, `forkRestoredHostFloor`, `forkTypeScript` and `workerMainForkTypeScript` (via `npx vitest run host/test/surface-budget.test.ts`). For native, record a `grep -v` comment-stripped line count over the `guest.rs` ranges listed above, in each commit message. Bank each reduction in the same commit.

**Step 1 end state:** 43 → about **17** host entries. `workerMainForkTypeScript` about 2802 → **2450**. `forkPlatformTypeScript` about 1349 → **900**. `forkRestoredHostFloor` 664 → about **520**. Native about −600 lines.

---

## Step 2: replay gate and vfork lifetime move into the kernel

### Today

- **Replay gate** (`fork-replay-gate.ts`; used in `process-lifecycle.ts` 2433–2618 and 3150–3400; waited on at `worker-main.ts:3928`). The child posts `fork_replay_ready` and `Atomics.wait`s on a separate `SharedArrayBuffer`. The host re-checks the worker generation and `shouldLaunchPendingChild` (`kernel-worker.ts:10336`), then commits. Only after that does `onFork` resolve and the parent's SYS_FORK complete (`kernel-worker.ts:20960`).
- **vfork lifetime** (`vfork-lifetime.ts`) keeps per-`Memory` busy state and a `starting → borrowing → settled` promise. `process-lifecycle` settles it after exact teardown (876–905, 1347–1446, 1554–1590).
- **Native duplicates this** with `vfork_parent_release` / `vfork_awaiting_child` (`guest.rs:11552`, `12964`, `13450`, `13569`).
- **The kernel** has no fork/vfork lifecycle state beyond `kernel_fork_process(parent, tid, mode)` (`wasm_api.rs:2702`) and a `kernel_clear_fork_child` flag.

### Kernel state (`crates/kernel`, process table)

```
Process.fork_launch: Option<PendingForkLaunch {
    parent_pid, parent_tid, mode, parent_channel_token,
    phase: Launching | ReplayReady | Committed }>
AddressSpace (keyed by the parent's address-space id, which a vfork child
  shares) .vfork_borrower: Option<child_pid>
Process.vfork_parent: Option<(parent_pid, parent_tid)>
```

The address-space id already exists implicitly through `borrowedAddressSpace` registration. The kernel should own it explicitly, created with the process and inherited by a vfork child.

### Syscall and exports

**`SYS_FORK_REPLAY_READY`.** This is a new kernel syscall; take the next free number after 415 and verify.

- It is issued **by the fork module** on the child's channel from inside the child-replay `kernel_fork` path. It is not libc. The module already issues SYS_MMAP through the channel.
- The kernel checks that the caller is a pending fork child whose process is still live. This replaces both the generation check (a channel is bound to one registered generation) and `shouldLaunchPendingChild`.
- It marks the child `Committed` and emits a wakeup event "fork committed(child)". `kernel-worker` completes the parent's parked SYS_FORK / SYS_VFORK channel from that event. For vfork, the parent channel stays parked (see below).
- The child's syscall returns 0, which replaces `waitForForkReplayCommit`.
- If the child is killed first, the syscall is never answered and the ordinary kill path tears the worker down.

**New or changed exports:**

| export | purpose |
|---|---|
| `kernel_fork_launch_failed(child_pid, errno)` | Host reports Worker construction, error or exit before readiness. Replaces `observeForkReplayWorker`'s cancel paths. The kernel rolls back or zombifies, as `#rollbackForkWithinKernelEntry` does now, and answers the parent's channel with the errno. |
| `kernel_fork_process(…, VFORK)` | Refuses with EAGAIN when the address space already has a borrower. Replaces `VforkAddressSpaceBusyError` / `hasActiveAddressSpace`. |
| vfork parent release | On child exec commit or exit, the kernel moves the vfork lifetime to "awaiting quiescence" and emits an event. The host does its exact teardown (worker quiescence, exec retirement) and calls `kernel_vfork_address_space_released(child_pid, disposition)`, where disposition is resume / contain. The kernel then completes the parent's SYS_VFORK with `child_pid`, or on contain applies the containment signal policy. |

### Host facts that remain (irreducible)

- **Worker quiescence and exact-generation teardown proof.** The kernel cannot observe that a JS realm stopped touching memory.
- **Borrow vs start.** `markChildMayAccessMemory` is now only "call `kernel_fork_launch_failed` before start; after start only containment". It becomes a single host boolean, not a class.
- **Containment decision on an ambiguous teardown.**
- **Worker spawn, memory leases and the alias lease.**

`VforkLifetimeCoordinator` (274) shrinks to about 50 lines of host glue. `fork-replay-gate.ts` (166) is deleted except for about 20 lines of the observer, which reports to the kernel. Per census §105 the honest saving is about 250–320 lines in `forkRestoredHostFloor` / `process-lifecycle.ts`, not the whole files.

### Node/browser parity

Both hosts run `process-lifecycle.ts` and `kernel-worker.ts`. The change is shared by construction; the only host-specific pieces are Worker adapters, which are untouched.

Browser validation still has to be run: the `vfork-lifecycle` (9) and `fork-continuation` (5) specs.

Native gets the same semantics from the same kernel. It deletes `vfork_parent_release`, `vfork_awaiting_child` and `resolve_vfork_parent_release`, and relies on the kernel's release event plus its own thread-join quiescence.

### ABI impact

A new syscall number, new kernel exports, and a changed completion semantics for SYS_FORK / SYS_VFORK (who completes the parent, and when). ABI 44 is unreleased, so: `bash scripts/check-abi-version.sh update`, commit the `abi/snapshot.json` + `host/src/generated/abi.ts` diff, no bump.

Add the syscall to `crates/shared` tables, the `syscall_arg_descriptors` and `docs/fork-instrumentation.md` / `docs/architecture.md`.

### Sub-stages

- **2a.** Kernel state + `SYS_FORK_REPLAY_READY` + `kernel_fork_launch_failed`, additive. Kernel unit tests: ready before the host registers; killed child; stale channel. Validate with `cargo test -p <kernel crate> --target aarch64-apple-darwin`.
- **2b.** Switch the module (the child-replay branch issues the syscall) and TS, and delete the gate. The module and `worker-main.ts:3900–3930` must land together.
- **2c.** Kernel vfork busy/release state + `kernel_vfork_address_space_released`. Shrink `vfork-lifetime.ts`.
- **2d.** Native switch.

2a/2c can start in a **separate worktree in parallel with step 1**. 2b touches `worker-main`'s `kernel_fork` and so should land **before step 3**.

### Tests and validation

- **Must keep passing:** `vfork-production-trace-runner`, `vfork-start-failure-runner`; P-08 exact ownership fences; sortix `process` (24), `signal` + `io` (87); the four `os-test-local` fork tests with `KANDELO_OS_TEST_DIR` at `7e8f0082ab`.
- **New:** a fork whose child is SIGKILLed between registration and replay-ready. The parent must get the child pid and a reapable zombie; this is the POSIX-visible behaviour. Perturb by removing the kernel's liveness check.
- **Risk:** the parent-completion ordering against deferred kernel-entry ingress (`retryKernelEntryResult` bursts). Run the php-fpm fork burst.

**Budget:** `forkRestoredHostFloor` −250 to −320; `workerMainForkTypeScript` about −20; native about −60.

---

## Step 3: merge the process and thread fork paths

### What is duplicated

`centralizedThreadWorkerMain` repeats `centralizedWorkerMain`'s fork setup:

| duplicated piece | process path | thread path |
|---|---|---|
| module instantiate + backend + `setup` + `bindSlots` + unwind tag | 3470–3615 | 6085–6130 |
| table owners / `ForkTables` / `ForkImportIdentity` / `ForkActivations` | 3640–3700 | 5990–6030, 6130–6160 |
| `kernel_fork` closure | 3840–3990 | 6229–6318 |
| reserve wrapper | 4340 | 6479 (deleted in 1I) |
| guest-import assembly | | 6427–6500 |
| fork run loop | 4738–4850 | 6643–6725 |

### Shared function

Extract into a new file, `host/src/fork-worker.ts`. It is not counted in `workerMainForkTypeScript`, but it is counted in `forkPlatformTypeScript`; see open question 3.

```ts
createForkWorker({ memory, ptrWidth, channelOffset, archiveControlAddr, pid, label,
                   forkModuleModule, reserve, isForkChild, borrowed })
  -> { guestEnvImports(guestModule, activationGlobal), activations, tables,
       identity, resumeTable, dylinkFrameFlip, kernelFork(rawMode),
       runForkLoop(lexical, replay, exitStatus), finalize() }
```

Both mains call it. `createProcessDylinkActivationOwner` and the table-replication owner receive its members instead of eight loose locals.

### What differs legitimately

These become parameters, not branches:

- **Archive lock acquisition.** Process: `reconcileNow` + reader lock (`acquireCurrentProcessForkArchiveReader`). Thread: `acquirePthreadForkLock` over the process dlopen owner/lock words. Pass one `acquireForkArchiveReader` / `release` pair.
- **Where the anchor is published.** Process control word or thread `forkAnchorAddr`, via `publishLaunchRoot`.
- **Child-only behaviour, process path only.** Inherited module region, launch-root read, child install, the borrowed-child region munmap and stats snapshot, and the replay-ready branch in `kernel_fork`. A pthread worker is never a fork child.
- **Bootstrap export.** `wpk_fork_module_bootstrap` for a process, `…_thread_bootstrap` for a thread.
- **Entry pair.** `_start` / `resume_start`, or `threadFn` / `resume_thread`.
- **Exit protocol after the loop.** Thread SYS_EXIT or process `kernel_exit`.
- **Proof-of-use messages.** These could be one `fork_module_stats` message; open question 5.

**Estimate:** −450 to −550 from `workerMainForkTypeScript`, with about +250 in the new file. Net fork TS about −250 to −300.

### Stretch (3b): the run loop in Rust (`fm_run`)

The **module** could serve the guest's `kernel.kernel_fork` import. It already issues channel syscalls, so it can send SYS_FORK itself, which replaces `sendForkSyscall`. An injected `fm_run(entry_slot, arg)` would call the guest entry through the drive table inside a `try_table` catching the module's own unwind tag, then seal, fork and replay-loop in Rust.

The host would keep only the call to `fm_run` and the trap guard (unreachable + `kernelExitStatus` check). This would delete the `kernel_fork` closures and run loops in **all three** hosts (TS about −300 more; native `run_fork_capable_entry` + `drive_fork_capture_seal_and_launch_child` + the `kernel_fork` closure, about −450). It would also take `fm_parent_begin_capture`, `fm_parent_seal_capture`, `fm_parent_replay`, `fm_parent_finish` and `fm_phase` off the host list (17 → about 13).

- **ABI impact:** the guest import binding changes, but no signatures change.
- **Risks:** EH codegen in walrus-injected shims, and exception propagation of `ExecRetirement` and traps through module frames.
- **Proposal:** prototype behind a probe before committing (open question 2).

### Sub-stages

- **3a.** Extract `createForkWorker` with the process path only; the thread path is unchanged. Run the full host suite and the 18 browser fork specs.
- **3b.** Switch the thread path. Tests: `fork-from-thread.test.ts`, `dlopen-pthread-table-replication`, fork from a pthread inside a dlopen program.
- **3c** (optional). `fm_run` prototype.

Depends on 1I and 2b; 1E–1H are strongly preferred first. Validate with the host suite (`host/test/suite-baseline.mjs`: 64 expected failures, nothing new), the six browser spec files (18 tests), and sortix `process` / `signal` / `io`.

---

## Step 4: native parity

### 4a. Stop swallowing native faults (do first; any time, in its own worktree)

`run_fork_capable_entry` treats every `unreachable` trap as a clean exit (`guest.rs:~9998`). Check the kernel's recorded exit status first, as JS does with `kernelExitStatus`, and post a trap exit otherwise.

- New test: a guest that hits `unreachable` without exiting must report SIGILL status, not hang for 30 s.
- Perturb by restoring the old match arm.

### Hypotheses per failing test

All four are to be confirmed with the single-test milestone-print technique from the closure doc: about 30 s per run.

**`smoke_fork_reconstructs_references`** (`lib.rs:3855`)

- Native binds its own guest capture imports (`gc_lookup` / `gc_claim` / `gc_define`, `guest.rs:8380–9000`) into `NativeReferenceCapture`, and writes that graph to `fm.empty_module_state_root` at seal (`10224`).
- It then calls `fm_begin_reference_replay(empty_root)` before `fm_parent_replay`. But `parent_replay_impl` restores from `module.module_state.root()`, the module's own builder, which native's imports never fed.
- The parent's restore therefore sees the wrong recipes and the guest's assertion fires (the trap the closure doc observed).
- **Fix under the shared paths:** bind the **module's** exports for every guest fork import. Native already has the nameless binder loop for everything the module exports "that nothing above has claimed", so the fix is to delete the native claims. Then delete `NativeReferenceCapture`, `GcProvenanceRegistry`, `StaticRootProvenance`, `write_module_state_arena` and the gated-abort transit restore (about 1,000 lines). Child and parent then both run `fm_child_install` / `fm_parent_replay` over the module's arena.

**`smoke_fork_gc_two_object_cycle`** and **`smoke_fork_gc_array_reconstructs`** (`4020`, `4079`)

- The same root cause, plus the GC-specific native paths (constructor provenance, `gc_claim_remember`) that the module now owns through `fm_gc_identity_*` and `fm_gc_provenance_witness_slot`.
- The array case additionally goes through the native array constructor-provenance port (`GcConstructorRecord`). Once the module's witness pool serves it, this goes away.
- The child side also never drives attach-step restore/finish (native bypasses `fm_attach_child`); `fm_child_install` fixes this.
- **Secondary suspect:** transit sizing. It is moved into the module in 1E.

**`smoke_vfork_execve_releases_parent`** (`3677`)

The exit variant passes, so replay itself works. Two candidates:

- **(i) The arena pointer.** The borrowed child's seed uses `arena_root` read from `DATA_OFFSET + 16`, which is native's `empty_module_state_root` scratch. Under the shared path this pointer comes from the launch root inside `fm_child_install` (1E), not smuggled.
- **(ii) Exec teardown of shared memory.** `handle_exec_common` replaces `processes[pi]` and calls `reclaim_all_channels(old_proc)` on a process whose **memory is the parent's**. The old image's thread-reclaim may write to or park on the shared memory, or the new image's `compute_guest_memory` / fork-module instantiation may collide with the borrowed region.

(ii) is the likelier explanation for an exec-only failure. It is resolved by step 2: the kernel releases the parent only after host quiescence, and native's exec path stops resolving the parent itself.

- **Probe first:** assert which of stdout "exec ok", "parent" or exit 9 is missing in the current failure.

**Ignored `smoke_fork_externref_table`** (`3386`)

- Native never publishes table-state elections, so every table reads "not owned" at capture.
- The child never runs module-state restore/finish (no attach steps).
- Both are fixed by 1H (native publishes table groups; the module elects) and 1E (native `fm_child_install`). The table-shim drive slots 16–18 are already bound natively.
- Un-ignore it in 4b.

### How steps 1–3 change the fix

Native stops being a separate sequence. After 1A/1B/1E/1H/1I it calls the same about 8 entries as TS, in the same order, and the four failures reduce to one deletion: native's shadow capture. If 3c lands, native's run loop is the module's too.

### Sub-stages

- **4a.** Fault visibility.
- **4b.** Retire the native capture imports and graph. Needs 1E. Un-ignore the externref table test.
- **4c.** The vfork exec case after 2d.
- **4d.** `smoke_fork_from_thread` (ignored, resume-slot gap) re-probed under the merged path. It is not in scope to fix, but it should be re-run.

Validate with `cargo test -p host-native --target aarch64-apple-darwin`. The goal is 64 passing with 0 failures, the ignored externref test un-ignored and passing, and the 4d test re-run and reported.

---

## Dependencies and parallelism

```
1a ──► 1b (TS) ─┐
   └─► 1c (N)  ─┴► 1d ──► 1e ─► 1f / 1f-native (+4b) ─┐
                    ├─► 1g (TS, parallel with 1e) ─────┤
                    ├─► 1h (both, parallel) ───────────┤
                    └─► 1i (both) ─────────────────────┴► 3a ─► 3b ─► (3c)
2a, 2c (kernel, separate worktree, from day 1) ─► 2b ─► 2d(N) ─► 4c
4a (native, separate worktree, from day 1)
```

**Parallel worktrees:** (1) the step 1 chain; (2) kernel 2a/2c; (3) native 4a, then 1c. `worker-main.ts` is the contention point: serialize 1b / 1f / 1g / 1i / 2b / 3 edits to it.

---

## Expected end state vs lane F closure

| surface | now | after steps 1–3 | with 3c (`fm_run`) | closure |
|---|---|---|---|---|
| `forkModuleHostEntries` | 43 | about 17 | about 13 | ≤ 5 |
| `workerMainForkTypeScript` | 2802 | about 1,950–2,100 | about 1,650–1,800 | ≤ 1200 |
| `forkTypeScript` | 623 | about 500 | about 480 | ≤ 2500 (met) |
| `forkPlatformTypeScript` | 1349 | about 1,050 (incl. new `fork-worker.ts`) | about 950 | — |
| `forkRestoredHostFloor` | 664 | about 250 | about 250 | — |
| host-native fork lines | about 2,200 | about 900 | about 450 | — |

**Neither remaining closure condition is reached honestly by this plan.**

**Host entries: the about-13 floor.** It breaks down as:

- **Worker:** `fm_set_format` (worker init), `fm_last_errno`, `fm_stats`, `fm_phase` (goes with 3c).
- **Activation:** admit, bind, publish_bindings, release (`fm_resume_slots`).
- **Fork:** `fm_abort`, `fm_child_install`, `fm_child_plan` (+ `fm_run`).
- **Peer tables:** `fm_capture_peer_tables`, `fm_restore_from_arena`.

Getting to 5 needs either dilution, which the maintainer already rejected in §195, or a measure change: excluding the three diagnostics and folding the two peer-table entries, which are lane-adjacent dylink work.

**`workerMainForkTypeScript`: 1200 needs two things beyond this plan.**

- Moving non-fork branches that sit inside `centralizedWorkerMain` out of the count: the WASI branch (about 90) and the uninstrumented branch (about 110). They would be extracted into named functions and added to `WORKER_MAIN_OTHER_LANES`, which is a visible measure decision.
- `createProcessDylinkActivationOwner` / table-replication (about 300) being reclassified as dylink-lane work, or shrunk by a dylink-side change.

### What remains as host floor

- Worker spawn, quiescence and exact-generation teardown, memory leases.
- Wasm compile and instantiate; the module's host imports, including `__wpk_fork_host_materialize_dlopen_archive`.
- SHA-256 template id.
- Locating custom sections.
- Object-identity groups (`WeakMap`) and the child import Proxy.
- Reference `Table.set` / `Table.get` for drive bindings and catalogs (unless 1K).
- The trap guard (unreachable vs exit, `ExecRetirement`).
- Containment policy for an ambiguous vfork teardown.

## Open questions for the maintainer

1. **The `forkTypeScript` closure bound.** `forkTypeScript ≤ 2500` is already met (623); it appears to predate the split to `fork-module-*.ts`. Should it be repointed, for example at `forkPlatformTypeScript + forkRestoredHostFloor`?
2. **Prototype `fm_run`?** Should 3c go ahead as a probe first (module-owned run loop and `kernel_fork` served by the module)? It is the only route below about 17 entries and the largest native deletion.
3. **Where the merged fork-worker code lives.** It could stay in `worker-main.ts` (counts against `workerMainForkTypeScript`) or go in `fork-worker.ts` (counts against `forkPlatformTypeScript`). Which surface should carry it?
4. **Restating the entry target.** Restate `forkModuleHostEntries` to about 13, or exclude `fm_last_errno`, `fm_stats` and `fm_phase` from the measure?
5. **Stats messages.** May the per-kind proof-of-use messages (`fork_module_frames`, `fork_module_references`, `fork_module_child_frames`) become one stats-snapshot message? They cost about 80 lines across both paths, and tests depend on them.
6. **Slab sizing.** Grow `STAGING_SLAB_BYTES` to fit a whole per-activation admission (it must be measured), or keep KFIG/KFIT as a separate stage?
7. **ABI content for 1K and step 2.** Is it approved under unreleased ABI 44 with snapshot regeneration only: guest-emitted catalog placement shims (1K), `SYS_FORK_REPLAY_READY`, and changing SYS_FORK / SYS_VFORK completion to be kernel-driven?
8. **Excluding non-fork branches from the measure.** Should the WASI and uninstrumented branches of `centralizedWorkerMain` be added to `WORKER_MAIN_OTHER_LANES`?

### Critical files for implementation

- `/Users/brandon/kandelo-abi44-reconcile/crates/fork-module/src/lib.rs`
- `/Users/brandon/kandelo-abi44-reconcile/host/src/worker-main.ts`
- `/Users/brandon/kandelo-abi44-reconcile/host/src/fork-module-backend.ts`
- `/Users/brandon/kandelo-abi44-reconcile/crates/host-native/src/guest.rs`
- `/Users/brandon/kandelo-abi44-reconcile/host/src/process-lifecycle.ts`, with `crates/kernel/src/wasm_api.rs`

## Maintainer rulings (2026-09-25)

1. **`fm_run` is planned in fully** as a committed stage of step 3 (3c is no
   longer optional or probe-only). Exception-handling and trap-propagation
   risks are handled as part of the stage's validation, on V8, SpiderMonkey,
   JSC and wasmtime.
2. **Entry target:** decide after step 1 lands, from the measured floor. No
   measure or target change before then.
3. **ABI 44 content approved** (unreleased; snapshot regeneration, no
   version bump, full rebuild): `SYS_FORK_REPLAY_READY`, kernel-driven
   completion of a parent's SYS_FORK/SYS_VFORK, and the 1K guest-emitted
   catalog placement shims.
4. **Measures:**
   - Repoint lane F's `forkTypeScript <= 2500` closure condition (already
     met; it predates the file split) at the fork TypeScript that remains
     (`forkPlatformTypeScript` + `forkRestoredHostFloor`), bound set after
     step 1.
   - Extract the WASI and uninstrumented branches of `centralizedWorkerMain`
     into named functions and list them in `WORKER_MAIN_OTHER_LANES`.
   - The merged process/thread fork path lives in
     `host/src/worker-main-fork-support.ts` (named as subservient to
     worker-main.ts) and is COUNTED in `workerMainForkTypeScript`, so moving
     code there never removes it from the closure measure.
   - `createProcessDylinkActivationOwner` and the table-replication owner
     stay counted as lane F (not reclassified).
5. Defaults taken where the maintainer did not rule: measure the per-activation
   admission size before sizing the staging slab (Q6); keep the proof-of-use
   messages unless step 3 shows a single stats message is strictly simpler and
   its tests move with it (Q5).
