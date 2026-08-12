# Task 2 report: preserve the lazy shell in derived images

Date: 2026-08-12

## Result

All five products derived directly from the canonical ABI-42 shell now retain
its flat-lazy Homebrew authority through capacity rebase, product writes,
serialization, and reload. Their builders do not fetch a bottle tree. Each
resolver-built artifact restored at 768 MiB, verified its imported atomic
seals, named the exact 5,730,802-byte canonical shell, and passed the existing
real boot adapter's 38 -> 35 -> 35 transition with three first-boot fetches and
zero repeat fetches.

The legitimate affected closure is `node-vfs`, `nginx-vfs`,
`nginx-php-vfs`, `lamp`, and `wordpress`. All five directly serialize the
shell bytes and metadata through `shell-vfs-build.ts`, so the implementation
changes their outputs. No unrelated package revision was used as a progress
marker. ABI remains 42.

## RED evidence

The baseline focused suite passed 30 tests before the new regression fixture:

```text
scripts/dev-shell.sh npm --prefix host test -- --run \
  test/shell-vfs-build.test.ts

Test Files  1 passed (1)
Tests       30 passed (30)
```

The new flat-lazy save/reload/rebase test was added before the metadata
implementation. It failed at the legacy/eager projection boundary:

```text
scripts/dev-shell.sh npm --prefix host test -- --run \
  test/shell-vfs-build.test.ts -t 'preserves flat-lazy metadata'

FAIL  test/shell-vfs-build.test.ts
Error: shell-derived VFS mixes flat and legacy Homebrew composition bindings
```

The existing broad package-system suite also reproduced the two declared-input
defects handed off by Task 1:

```text
scripts/dev-shell.sh npx --prefix host vitest run --root . \
  tests/package-system/build-input-import-closure.test.ts

FAIL  node-vfs omits host/src/shell-runtime-layout.ts
FAIL  nginx-vfs omits host/src/shell-runtime-layout.ts
Tests  16 passed, 2 failed
```

The first PHP-derived source build revealed that `NodeKernelHost.init()` would
activate the normal shell boot adapter while opcache was being prewarmed. The
focused test failed before the build-time guard existed:

```text
scripts/dev-shell.sh npm --prefix host test -- --run \
  test/opcache-prewarm.test.ts -t 'does not boot a flat-lazy image'

AssertionError: expected "init" to not be called at all, but actually been
called 1 times
```

WordPress database installation still requires a kernel guest. Its focused
build-guest test was added before the snapshot helper and failed as expected:

```text
scripts/dev-shell.sh npm --prefix host test -- --run \
  test/shell-vfs-build.test.ts -t 'suppresses flat-lazy boot only'

TypeError: saveShellDerivedBuildGuestSnapshot is not a function
```

## Implementation

- `shell-vfs-build.ts` now recognizes the canonical `homebrewFlatLazy`
  lineage before the eager and retired formats. It validates and projects the
  selection, policies, mirror, partition, bootstrap ownership, shell config,
  and demo binding while retaining pending package trees and direct shell
  identity.
- The derived save path continues to restore with source capacity, verify
  imported seals before copying, rebase to the exact 768 MiB product profile,
  and serialize the pending transports without materialization.
- PHP opcache warming explicitly skips a flat-lazy build filesystem because
  its optional kernel boot would otherwise fetch the runtime cohort during
  image construction. PHP remains correct and warms its cache on first use.
- Required WordPress/MariaDB preinstallation uses a transient private snapshot
  with only the `homebrewFlatLazy` host-boot trigger omitted. The product
  filesystem and every pending descriptor remain unchanged; the focused test
  reloads that snapshot and verifies its atomic seals and identical pending
  entries.
- `node-vfs` and `nginx-vfs` now declare their existing indirect import of
  `host/src/shell-runtime-layout.ts`.
- Package and browser documentation now describes revision 24's canonical
  lazy shell and the rebuilt derived closure instead of revision 23's retired
  eager behavior.

## Revision rationale and generated projection

| Package | Revision | Why bytes/index identity change |
|---|---:|---|
| `node-vfs` | 16 | Directly uses the changed derived-image projection, preserves lazy metadata, and adds the missing direct build input. |
| `nginx-vfs` | 4 | Directly uses the changed projection and adds the missing direct build input. |
| `nginx-php-vfs` | 4 | Directly uses the changed projection; flat-lazy construction also changes the optional prewarm path. |
| `lamp` | 13 | Directly uses the changed projection; its WordPress/MariaDB build guest must avoid shell boot and optional opcache fetches. |
| `wordpress` | 14 | Directly uses the changed projection; its required SQLite preinstall guest must avoid shell boot and optional opcache fetches. |

`packages/registry/program-packages.json` was regenerated with the canonical
xtask generator and checked. Final wasm32 cache keys are:

| Package | Cache key |
|---|---|
| `node-vfs` | `ab37fd146e59aacee0bc4fac733af7b6566841da655697548d2af2b1da967ff6` |
| `nginx-vfs` | `0673b9adc32a94ae1496eaff7ea324c23840eab8108b35ccd4a19debd70ce615` |
| `nginx-php-vfs` | `29df3483df48325cc198c63b9588f4857a01f59aaa8a961075b344076142e9a3` |
| `lamp` | `d940f5a109fa214162830121082cff879bc9570ffe2c94c1b77ddaab03d52610` |
| `wordpress` | `b1da11fd657c63d17dd31234662d15eae2b1b1076e4c17434a7dc40abf31ecb4` |

