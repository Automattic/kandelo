# Kernel Test Fixture Ownership Outside Package Scope

Date: 2026-06-30

Tracked work:

- `kd-1mr` - Port all current Kandelo packages to Homebrew.
- `kd-u4sz` - Classify internal, source, and helper registry entries.
- `kd-nacw` - Move `kernel-test-programs` fixture inventory out of
  package scope.

This is a design artifact. It does not delete
`packages/registry/kernel-test-programs`, change fixture builds, publish
Homebrew bottles, or alter runtime behavior.

## Problem Statement

`packages/registry/kernel-test-programs/package.toml` currently describes a
small set of binaries used by host/kernel tests:

- `exec-caller.wasm`
- `exec-child.wasm`
- `fork-exec.wasm`
- `ifhwaddr.wasm`
- `mmap_shared_test.wasm`
- `hello.wasm`
- `hello64.wasm`

That manifest is not a real publishable package. It has no sibling
`build.toml`; `scripts/fetch-binaries.sh` skips it; and
`tests/package-system/browser-binary-dependencies.test.ts` has to exempt it
from the "every fetchable registry package has build.toml" rule. The manifest
survived as bridge-era metadata for V1 package aliases, not as a Homebrew
Formula candidate.

The Homebrew replacement model needs `packages/registry` to contain package
identities only. Keeping an internal host/kernel fixture inventory in that
tree creates three risks:

- Formula or package-discovery tools can accidentally treat fixtures as
  user-installable software.
- Registry deletion is blocked by metadata whose real owner is test tooling.
- Host/kernel tests can lose their rebuild map if the registry directory is
  deleted without a replacement manifest.

The durable fix is to move the fixture inventory to an explicit test-artifact
owner, update package/Homebrew discovery to exclude it, and add deletion
guards that fail when the registry entry is gone but the fixture owner is
missing.

## Non-Goals

- Do not make `kernel-test-programs` a Homebrew Formula.
- Do not publish these fixtures as bottles or package archives.
- Do not change POSIX, ABI, VFS, fork instrumentation, or host-runtime
  behavior.
- Do not use this migration to redesign every root `programs/*.c` test
  fixture. The first implementation should move the current
  `kernel-test-programs` inventory and leave broader fixture cataloging as a
  follow-up if it becomes useful.
- Do not preserve stale ownership of `hello.wasm` under
  `kernel-test-programs` if the GNU `hello` package or `examples/hello.wasm`
  is the clearer current owner.

## Users And Operator Workflows

Host/kernel test maintainers need a clear inventory of the Wasm fixtures they
depend on. When a host test fails because `exec-caller.wasm` or
`mmap_shared_test.wasm` is missing, the failure should point to
`scripts/build-programs.sh` and the fixture manifest, not to a package that
cannot be fetched or bottled.

Package and Homebrew maintainers need package discovery to mean "software that
can be built, cached, bottled, and installed as a package". Internal test
fixtures should not appear in package matrices, Homebrew Formula lists, tap
sidecars, package availability reports, or package registry exception lists.

Release and CI operators need deletion checks that are strict in the right
direction. Removing `packages/registry/kernel-test-programs` is safe only if a
test-artifact manifest exists and validates the expected fixture ownership.
Keeping the registry package should fail once the new owner lands, because it
would reintroduce ambiguous package identity.

Debuggers need resolver failures to route to the right layer. If
`resolveBinary("programs/fork-exec.wasm")` fails in a host test, the likely
action is to build or materialize test programs. It should not be interpreted
as a Homebrew package publication failure.

## Current Evidence

The existing registry manifest lists seven outputs and points at the Kandelo
repository itself with a placeholder all-zero source hash. It does not declare
`kernel_abi`, `[build]`, or a project `build.toml`.

`scripts/build-programs.sh` is the actual producer for root `programs/*.c` and
`programs/*.cpp` binaries. It writes wasm32 outputs under
`local-binaries/programs/wasm32/` and `hello64.wasm` under
`local-binaries/programs/wasm64/` when the wasm64 sysroot exists.

Host tests consume several of the listed outputs directly through
`resolveBinary()` or `tryResolveBinary()`:

