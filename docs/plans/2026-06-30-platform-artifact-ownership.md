# Platform Artifact Ownership For Registry Removal

Date: 2026-06-30

Tracked work:

- `kd-1mr` - Port all current Kandelo packages to Homebrew.
- `kd-t13y` - Move runtime platform artifacts out of the registry bridge.
- Source classification: `kd-u4sz`, committed as `0f7c57871`, classifies
  `kernel`, `userspace`, and `kandelo-sdk` as explicit non-package release
  artifacts.
- Source model: `kd-c6p`, committed as `1663df076`, defines the Homebrew
  registry replacement model.

This is a design artifact. It does not move files, delete registry entries,
publish artifacts, change resolver behavior, or claim new runtime support.

## Problem Statement

The Homebrew replacement work can remove `packages/registry` only after every
registry role has an explicit owner. `kernel`, `userspace`, and `kandelo-sdk`
currently look like package identities because they have
`packages/registry/<name>/package.toml` and `build.toml` files, but they are
not ordinary guest packages:

- `kernel` produces Kandelo's boot kernel wasm. It is consumed as
  `kernel.wasm` by Node, browser, tests, Vite aliases, and npm host package
  preparation, not as a guest-installed Homebrew Formula.
- `userspace` produces boot/runtime support wasm consumed beside the kernel.
  It is materialized at `userspace.wasm`, not under a Formula keg.
- `kandelo-sdk` produces a precomposed SDK VFS image containing wrappers,
  sysroot, glue, clang resource headers, and license notices. The current
  artifact is a runtime/tooling VFS layer, not a complete in-guest compiler
  package with Formula ownership.

The bridge-era package manifests also have signs that package identity is the
wrong owner: zero source hashes for first-party repo sources, stale
`kernel_abi` values, `kandelo-sdk` with `commit = "UNPUBLISHED"`, special
resolver placement for `kernel` and `userspace`, and host/browser paths that
ask for boot artifacts by fixed runtime names.

The target design needs an explicit non-package owner that preserves the
current strengths of package archives and Homebrew sidecars: ABI identity,
cache-key/provenance accounting, last-green fallback, status visibility,
required smoke evidence, and validation. It must also let registry deletion
fail loudly if any platform artifact still depends on package identity.

## Non-Goals

- Do not make `kernel`, `userspace`, or `kandelo-sdk` Homebrew Formulae in this
  work.
- Do not document guest `brew install` support for these artifacts.
- Do not treat the Homebrew tap's package `Kandelo/metadata.json` as the owner
  for boot/runtime artifacts.
- Do not remove the existing registry directories until materialization,
  publication, validators, docs, and smoke evidence have moved.
- Do not weaken ABI, stale-artifact, fork-instrumentation, VFS image, or host
  parity checks to make migration easier.
- Do not claim browser compatibility from Node-only materialization or from
  the presence of a precomposed VFS image.

## Users And Operator Workflows

Release operators need one status surface for first-party platform artifacts.
When a kernel rebuild fails, the failure should say whether the issue is a
kernel build, ABI snapshot, host-adapter export, archive upload, materializer,
Node smoke, browser smoke, SDK VFS build, or CI permission problem. It should
also preserve the last successful artifact when a fallback is safe.

Runtime maintainers need boot artifacts to remain easy to resolve from both
Node and browser hosts. `NodeKernelHost` loads `kernel.wasm` through
`host/src/binary-resolver.ts`; browser code imports `@kernel-wasm` through the
Vite alias. Both paths must resolve the same platform-artifact status rather
than one path reading package metadata and the other reading local files.

Package porters need these entries excluded from Homebrew Formula discovery.
A generated Formula matrix should not include `kernel`, `userspace`, or
`kandelo-sdk`, but package builds and tests should still be able to request the
boot kernel and SDK layer through documented artifact APIs.

Browser/demo maintainers need strict evidence for browser-facing claims. A
browser gallery entry or SDK browser workflow must point to a wasm32 artifact
with browser smoke evidence, not only a successful Node materialization.

Future maintainers need deletion checks that are hard to bypass accidentally.
Removing `packages/registry/kernel` should be blocked unless the replacement
manifest records the artifact owner, destination paths, release status,
fallback state, and validation requirements.

## Architecture And Data Flow

