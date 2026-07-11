# ABI versioning

User programs and prebuilt binaries are compiled against the kernel's binary
interface. When the kernel changes that interface in a way that breaks old
binaries, running an old binary against a new kernel would silently corrupt
state. To prevent this, the project maintains:

1. A single integer [`ABI_VERSION`](../crates/shared/src/lib.rs) that every
   compiled binary carries and the kernel exports.
2. A structural snapshot of the ABI surface at
   [`abi/snapshot.json`](../abi/snapshot.json), regenerated from source.
3. A CI check that refuses to let the snapshot drift from source, and
   refuses no-bump snapshot changes unless they are narrowly additive.

**Agents and humans alike: do not change the kernel ABI incompatibly
without bumping `ABI_VERSION`.** The check is structural, not a
convention — CI enforces it.

## What counts as an ABI change

Anything that could make an old compiled binary misbehave against a new
kernel. Specifically, any of the following requires an `ABI_VERSION` bump:

- Removing, renaming, or reassigning a syscall number.
- Changing an existing syscall argument descriptor used by the host for
  pointer marshalling, including direction, size source, multipliers,
  fixed byte lengths, pointer nullability/requiredness, or return-value copy
  adjustments.
- Changing the channel header layout (field offsets or sizes in
  [`crates/shared/src/lib.rs`](../crates/shared/src/lib.rs)
  `channel` module).
- Changing the data-buffer size or the signal-delivery area layout.
- Adding, removing, or reordering fields of a marshalled `repr(C)` struct
  (`WasmStat`, `WasmDirent`, `WasmFlock`, `WasmTimespec`, `WasmPollFd`,
  `WasmStatfs`), or changing a field's type in a way that shifts offsets
  or span.
- Changing the five `wpk_fork_*` export names or the save-buffer /
  frame format emitted by
  [`wasm-fork-instrument`](fork-instrumentation.md) into every
  fork-using user program. The kernel does not read these exports
  directly, but the host runtime in `host/src/worker-main.ts` does —
  a rename here silently breaks fork for every already-built binary.
- Changing the linked musl/glue syscall function types or argument-slot widths,
  including the wasm32 cancellation-point `__syscall_cp` path. These are not
  currently visible in the structural snapshot, but stale objects and archives
  can otherwise link with incompatible Wasm function signatures.
- Adding or changing a required kernel-Wasm host import. Kernel imports are not
  yet present in the structural snapshot, so reviewers must track this surface
  explicitly and coordinate the host implementation in the same ABI epoch.
- Changing the name, version, encoding, or role semantics of the
  `kandelo.wpk_fork.capabilities` custom section. The host uses these claims to
  decide whether a main/side-module pair can safely coordinate fork replay.
- Renaming the ABI custom section or the process-expected globals.
- Changing the meaning of a syscall argument, errno, or blocking
  behavior without changing its signature. **This is not caught
  structurally — reviewers must flag it and bump anyway.**

The fork-capability section has an explicit ABI transition rule. ABI 16 accepts
an absent section through the pre-existing five-export fallback, while treating
a present marker as authoritative. ABI 17 and later require the role marker.
Do not make absence an error on ABI 16: mandatory enforcement must land in the
same commit as the ABI 16-to-17 bump and regenerated snapshot.

The current constituent branch remains ABI 16. Its runtime contains the
ABI-17 enforcement path, but that path is intentionally inactive until the
aggregate integration change performs the single ABI 16-to-17 reconciliation,
bumps `ABI_VERSION`, and regenerates the snapshot in that same commit.
For the same reason, `kernel_get_process_exit_signal` is an optional runtime
probe on ABI 16 rather than a required host-adapter export. Requiring it belongs
in that ABI-17 reconciliation, not under the existing ABI number.

Pure internal refactors (renaming a kernel-side function, reorganizing
a source file, tightening a bound in a non-ABI type) are *not* ABI
changes and do not require a bump.

The following snapshot changes are backward-compatible additions and do
not require an `ABI_VERSION` bump:

- Adding a new named syscall number while leaving every existing syscall
  entry unchanged.
- Adding a new host-intercepted syscall number while leaving every
  existing host-intercepted entry unchanged.
- Adding a new kernel-wasm export while leaving every existing export's
  kind, signature, type, mutability, and tracked value unchanged.
- Adding a new marshalled struct name while leaving every existing
  marshalled struct layout unchanged.
- Adding a syscall argument descriptor for a syscall that previously had
  no descriptor, while leaving every existing descriptor unchanged.
- Adding the initial `host_adapter` snapshot section or adding new
  optional host-adapter metadata while leaving required existing fields
  unchanged.

These additions still require regenerating and committing
`abi/snapshot.json`. They do not permit older kernels to run newer
programs that require the new surface; they only permit older programs
to keep running on newer kernels in the same `ABI_VERSION` epoch.

## The snapshot

`abi/snapshot.json` is generated by `cargo xtask dump-abi` from the
authoritative Rust sources and the freshly-built kernel `.wasm`. It
captures:

- `abi_version` — the integer [`ABI_VERSION`](../crates/shared/src/lib.rs).
- `channel_header` — field offsets and sizes in the channel header,
  read from `shared::channel::*` constants.
- `channel_signal_area` — signal-delivery slot offsets in the trailing
  bytes of the channel data buffer.
- `channel_buffers` — data buffer offset/size and minimum channel size.
- `channel_status_codes` — numeric values of `ChannelStatus` variants.
- `marshalled_structs` — per-struct layout (`size`, then `fields[]`
  with `name`, `offset`, `span`). `span` is bytes until the next field
  (or end of struct), so it includes alignment padding and catches any
  layout shift.