| Output | Current consumer evidence |
|---|---|
| `exec-caller.wasm` | `host/test/exec.test.ts`; ABI marker check in `host/test/abi-version.test.ts` |
| `exec-child.wasm` | registered as `/bin/exec-child` by `host/test/exec.test.ts` |
| `fork-exec.wasm` | `host/test/exec.test.ts`; wasm32 pointer-width assertion in `host/test/wasm64.test.ts` |
| `ifhwaddr.wasm` | `host/test/ifhwaddr.test.ts` |
| `mmap_shared_test.wasm` | `host/test/mmap-shared.test.ts` |
| `hello64.wasm` | wasm64 pointer-width and runtime assertions in `host/test/wasm64.test.ts` |

`hello.wasm` is now ambiguous. The root test setup builds
`examples/hello.wasm` for host tests, and the current package registry also
contains a real GNU `hello` package with output `hello.wasm`. The migrated
fixture owner should not keep claiming `programs/hello.wasm` as part of
`kernel-test-programs` unless an implementation audit proves a host/kernel
test still needs that exact resolver path as an internal fixture. If a test
needs a trivial local program, prefer `examples/hello.wasm` or a fixture name
that cannot collide with a package.

Homebrew package discovery currently has two relevant surfaces:

- `scripts/homebrew-plan-matrix.sh` walks tap `Formula/*.rb`, not the Kandelo
  registry, so it will not discover `kernel-test-programs` unless someone adds
  a Formula.
- `scripts/homebrew-generate-sidecars-from-env.sh` still maps a Formula name
  to `packages/registry/<formula>/package.toml` to compute package facts and
  cache keys. The new fixture owner must not require this registry lookup to
  keep working for `kernel-test-programs`.

Package archive discovery has separate surfaces:

- `scripts/fetch-binaries.sh`, `.github/workflows/prepare-merge.yml`, and
  `.github/workflows/force-rebuild.yml` walk `packages/registry/*/package.toml`
  and only process entries with a build source. Deleting the fixture package
  removes it from this scan instead of changing runtime behavior.
- `tests/package-system/browser-binary-dependencies.test.ts` currently has a
  `registryPackagesWithoutBuildToml` exception for `kernel-test-programs`.
  That exception should be removed and replaced by an explicit fixture-owner
  validation.

## Architecture And Data Flow

Target ownership:

```text
programs/*.c and programs/*.cpp
        |
        v
scripts/build-programs.sh
        |
        v
local-binaries/programs/<arch>/<fixture>.wasm
        |
        v
host/kernel tests via resolveBinary()

tests/test-artifacts/kernel-test-programs.json
        |
        v
package-system deletion guard and fixture inventory validation
```

The proposed manifest path is:

```text
tests/test-artifacts/kernel-test-programs.json
```

Use JSON rather than `package.toml` so the file is visibly not a package
recipe and can be parsed by the existing TypeScript package-system tests
without adding TOML dependencies. The first schema can stay intentionally
small:

```json
{
  "schema": 1,
  "name": "kernel-test-programs",
  "owner": "host-kernel-tests",
  "producer": {
    "script": "scripts/build-programs.sh",
    "output_root": "local-binaries/programs"
  },
  "fixtures": [
    {
      "name": "exec-caller",
      "arch": "wasm32",
      "source": "programs/exec-caller.c",
      "binary": "programs/wasm32/exec-caller.wasm",
      "resolver_path": "programs/exec-caller.wasm",
      "consumers": ["host/test/exec.test.ts", "host/test/abi-version.test.ts"]
    }
  ]
}
```

Required invariants:

- `name` stays `kernel-test-programs` only as a fixture bundle name, not as a
  package name.
- `producer.script` points to the normal program-build path.
- Each fixture records source path, target arch, produced binary path, and at
  least one consumer or reason.
- wasm32 fixtures may record an implicit `resolver_path` such as
  `programs/exec-caller.wasm` because `host/src/binary-resolver.ts` maps that
  to `programs/wasm32/exec-caller.wasm`.
- wasm64 fixtures use explicit resolver paths under `programs/wasm64/`.
- The manifest does not carry package fields such as `version`, `source.url`,
  `license`, `depends_on`, `[build]`, `revision`, bottle metadata, or Formula
  metadata.