## Resolver builds and artifact inspection

Each product was built through the resolver with the same fresh binary root:

```text
scripts/dev-shell.sh cargo run -p xtask \
  --target aarch64-apple-darwin -- build-deps --arch wasm32 \
  --binaries-dir /tmp/kandelo-lazy-shell-task2-final.qXNcIo \
  --force-source-build resolve <package>
```

The command succeeded separately for `node-vfs`, `nginx-vfs`,
`nginx-php-vfs`, `lamp`, and `wordpress`. The PHP-derived logs included
`[opcache-prewarm] skipped for flat-lazy shell image`; WordPress SQLite and
LAMP MariaDB/WordPress preinstallation completed through their transient build
guests.

The exact resolver artifacts were decompressed and restored with
`MemoryFileSystem.fromImagePreservingCapacity()`. The probe verified imported
atomic seals and compared the inherited flat-lazy, bootstrap, shell, and
package-tree bindings across all five products. It fetched the exact libyaml
and Ruby bottles through the authenticated GHCR fetch helper and the exact
resolver-built bootstrap ZIP, then invoked
`prepareHomebrewFlatLazyBoot()` twice.

| Product | Compressed bytes | SHA-256 | Raw bytes | Capacity | ABI | Pending | Fetches |
|---|---:|---|---:|---:|---:|---|---|
| `node-vfs` | 16,028,253 | `ea515331a388e8d4d819a907fdc9f38d5acbc2f05fea02d225efc27340cee4bc` | 544,455,737 | 805,306,368 | 42 | 38 -> 35 -> 35 | 3 -> 0 |
| `nginx-vfs` | 6,568,911 | `af95bcdd0939b4b6caab7d09481d4970083eb8b91e2303a6991493df7f18510f` | 544,455,737 | 805,306,368 | 42 | 38 -> 35 -> 35 | 3 -> 0 |
| `nginx-php-vfs` | 12,816,975 | `c01fbc92453ac5b5dcaed6fcaf6f475e5a7dcfa96272b64b1207a44b6fac720b` | 544,455,737 | 805,306,368 | 42 | 38 -> 35 -> 35 | 3 -> 0 |
| `lamp` | 40,380,036 | `5b62eb7db54d9af57c8ae5fea2a45600babba6555f143725e916df6ac38c75a4` | 544,455,736 | 805,306,368 | 42 | 38 -> 35 -> 35 | 3 -> 0 |
| `wordpress` | 37,235,638 | `84988f8d5ecffe48dbeb321c9a2795635de6240b0c486c31d8cbd45d27059da5` | 544,455,736 | 805,306,368 | 42 | 38 -> 35 -> 35 | 3 -> 0 |

Every artifact records this exact direct shell base:

- compressed bytes: 5,730,802;
- SHA-256:
  `5000efa83ba6f19df259cd497f6f609c25e56bb9ad74df38fcceeeb37cdedcec`;
- mirror collection SHA-256:
  `d5aa52c246ccb9a93751ef2c57c93e18a798cc1637ddd57f921fea957a61f48b`;
- mirror plan SHA-256:
  `0eaf1454cd94eeddf45fe508e6a727f75344398540c5f84f33b85a9509b988ff`.

## GREEN verification

All claims below ran through `scripts/dev-shell.sh`:

```text
scripts/dev-shell.sh npm --prefix host test -- --run \
  test/shell-vfs-build.test.ts test/opcache-prewarm.test.ts
# 2 files passed; 35 tests passed

scripts/dev-shell.sh npx --prefix host vitest run --root . \
  tests/package-system
# 21 files passed; 190 tests passed

scripts/dev-shell.sh npm --prefix host run typecheck
# DTS build success

scripts/dev-shell.sh cargo run -p xtask \
  --target aarch64-apple-darwin -- build-deps program-index-check \
  --source-repo-root "$PWD" "$PWD/packages/registry" \
  "$PWD/packages/registry/program-packages.json"
# pass

scripts/dev-shell.sh bash scripts/check-abi-version.sh
# ABI snapshot, header, and TypeScript bindings are in sync; ABI_VERSION is
# consistent

git diff --check HEAD
# pass
```

## Changed files

- `images/vfs/scripts/shell-vfs-build.ts`
- `images/vfs/scripts/wordpress-preinstall.ts`
- `images/vfs/scripts/opcache-prewarm.ts`
- `host/test/shell-vfs-build.test.ts`
- `host/test/opcache-prewarm.test.ts`
- `packages/registry/{node-vfs,nginx-vfs,nginx-php-vfs,lamp,wordpress}/build.toml`
- `packages/registry/node-vfs/package.toml`
- `packages/registry/program-packages.json`
- `docs/package-management.md`
- `docs/browser-support.md`
- this report

## Validation not run and concerns

- Playwright and manual browser validation were not run, as required by the
  task. No publication or workflow action was performed.
- The authenticated lazy mirror release is still not published, so its sealed
  GitHub release URLs return 404. Artifact boot was therefore verified against
  the exact local authenticated cohort bytes, as in Task 1.
- Optional PHP opcache prewarming is deliberately skipped for flat-lazy build
  filesystems to keep image construction network-free. The PHP products remain
  functional but begin with a cold opcache.
- The repository's Cargo default target is Wasm; host xtask commands on this
  machine require the explicit `aarch64-apple-darwin` target shown above.
- Existing unrelated dirt in `libc/musl`, `tests/sortix/os-test`, `.serena/`,
  and `apps/browser-demos/test-results/` was preserved and excluded.