Add a first-party platform artifact owner separate from Homebrew package
metadata:

```text
platform/artifacts/
  manifest.schema.json
  manifest.example.json
  README.md
        |
        v
cargo xtask platform-artifacts
  validate
  materialize
  archive
  status
        |
        +--> binaries-abi-v<N> release assets
        |      kernel-<version>-abi<N>-wasm32-<sha>.tar.zst
        |      userspace-<version>-abi<N>-wasm32-<sha>.tar.zst
        |      kandelo-sdk-<version>-abi<N>-wasm32-<sha>.tar.zst
        |      platform-artifacts.json
        |
        +--> local materialization
               local-binaries/kernel.wasm
               local-binaries/userspace.wasm
               local-binaries/platform/kandelo-sdk.vfs.zst
               host/wasm/kandelo-kernel.wasm
               host/wasm/wasm_posix_userspace.wasm
               compatibility aliases during migration
```

The new owner should be release-oriented, not package-oriented. The durable
release can remain `binaries-abi-v<N>` because these artifacts are already
ABI-bound runtime release assets and are intentionally separate from the
Homebrew `bottles-abi-v<N>` release. The key change is that the
`binaries-abi-v<N>` release gets a platform-artifact manifest instead of
pretending these assets are registry packages.

### Manifest Shape

Use JSON with a schema and cross-file validator. JSON matches the existing
Homebrew sidecar tooling pattern and keeps the manifest directly consumable by
Node tooling without evaluating TOML package recipes.

Recommended top-level shape:

```json
{
  "schema": 1,
  "kandelo_repository": "Automattic/kandelo",
  "kandelo_commit": "<40-hex>",
  "kandelo_abi": 16,
  "release_tag": "binaries-abi-v16",
  "generated_at": "2026-06-30T00:00:00Z",
  "generator": "kandelo-platform-artifacts 1",
  "artifacts": []
}
```

Recommended artifact fields:

```json
{
  "id": "kernel",
  "kind": "kernel_wasm",
  "version": "0.1.0",
  "target_arch": "wasm32",
  "kandelo_abi": 16,
  "status": "success",
  "runtime_paths": [
    "kernel.wasm",
    "host/wasm/kandelo-kernel.wasm"
  ],
  "archive": {
    "url": "https://github.com/Automattic/kandelo/releases/download/binaries-abi-v16/kernel-0.1.0-abi16-wasm32-00000000.tar.zst",
    "sha256": "<64-hex>",
    "bytes": 1,
    "cache_key_sha": "<64-hex>"
  },
  "fallback": null,
  "source": {
    "repository": "Automattic/kandelo",
    "commit": "<40-hex>"
  },
  "inputs": [
    "Cargo.lock",
    "crates/kernel",
    "crates/shared",
    "abi/snapshot.json",
    "scripts/wasm-artifact-guards.sh",
    "rust-toolchain.toml",
    "flake.nix"
  ],
  "provenance": {
    "path": "platform-artifacts/reports/kernel-0.1.0-abi16-wasm32.provenance.json",
    "sha256": "<64-hex>"
  },
  "validation": {
    "required": [
      "abi_snapshot",
      "host_adapter_exports",
      "node_boot_smoke",
      "browser_boot_smoke"
    ],
    "outcome_lists": []
  }
}
```

The schema should allow the same status vocabulary as package release ledgers
and Homebrew sidecars:

- `success`: current archive fields are authoritative.
- `failed`: latest attempt failed; fallback may be selectable.
- `pending` or `building`: rebuild queued or running.
- `blocked`: known blocker with owner and next action.
- `excluded`: intentionally not published through this channel, with an
  alternate owner. This is useful only for future artifacts, not for the three
  artifacts in this bead.

For every non-success status, require a category, reason, last attempt time,
attempt actor, fallback completeness flag, and next action. This preserves
failure visibility rather than making platform artifacts vanish when a rebuild
breaks.

### Artifact Contracts

`kernel`

- Build command starts as the existing
  `packages/registry/kernel/build-kernel.sh`, later moved to
  `platform/artifacts/kernel/build-kernel.sh` or `scripts/build-kernel.sh`.
- Required ABI checks include `__abi_version`,
  `HOST_ADAPTER_REQUIRED_KERNEL_EXPORTS`, `abi/snapshot.json`, and the
  current `ABI_VERSION`.