Control-flow changes:

1. Host tests continue resolving binaries by path. No runtime resolver
   behavior is required for this migration.
2. Package discovery ignores the fixture bundle because there is no
   `packages/registry/kernel-test-programs/package.toml`.
3. Homebrew Formula generation remains Formula-driven and package-driven; the
   fixture manifest is not a Formula input.
4. Package-system validation reads the fixture manifest and fails if:
   - the manifest is missing;
   - listed source files are missing;
   - listed consumers are missing;
   - a fixture has an unsafe or non-canonical binary path;
   - `packages/registry/kernel-test-programs/package.toml` still exists;
   - package registry exception lists still include `kernel-test-programs`;
   - any Homebrew tap template Formula named `kernel-test-programs.rb` appears.

## Alternatives Considered

Keep the existing registry package without `build.toml`.

- Rejected. This keeps a non-package identity in package discovery and
  preserves the exact exception that blocks registry deletion.

Add a `build.toml` and make the bundle publishable.

- Rejected. These are host/kernel test fixtures, not installable user
  software. Publishing them as packages would make Homebrew-all status look
  cleaner while weakening the package boundary.

Move the manifest under `host/test/fixtures/`.

- Viable, but less discoverable for registry deletion. `host/test/fixtures/`
  already owns WAT fixtures for specific tests; a top-level
  `tests/test-artifacts/` owner gives package-system validation a neutral
  place to assert the bridge migration and can later catalog other shared test
  artifacts.

Use TOML for the new manifest.

- Rejected for the first implementation. TOML would resemble a package recipe
  and would require either another ad hoc parser in TypeScript tests or moving
  the guard into Rust. JSON is enough for a static fixture inventory and keeps
  the non-package boundary obvious.

Delete the manifest without replacement because `scripts/build-programs.sh`
already builds everything.

- Rejected. The build script is a producer, not an ownership record. Without a
  manifest, future maintainers cannot tell which outputs are intentional
  host/kernel fixtures and which are incidental products of the broad
  `programs/*.c` loop.

Expand the manifest immediately to every root `programs/*` host fixture.

- Deferred. That could be useful, especially for DRI, virtual network, fork
  instrumentation, and audio test programs, but it is larger than the
  `kernel-test-programs` registry-removal blocker. The manifest shape should
  allow expansion after the initial safe move.

## Risks And Mitigations

Fixture provenance becomes too weak.

- Risk: moving out of `package.toml` could lose source and output mapping.
- Mitigation: the new manifest records source, arch, binary path, producer,
  resolver path, and consumer evidence for every migrated fixture.

Host tests silently skip because binaries are unavailable.

- Risk: tests using `tryResolveBinary()` may continue skipping if no fetched or
  locally built binary exists.
- Mitigation: do not rely on the manifest alone as test execution proof. The
  implementation should keep the existing host test behavior and separately
  run `cd host && npx vitest run` or focused host tests after changing test
  fixture resolution.

`hello.wasm` ownership stays ambiguous.

- Risk: the migration could preserve a stale claim over `programs/hello.wasm`
  while the GNU `hello` Formula/package also owns that output.
- Mitigation: audit current consumers before moving `hello`. Prefer removing it
  from the fixture bundle, switching host tests to `examples/hello.wasm`, or
  recording it as package-owned rather than test-fixture-owned.

Homebrew sidecars depend on registry manifests for cache keys.

- Risk: a future script could expect every package-like name in reports to have
  a registry directory.
- Mitigation: the fixture manifest must not enter Homebrew sidecar input. Add
  a guard that fails if `kernel-test-programs` appears in tap Formulae,
  Homebrew expected-cache-key inputs, or package availability reports.

Deletion guards become over-specific.

- Risk: a test that hardcodes the exact initial fixture list could block
  legitimate additions or renames.
- Mitigation: hardcode only the migrated legacy bundle as the minimum set.
  Allow additional fixtures if they satisfy the schema and consumer evidence.

Browser behavior is accidentally claimed.

- Risk: because Homebrew browser smoke and sidecars now exist, a fixture
  manifest could be mistaken for browser compatibility evidence.
- Mitigation: the manifest is test tooling only. It records no
  `runtime_support`, `browser_compatible`, bottle status, or gallery fields.

