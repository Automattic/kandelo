# ABI Contract

The ABI is the binary agreement between already-built user programs, package
archives, VFS images, fork-instrumented Wasm, kernel Wasm exports, generated
host constants, and the host runtime. A silent incompatible ABI change can
corrupt memory or make old binaries misbehave while appearing to launch
successfully.

Every incompatible change needs a version bump and a regenerated
`abi/snapshot.json` in the same change. Which version depends on who can see
the change:

- A change a running program can observe (the program surface) bumps
  `ABI_VERSION` in `crates/shared/src/lib.rs`. Every program carries it, so
  every program is rebuilt.
- A change only the kernel and host can see (kernel exports, kernel host
  imports, host-adapter metadata, the export filter, kernel-host wire
  formats) bumps `shared::abi::HOST_ADAPTER_VERSION`, the kernel-host
  version. The kernel and host ship together; the host refuses a kernel built
  for another kernel-host version, and programs stay valid.

Do not ship an incompatible change under an existing version.

Treat these as ABI surface:

- Syscall numbers, host-intercepted syscall numbers, and syscall argument
  marshalling descriptors.
- Channel header layout, channel buffers, status codes, signal-delivery area,
  process memory layout, and host-reserved control regions.
- Existing marshalled `repr(C)` structs and any field offsets, sizes,
  ordering, or meanings visible to user programs or host marshalling.
- Kernel Wasm exports used by the host, including function signatures, tracked
  globals, required/optional host-adapter metadata, and export filter policy.
- Kernel Wasm imports every host must supply (`env.host_*` functions and the
  imported `env.memory`), with signatures and memory limits. Adding or
  changing one is incompatible (a kernel-host version bump); removing one is
  compatible.
- ABI custom sections and process-expected globals used to verify or launch
  user programs.
- `wasm-fork-instrument`'s `wpk_fork_*` exports, save-buffer layout, frame
  format, and fork replay assumptions.
- Generated TypeScript ABI constants under `host/src/generated/abi.ts`.
- VFS image metadata that binds images carrying Wasm programs to a kernel ABI.

Programs bind to the program surface only. Every built program carries a
`kandelo.abi.contract` digest of `ABI_VERSION` plus the snapshot sections
`xtask dump-abi` marks `Surface::Program`, and the host refuses a program
whose digest differs from the kernel's. Kernel exports, kernel host
imports, host-adapter metadata, the export filter and kernel-host wire
formats are `Surface::KernelHost`: changing them without an `ABI_VERSION`
bump leaves every program valid. When you add a snapshot section, choose
its surface by asking whether a running program can observe it; if any
part of it can, it is `Program`. See docs/abi-versioning.md ("Which
changes force a program rebuild").

A structural additive change may keep the same `ABI_VERSION` only when existing
binaries remain valid and existing ABI entries are unchanged. Additions still
require regenerating and committing `abi/snapshot.json`.

Declare host-facing kernel exports once in
`shared::abi::HOST_ADAPTER_KERNEL_EXPORTS`. Use `optional_until(name,
introduced_abi, required_abi)` for an explicitly scheduled promotion;
required/optional lists are derived from `ABI_VERSION` for every consumer.
Use `optional(name)` when an interface should stay optional indefinitely.
Keep promotion deadlines after they take effect. This mechanism does not
make a newly required WebAssembly host import backward-compatible.

The snapshot check is necessary but not sufficient. It catches structural drift
covered by `xtask dump-abi`; it does not prove semantic compatibility. Changing
an existing syscall's meaning, errno behavior, blocking behavior, fd
inheritance, memory ownership, or pointer interpretation can require an ABI
bump even if the snapshot is unchanged.

ABI workflow:

```bash
bash scripts/check-abi-version.sh update
git diff abi/snapshot.json
# Decide: no ABI change, additive-compatible snapshot change, or incompatible change.
# If incompatible: bump ABI_VERSION in crates/shared/src/lib.rs.
bash scripts/check-abi-version.sh
```

After a version bump, also run `bash scripts/build-resolve-binary-bundle.sh`
and `bash scripts/test-resolve-binary-bundle.sh`. The committed standalone
resolver embeds the generated ABI constants; regenerating only the snapshot
and TypeScript bindings leaves shell build/conformance entry points rejecting
new artifacts with "rejected by artifact policy".

If `ABI_VERSION` changes, expect package-release consequences: existing package
archives for the prior ABI do not satisfy the new ABI, package indexes resolve
through `binaries-abi-v{abi}`, and ABI-bound VFS images/packages need
rebuilding or republishing through the normal package flow.

Do not add compatibility shims for stale ABI artifacts unless the compatibility
boundary is explicit, documented, and intentionally supported. Legacy Asyncify
exports, stale fork instrumentation exports, wrong ABI custom sections, old
package archives, and ABI-mismatched VFS images should fail loudly and be
rebuilt through the normal package/release path.