- Materialization writes `binaries/kernel.wasm`,
  `local-binaries/kernel.wasm`, and host package aliases. The host package may
  keep `host/wasm/kandelo-kernel.wasm` and `host/wasm/kernel.wasm` aliases
  because they are package distribution details, not artifact identity.
- Node and browser boot smokes are required before claiming both-host support.

`userspace`

- Build command starts as the existing
  `packages/registry/userspace/build-userspace.sh`, later moved beside the
  platform artifact tooling.
- The manifest records that the artifact is ABI-bound boot/runtime support
  even though it is not a normal executable package output.
- Materialization writes `binaries/userspace.wasm`,
  `local-binaries/userspace.wasm`, and host package aliases.
- Browser evidence is required only where a consumer actually loads the
  userspace artifact in the browser path. If a path is Node-only or currently
  unused, record `skipped` with the concrete reason rather than implying
  support.

`kandelo-sdk`

- Build command starts as the existing
  `packages/registry/kandelo-sdk/build-kandelo-sdk.sh`, which builds glue
  objects and calls `images/vfs/scripts/build-kandelo-sdk-vfs-image.ts`.
- Cache inputs include SDK wrapper sources, `sdk/package*.json`, sysroot/glue,
  VFS image helper sources, host VFS image code, clang resource directory
  identity, libcxx dependency identity, and license files.
- The VFS image must carry explicit `kernelAbi` metadata. Current
  `saveImage()` already defaults metadata to the in-tree `ABI_VERSION`, so
  the validator should require the declaration for SDK artifacts instead of
  accepting legacy images with no ABI metadata.
- The long-term materialized path should avoid the guest program namespace,
  for example `binaries/platform/kandelo-sdk.vfs.zst`. During migration,
  write compatibility aliases at
  `binaries/programs/wasm32/kandelo-sdk.vfs.zst` and the matching
  `local-binaries` path until all consumers move.
- Browser compatibility requires a browser smoke that boots the SDK image or
  an SDK-specific workflow through the normal browser host. A successful image
  build alone is not browser support.

## Integration Points

### Resolver And Materialization

Add `xtask platform-artifacts materialize` and make
`scripts/fetch-binaries.sh` call it before or after package resolution. The
package resolver should stop walking these three entries as packages once the
new materializer exists.

Materialization should preserve existing lookup semantics:

- `scripts/resolve-binary.sh kernel.wasm` continues to work.
- `host/src/binary-resolver.ts` continues to resolve `kernel.wasm` for
  `NodeKernelHost`.
- `apps/browser-demos/vite.config.ts` continues to resolve `@kernel-wasm`
  through `tryResolveBinary("kernel.wasm")`.
- `scripts/prepare-host-package.sh` continues to package kernel and userspace
  wasm from local or fetched platform artifacts.

Do not make host or browser runtime code evaluate the platform-artifact
manifest directly at boot. Runtime paths should receive already-materialized,
stale-checked files. Build and preparation tools own manifest parsing.

### Publication

The publication flow should be sibling to package archive publication:

1. Build the artifact through the declared command in `scripts/dev-shell.sh`.
2. Validate artifact-specific ABI and stale-artifact policy.
3. Pack a deterministic archive with a manifest/provenance record.
4. Update `platform-artifacts.json` on the matching `binaries-abi-v<N>`
   release under the same state-lock pattern used by `index.toml`.
5. Preserve last-green fallback when a rebuild fails.
6. Run Node and browser smoke according to the artifact's required evidence.

This flow may reuse archive helpers from `tools/xtask/src/archive_stage.rs`,
but it should not inject a package `manifest.toml` or require a
`package.toml`. Platform artifacts need their own manifest/provenance shape.

### Homebrew

Homebrew package sidecars may reference the current platform artifact ABI and
status for diagnostics, but they must not own these artifacts and must not
list them as Formula dependencies. `cargo xtask homebrew-validate` can gain a
read-only check that the tap's `kandelo_abi` has a matching platform artifact
manifest available, but missing platform artifacts should be reported as
runtime/platform readiness, not as a Formula dependency failure.

### Registry Removal Guard

Add a registry-removal readiness check, for example:

```text
cargo xtask registry-removal-readiness
```