## Implementation Sequence

1. Add `tests/test-artifacts/kernel-test-programs.json` with schema `1`,
   producer details, and the non-ambiguous legacy fixture outputs:
   `exec-caller`, `exec-child`, `fork-exec`, `ifhwaddr`,
   `mmap_shared_test`, and `hello64`. Audit `hello` before deciding whether
   to migrate it, hand it to the real `hello` package, or switch its host-test
   consumer to `examples/hello.wasm`.
2. Add a package-system test, preferably beside
   `tests/package-system/browser-binary-dependencies.test.ts`, that validates
   the manifest shape, source files, consumer paths, canonical binary paths,
   and absence of `packages/registry/kernel-test-programs/package.toml`.
3. Remove `kernel-test-programs` from
   `registryPackagesWithoutBuildToml`. Keep `pcre2-source` and `sqlite-cli`
   until their own beads land.
4. Delete `packages/registry/kernel-test-programs/package.toml` and the empty
   directory.
5. Update comments in `scripts/fetch-binaries.sh` and any package-system test
   fixture comments that name `kernel-test-programs` as a no-`build.toml`
   registry package.
6. Update `packages/README.md`, `tests/README.md`, and
   `docs/repository-organization.md` so package docs no longer say the
   registry owns host/kernel smoke fixtures.
7. Add a Homebrew/package-discovery guard that fails if a tap template Formula
   or sidecar input named `kernel-test-programs` appears. If the eventual
   Formula generator uses a generated package list, make this a negative test
   at that generation boundary.
8. Run focused validation. At minimum:
   - `cd host && npx vitest run tests/package-system/browser-binary-dependencies.test.ts`
   - any new package-system test file added for the fixture manifest
   - focused host tests that consume migrated fixtures, if test code or
     fixture paths changed
   - `git diff --check`
9. Run broader validation when implementation changes more than docs and
   package-system guards:
   - `cd host && npx vitest run` for host/runtime fixture resolution changes
   - `scripts/run-posix-tests.sh` or `scripts/run-libc-tests.sh` only if the
     implementation changes syscall, libc, VFS, or kernel behavior
   - `bash scripts/check-abi-version.sh` only if ABI-adjacent files change

## Test And Documentation Plan

Design-only verification for this bead:

- Run whitespace/diff validation on this plan.
- Do not claim runtime tests pass, because this plan does not change runtime
  behavior.

Implementation verification should record:

- The exact fixture manifest validation command and result.
- The exact package-system test command and result.
- Whether focused host tests for `exec`, `ifhwaddr`, `mmap_shared`, `wasm64`,
  `abi-version`, and `worker-entry` were run, skipped, or unaffected.
- The complete list of package-registry exceptions before and after the
  migration.
- Confirmation that no `kernel-test-programs` Formula or Homebrew sidecar input
  exists.

Documentation updates:

- `packages/README.md`: remove the claim that
  `packages/registry/kernel-test-programs/` describes host/kernel smoke
  programs.
- `tests/README.md`: add `tests/test-artifacts/` as the owner of shared
  host/kernel test artifact manifests.
- `docs/repository-organization.md`: keep package tests and host/kernel tests
  separated, and name the test-artifact manifest as the exception-free owner.
- `docs/package-management.md`: only update if implementation changes package
  discovery behavior or registry-deletion policy beyond deleting this one
  fixture package.

## Open Questions

- Should `hello.wasm` be removed from the migrated fixture set because the real
  GNU `hello` package now owns `programs/hello.wasm`, or should one host test
  still require a package-independent resolver-path hello fixture?
- Should the first manifest be JSON only, or should a later `xtask`
  validator own a formal JSON schema under `tests/test-artifacts/`?
- Should all root `programs/*.c` host-test binaries eventually be cataloged in
  the same manifest family, or should only registry-removal blockers be
  inventoried?
- Should `scripts/build-programs.sh` grow an option to build only the fixtures
  named by `tests/test-artifacts/kernel-test-programs.json`, or is the current
  broad build acceptable for host test setup?
- Which operator report should show "test fixtures are owned" during final
  `packages/registry` deletion without making fixtures look like packages?
