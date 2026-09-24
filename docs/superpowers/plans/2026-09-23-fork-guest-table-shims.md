# Guest tables are reached through guest shims, not a private module table

Status: APPROVED 2026-09-23 -- the maintainer chose Option A (per-slot guest
shims driven by the module) "for now". C (write-site provenance) and D
(shared function-table object) are recorded below as later optimisations, not
in scope.

## The defect

The lane F census (docs/plans/2026-09-12-lane-f-census.md §32, §75) decided
the fork module serves the guest's `module_state_table_*` imports (table
mutation begin/commit/abort and reconcile) itself: `crates/dylink` owns the
protocol, `fork_codec::dylink_table_plan` decides, and the module applies
patches through injected `table.get`/`table.set` shims. Its premise was "the
fork module holds the table: its artifact imports
`env.__indirect_function_table`."

The premise is false in the wiring:

- A built program DEFINES and exports its own `__indirect_function_table`
  (checked: `local-binaries/programs/wasm32/fork-from-thread.wasm`); it does
  not import one.
- The fork module is instantiated BEFORE the program, because the program
  imports the module's frame exports. It cannot be handed the program's table
  at instantiation.
- Both hosts therefore bind the module's `__indirect_function_table` import to
  a fresh private table sized from the module's dylink record
  (`host/src/fork-module-instance.ts:238`,
  `crates/host-native/src/guest.rs` ~6738), since the placement commit
  `a3ecdaa03`.

Everything the module does "to the guest's table" runs against that private
table: `fm_indirect_slot_catalog_index`, `fm_indirect_table_size`,
`table_apply_via_injector`, and through them
`__wpk_fork_module_state_table_reconcile` (lib.rs ~9987) and the mutation
commit (lib.rs ~9822). Measured consequences (stage T4 probes,
scratchpad/probes/):

1. After any dlopen publishes a generation, the guest's reconcile guard calls
   the module on every guarded table access (>=16,384 calls in a 20,000-call
   loop, ~5x slower), and nothing is applied. `fm_set_format` also receives
   `archiveControlAddr`/`tableOwner` 0,0 because the backend is never given
   them.
2. A C program that grows its own `__externref_t` table and sets an entry
   exits 132: the commit reads the module's private table at the guest's
   index, and the guest passes only an owner number, so the module cannot tell
   which table changed.
3. The census logged a symptom without naming it: its first test clobbered
   slot 1 of the module's "indirect table", which held the module's OWN
   dylink function entries.

## The precedent that answers it

Resume-thunk placement had the same shape and was solved in lane F's latest
push: the module decides (ordinal -> slot), publishes the decision into shared
memory, and a fork-instrument-emitted guest shim
(`__wpk_fork_place_resume_thunks`) applies it to the guest's own table. No
funcref crosses into JavaScript and the module never holds the guest's table.

## Proposal

- fork-instrument emits, per guest table the module must read or write
  (every table the guest owns that the table-mutation path or reconcile
  covers, not only `__indirect_function_table`):
  - a slot reader that answers the merged-catalog index of the function at a
    slot (-1 null, -2 uncatalogued), replacing the module's injected
    `fm_indirect_slot_catalog_index`;
  - a size reader, replacing `fm_indirect_table_size`;
  - a patch applier that takes the module's published plan (dest, catalog
    slot, clear) from shared memory, like the resume-placement shim,
    replacing `table_apply_via_injector`.
- The guest's mutation calls name the TABLE (owner/table id), so commit knows
  which table changed; tables that are instance-local by the C/Wasm model are
  excluded from cross-worker replication by construction, not by accident.
- The module reaches those shims through its drive table (per-activation
  slots), the way it already drives `wpk_fork_module_table_state_save`.
- The host passes the dlopen archive control address and table owner to the
  backend (`fm_set_format`), with a borrowed vfork child using its OWNER's
  control block (commit 939a22eeb).
- The module's `__indirect_function_table` import shrinks to what the module
  itself needs for its own `call_indirect` (its dylink entries), or goes if
  the injector can place those elsewhere; the three injected table shims go.
- Then decide, with measurements, whether `createProcessTableReplicationOwner`
  (TypeScript) is still needed beyond loading a peer's side modules (the T4
  investigation found it is the only thing that does that).

Also in scope, because it is the same replication path: a pthread created
before another thread's dlopen traps "table index is out of bounds" calling
into the library; its table is one slot short of the main thread's (15 vs 16;
17 vs 18) with the module reconcile, the TS reconcile and the wired variant
alike. docs/architecture.md says this works. Root-cause it first.

## Cost

ABI-44 contents change (guest exports, module imports/exports, drive slots);
44 is unreleased, so snapshot regeneration, no version bump, full rebuild.
Both JS hosts and host-native change together.

## Tests