- `syscalls` — every syscall number named by the shared ABI metadata:
  the core `Syscall::from_u32` table plus `abi::extended_syscalls`
  entries for host-visible kernel/control syscalls that are not yet in
  the core enum.
- `syscall_arg_descriptors` — host marshalling descriptors for pointer
  arguments, including direction, size source, size multipliers/additions,
  fixed byte lengths, pointer nullability/requiredness, and any
  return-value-based copy-back adjustment.
- `pathconf_names` — the shared numeric `_PC_*` vocabulary consumed by the
  kernel, generated host bindings, and libc wrappers.
- `host_adapter` — Rust-owned boot manifest metadata consumed by host
  adapters: manifest layout, host adapter protocol version, required
  worker feature bits, and required/optional kernel exports.
- `process_memory_layout` — Rust-owned process memory layout metadata:
  Wasm page size, default process memory settings, main control pages,
  pthread slot page offsets, and the process-wasm thread-slot declaration
  contract.
- `custom_sections` — names of wasm custom sections that participate in
  the ABI (currently `wasm-posix-abi` for the per-binary version).
- `process_expected_globals` — globals every user process instance is
  expected to expose for the host to thread through fork/exec.
- `kernel_exports` — every non-toolchain export in the built kernel
  `.wasm`: function signatures (`(params) -> (results)`), global
  types/mutability, memory + table entries. Toolchain-internal
  symbols (`__wasm_call_ctors`, `__data_end`, `__llvm_*`, etc.) are
  filtered out by `shared::abi::export_is_tracked`. For immutable
  globals whose name matches `ABI_VALUE_CAPTURE_PREFIXES` (today
  `__abi_*`), the initial value is captured as well — so a change to
  an ABI-flag constant moves the snapshot directly.
- `export_deny` — the filter lists themselves (`deny_prefixes`,
  `deny_exact`, `value_capture_prefixes`). Making the filter part of
  the snapshot means adding or removing a pattern is itself an
  ABI-relevant change, tracked by the normal diff.

Fields are sorted alphabetically at every level, and the generator
writes the same bytes for the same input — the snapshot is a pure
function of the checked-in source.

## Developer workflow

On a change:

```bash
# 1. Make your change to kernel / shared / glue as needed.
# 2. Regenerate the snapshot. This rebuilds the kernel wasm first so
#    a stale binary can't defeat the check.
bash scripts/check-abi-version.sh update
# 3. Inspect the diff. If it's empty, the change didn't touch the ABI.
#    If it is only an additive-compatible change, commit the snapshot
#    without bumping ABI_VERSION. If it changes existing ABI surface,
#    bump ABI_VERSION in crates/shared/src/lib.rs in the same commit.
# 4. Verify.
bash scripts/check-abi-version.sh
```

In CI:

```bash
bash scripts/check-abi-version.sh
```

Fails if the committed snapshot drifts from the source. If the snapshot
changed versus `origin/main` without a matching `ABI_VERSION` bump, CI
classifies the diff and accepts only the additive cases listed above.

## What the check does **not** catch

- **Semantic changes with the same signature.** Reinterpreting a
  syscall argument, changing blocking behavior, or changing an errno
  value will not show up in the snapshot. Reviewers must catch these.
- **Things not in the generator's coverage list.** Whatever
  `xtask dump-abi` doesn't inspect isn't tracked. Treat the coverage
  list as itself ABI-critical: adding or removing an entry from
  `tools/xtask/src/dump_abi.rs` is an ABI-relevant change. (The export
  filter lists in `shared::abi::EXPORT_DENY_*` are themselves in the
  snapshot, so at least those are self-tracking.)
- **Host-side assumptions not reflected in Rust-owned ABI metadata.**
  Process memory layout constants should live in `wasm-posix-shared`,
  flow through generated TypeScript, and appear in
  `process_memory_layout`. Host-only constants outside that path are not
  protected by the ABI check.

## Rollout of prebuilt binaries

Binaries published to hosting (GitHub Releases) carry the ABI version
they were built against in their filename directory (`abi-v1/`) and in
a wasm custom section (`wasm-posix-abi`). The host refuses to launch a
binary whose custom-section version does not match the kernel's
`__abi_version` export.

When the ABI is bumped, all binaries must be rebuilt and a new
`binaries-abi-v{N}` release is cut. Old releases remain valid for old
kernel revisions; the new release's `index.toml` ledger lists all
v(N) archives. Each `packages/registry/<pkg>/build.toml`'s `[binary]
index_url` templates `{abi}` against the current `ABI_VERSION`, so
the next fetch automatically hits the v(N+1) release after the
constant bumps — no per-package URL pinning in-tree to amend. The
matrix flow's per-entry `scripts/index-update.sh` invocations
populate the new tag's `index.toml` atomically as each archive
publishes.

### Additive changes within an ABI epoch

Pure additions do not bump `ABI_VERSION`. Existing binaries still carry
the same ABI number, and the host-side `verifyProgramAbi` check remains
strict equality (`actual !== expected`). This is intentional: we keep a
single breaking-compatibility epoch rather than accepting arbitrary
older binaries against newer kernels.

The package cache key and release index remain keyed by `ABI_VERSION`,
so additive kernel API growth does not force every package to rebuild.
Packages built after an additive change may depend on the new syscall or
export; those packages should be resolved with the matching current
kernel, even though the ABI epoch did not change.