or a narrower first step:

```text
cargo xtask platform-artifacts validate --registry-removal
```

The check should fail if any of these are true:

- `packages/registry/kernel`, `packages/registry/userspace`, or
  `packages/registry/kandelo-sdk` exists as an accepted package identity after
  the new owner is enabled.
- Any of the three artifact IDs is missing from the platform manifest.
- An artifact has no owner, build command, release status, cache key,
  provenance, ABI, destination paths, or required validation policy.
- A successful artifact lacks archive sha/bytes/cache key.
- A failed or pending artifact lacks complete fallback metadata or an explicit
  "no fallback" reason.
- `kandelo-sdk` lacks explicit VFS image `kernelAbi` metadata.
- Node/browser support claims are not backed by outcome-list evidence.

## Alternatives Considered

Make the three artifacts Homebrew Formulae:

- Rejected. The kernel and userspace are boot/runtime state, not guest
  installable packages. The SDK VFS image is not yet a complete Formula-owned
  in-guest toolchain. Formula ownership would make package discovery cleaner
  by making runtime identity less truthful.

Keep the current `package.toml` and mark them `excluded`:

- Rejected as the end state. It would keep `packages/registry` as a hidden
  source of truth and would not satisfy registry removal. A temporary
  `excluded` disposition is acceptable only during the bridge phase while the
  new owner is implemented.

Put platform artifacts into Homebrew `Kandelo/metadata.json`:

- Rejected. That schema is intentionally package and bottle oriented:
  Formula path, dependencies, bottle tags, link manifests, and kegs are
  required package facts. Adding non-package entries would weaken validator
  clarity and make boot artifacts look installable.

Extend `index.toml` with non-package entries:

- Rejected as the primary model. The release ledger is package-shaped and
  keyed by package/version/revision/arch. A separate JSON manifest can still
  publish on the same release while keeping artifact-specific fields and
  validators explicit.

Use only local build scripts and documentation:

- Rejected. Fresh checkouts, npm package preparation, browser builds, and CI
  need durable materialization and fallback status. Docs-only ownership would
  not prevent registry deletion from losing artifacts.

## Risks And Mitigations

Split-brain artifact state:

- Risk: package `index.toml`, platform manifests, and local files disagree.
- Mitigation: move the three names out of accepted package discovery in one
  implementation sequence, and make materialization use the platform manifest
  as the only remote source for these artifact IDs.

Browser parity drift:

- Risk: Node boot works from a materialized kernel while browser imports still
  fail or use stale local files.
- Mitigation: require browser smoke before full support claims, and keep
  `tryResolveBinary("kernel.wasm")` as the shared lookup path for Vite aliases.

ABI false confidence:

- Risk: a kernel archive or SDK VFS image is present but ABI-incompatible.
- Mitigation: require `__abi_version`, host-adapter export checks,
  `abi/snapshot.json` checks, VFS `kernelAbi` metadata, and stale-artifact
  guards before publishing or materializing success.

SDK VFS path churn:

- Risk: moving `kandelo-sdk` out of `programs/wasm32` breaks consumers that
  have not been found yet.
- Mitigation: publish compatibility aliases for one migration wave and add a
  validator warning that points consumers to the platform path.

Release workflow complexity:

- Risk: adding a second release manifest increases operator burden.
- Mitigation: reuse existing state-lock, archive hashing, last-green fallback,
  and outcome-list patterns; add one focused `xtask platform-artifacts` command
  rather than scattering logic across shell scripts.

Premature registry deletion:

- Risk: maintainers delete package directories after seeing a design doc but
  before tooling lands.
- Mitigation: keep this as a plan, update reference docs only when the tooling
  lands, and make deletion checks block removal until manifest validation
  passes.

## Implementation Sequence

1. Add `platform/artifacts/` with schema, example, and README describing the
   non-package artifact contract.
2. Add `xtask platform-artifacts validate` with schema checks, required field
   checks, ABI release-tag matching, unique artifact IDs, status/fallback
   checks, destination-path safety, and SDK VFS `kernelAbi` checks.
3. Add a bridge manifest for `kernel`, `userspace`, and `kandelo-sdk` while the
   existing registry package directories still exist. Mark the package
   identities as bridge-only in a deterministic inventory check.