Through real workers: dlopen then heavy `call_indirect` (reconcile calls
bounded, e.g. <= 2 per generation); pthread + later dlopen + call from the
older thread; the externref-table C program; dlopen + fork + child calls into
the library; all perturbed to fail.

## Efficiency options (discussed with the maintainer 2026-09-23)

Hot path when correct: the per-call_indirect guard (atomic load + compare),
already cheap; keep it. Cost concentrates in commits (dlopen, dlclose,
runtime table.set) and the reconcile after one.

- A. Per-slot shims: 2 crossings per changed slot (module->guest read + host
  identity call). Simplest; worst for dlopen-heavy programs (PHP).
- B. Batched shims: one guest call per changed range into a shared buffer;
  still one host identity call per slot.
- C. Record at the write site (RECOMMENDED, with B as fallback): dlopen's
  writes come from element segments / the loader, and `ref.func N` writes
  are static, so the mutation carries (activation, ordinal, slot) and nothing
  reads the table back; only runtime funcref-value writes fall back to B.
- D. One shared table object via `--import-table`: SDK-wide link change,
  covers only the function table, still needs identity per slot.
- E. Cheaper trigger (syscall boundary / trap-retry): rejected, breaks POSIX
  (pointer handoff via atomics with no syscall; stale reused slots).

Open, before finalizing: ownership (dynamic linker vs fork module), answered
by probes/g-probe-noinstr.test.ts (non-instrumented pthread + dlopen).

## Revised recommendation (2026-09-23, after the maintainer asked about D)

Other tables cannot be shared the D way (the module's import list is fixed
per artifact while table counts vary and grow with dlopen; GC-typed tables
need the guest's types; Rust needs injected shims regardless). But they also
never need cross-worker replication: externref tables hold host objects that
cannot exist in another worker, and GC-typed tables hold per-instance objects.
Only funcref tables are replicable (rebuilt from the catalog). So:

1. D via fork-instrument (no SDK/linker change): rewrite the program's own
   function table into an import; the host creates it from the declared
   limits, grows it for the fork module's own dylink entries placed after the
   program's static elements (like a side module), and passes the same object
   to module and program. The module's existing direct table access is then
   correct.
2. C: mutations carry (activation, ordinal, slot) from the write site; the
   runtime-funcref-value fallback reads the shared table directly.
3. Non-function tables are excluded from the replication path by the
   instrumenter; fork captures/restores them via the existing guest
   save/restore shims; per-worker by platform boundary (documented). This is
   what fixes the externref-table crash.

## Decision

Option A, for now. Scope: the Proposal section above, implemented with
per-slot shims. Out of scope until asked: C, D, and moving replication to the
dynamic linker. Still in scope because A needs them to be correct: mutation
calls name their table, and the pthread one-slot-short table (root-cause
first; if it is a separate defect, fix it separately).

## Outcome (2026-09-23, branch `brandonpayton/fork-table-shims`)

Implemented as Option A. What landed, and what did not:

- The pthread "one slot short" table was a separate `crates/dylink` defect:
  export slots were handed out at the table's current length during
  publication, after the loader had appended a staged-call slot a replica
  never makes. Fixed on its own (export slots are reserved with the
  `dylink.0` region).
- fork-instrument splits "saved across fork" from "replicated across
  Workers". Only plain `funcref` tables take the writer/commit/reconcile
  path; externref and GC-typed tables keep dirty-page journaling and the
  save/restore helpers. Commits name `(activation, owner)`.
- Guest shims `wpk_fork_module_table_{read,length,apply}` at drive slots
  16-18; the module's injected `fm_indirect_slot_catalog_index`,
  `fm_indirect_table_size` and `__wpk_fork_table_apply` are gone, replaced
  by two module exports the guest calls (`..._table_catalog_index`,
  `..._table_catalog_function`). The module's own
  `__indirect_function_table` import stays: its own dylink entries use it.
- Found while testing, fixed in the module: a commit wrote the archive
  header's generation but never the process FENCE, so peers never
  reconciled; and a borrowed vfork child's reconcile allocated after its
  heap was returned.
- `fm_set_format` lost its table-owner argument; hosts pass the dlopen
  control address (a borrowed vfork child: its owner's). host-native passes
  0 (no dlopen).

Ruled by the maintainer the same day: the module asks via ONE host import,
`__wpk_fork_host_materialize_dlopen_archive(generation) -> errno`, which a
JS host answers with its existing dynamic-loader replay
(`forkModuleHostImports` 5 -> 6, approved). The module calls it during a
reconcile, before applying patches, when the archive names an activation this
worker lacks, and never while holding the archive writer: `mutation_begin`
reconciles (and materializes) before taking the writer, and releases and
retries if a peer dlopened in between. The TypeScript funcref patch
capture/apply and the dead guest-import forwarders are deleted; what remains
there loads peer side modules and restores checkpoints. Replication in a
process that never dlopened stays a documented gap.