4. Move or wrap the three build scripts under the platform-artifact owner.
   Preserve command behavior and output names first; only then rename paths.
5. Add platform archive/provenance generation. Reuse archive hashing and
   last-green ideas, but do not write package `manifest.toml` files.
6. Add `xtask platform-artifacts materialize` and call it from
   `scripts/fetch-binaries.sh`. Preserve `kernel.wasm` and `userspace.wasm`
   lookup behavior for Node, browser, tests, and host packaging.
7. Update `host/src/binary-resolver.ts`, `scripts/resolve-binary.sh`, Vite
   aliases, and `scripts/prepare-host-package.sh` only where needed to read
   the new materialized paths or compatibility aliases.
8. Add Node and browser smoke recording for each artifact's required support
   claim. Keep skipped evidence explicit with reasons.
9. Add registry-removal readiness validation and make it fail if any of the
   three artifacts lacks manifest ownership.
10. Update `docs/binary-releases.md`, `docs/package-management.md`,
    `docs/homebrew-publishing.md`, `docs/sdk-guide.md`, and
    `docs/package-management-future-work.md` to reflect the implemented owner.
11. Remove the three package identities from accepted package discovery.
12. Delete or migrate `packages/registry/{kernel,userspace,kandelo-sdk}` only
    after validators and docs prove ownership has moved.

## Test And Documentation Plan

For this design artifact:

- Run docs-only whitespace validation.
- Do not run runtime, package, browser, ABI, libc, or POSIX gates because this
  document changes no behavior or artifacts.

For implementation:

- Add Rust unit tests for platform artifact schema parsing, unique IDs,
  status/fallback validation, release ABI matching, unsafe path rejection,
  missing owner rejection, and SDK VFS missing-`kernelAbi` rejection.
- Add tests proving package discovery and Homebrew Formula generation exclude
  the three artifact IDs after the platform owner is enabled.
- Add materialization tests proving `kernel.wasm` and `userspace.wasm` land at
  the same resolver-visible paths as today, and `kandelo-sdk.vfs.zst` has a
  compatibility alias until consumers migrate.
- Add negative tests for stale kernel exports, ABI mismatch, bad archive sha,
  bad cache key, and incomplete fallback metadata.
- Run `cargo test -p xtask` for validator, archive, and materializer changes.
- Run `cd host && npx vitest run` for binary resolver or host packaging
  changes.
- Run browser asset checks and targeted Playwright/browser smoke for changes
  that affect `@kernel-wasm`, browser boot, SDK VFS browser usage, or gallery
  eligibility.
- Run `bash scripts/check-abi-version.sh` if implementation changes kernel
  ABI metadata, generated ABI constants, kernel exports, or snapshot behavior.
- Run full gates from `CLAUDE.md` only when implementation touches runtime,
  host, VFS, ABI, libc, POSIX, or package behavior broadly enough to support
  that claim.

Documentation updates after implementation:

- `docs/binary-releases.md`: platform artifact manifest, release tag, fallback,
  and materialization behavior.
- `docs/package-management.md`: package registry removal boundary and why
  platform artifacts are not packages.
- `docs/homebrew-publishing.md`: Homebrew sidecars may diagnose platform ABI
  status but do not own platform artifacts.
- `docs/sdk-guide.md`: SDK VFS image ownership and browser/runtime support
  claims once implemented.
- `docs/package-management-future-work.md`: remove or replace the stale
  "Ship kernel.wasm + userspace.wasm in the release" note.

## Open Questions

- Should the durable release asset be named `platform-artifacts.json` on
  `binaries-abi-v<N>`, or should platform artifacts get a separate
  `platform-artifacts-abi-v<N>` release tag?
- Should `kandelo-sdk` eventually become a Formula after in-guest compiler
  ownership is designed, or remain a platform VFS artifact permanently?
- Which exact browser smoke proves SDK VFS compatibility: booting the image,
  compiling and running `/home/hello.c`, or a fuller toolchain workflow?
- Should `userspace` remain a separate artifact if kernel builds already copy
  it opportunistically, or should publication require an explicit userspace
  build step every time?
- Should platform-artifact status be surfaced in a Homebrew operator report,
  a binary-release report, or both?
- What retention policy should apply to old platform artifact archives once a
  last-green fallback moves forward?
