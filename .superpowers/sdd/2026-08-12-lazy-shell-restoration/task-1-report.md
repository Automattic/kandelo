# Task 1 report: canonical lazy shell package

Date: 2026-08-12

## Result

The canonical `shell` package now builds the active flat Homebrew selection
through `composeHomebrewFlatLazyVfs()`. It embeds the selected Bash closure,
keeps 38 trees deferred, consumes an exact source-built
`homebrew-bootstrap` companion, emits a sealed 37-asset mirror handoff, and
ships a 5,730,802-byte compressed VFS image. No ABI files or publication
workflows changed.

The resolver-built artifact passed the required boot transition: the first
touch of `/opt/kandelo/homebrew/bin/brew` fetched exactly libyaml, Ruby, and
the bootstrap ZIP, reducing the pending set from 38 to 35 groups. A second
touch fetched nothing.

## RED

The focused CLI/package test was added before the implementation. Against the
eager recipe it failed because:

- `packages/registry/shell/package.toml` had no direct bootstrap dependency;
- the canonical lazy CLI did not exist; and
- the registered companion still described Homebrew
  `6.0.4-3-gd6c1be4`, ABI 41, revision 5.

After adding the parser, the CLI argument case passed while the shell recipe
and companion identity cases remained red. The first companion source probe
also showed why a source revision change alone was insufficient:

| Probe | Bytes | SHA-256 |
|---|---:|---|
| Raw patched `git archive` at `cf5bc21` | 5,305,826 | `76329a564399f00b551c85c0d46c18487273f71b8571d03346a2938252dd1c97` |
| Active selection requirement | 5,251,369 | `26ac98e328573244d3e7c0c149f30114ef5d9c8882200f5a22e56f97d2541482` |

Repacking that exact prepared tree with the repository's existing
`create-deterministic-zip.sh` produced the active selection bytes exactly.
The existing environment output was already the required 210-byte
`2eb3f057...` object.

The first end-to-end shell attempt then exposed a second useful RED boundary:
the composer returned 544,464,711 raw VFS bytes, which the new strict
`< 10485760` shell gate rejected. A focused serialization test first failed
because no compressed lazy-artifact function existed. The CLI was then wired
through the existing verified VFS serializer and the report was rebound to
the shipped compressed bytes.

Two operational failures were diagnosed without product workarounds:

- invoking host `xtask` without an explicit host target inherited the
  repository's Wasm Cargo default and failed while compiling host-only
  `getrandom`; all resolver evidence below uses
  `--target aarch64-apple-darwin`;
- Nix's tracked-source snapshot could not see the new untracked CLI, so the
  file was staged before the real package build.

## GREEN implementation

### Canonical CLI and shell recipe

- Added the small 13-flag lazy CLI for the selection, two policies, platform
  base, exact bootstrap outputs, bottle cache, mirror identity/output, shell
  and demo configs, image, and report.
- Reused the eager flat CLI's bounded no-follow reads, digest-addressed bottle
  cache/fetch path, and atomic output publisher rather than creating another
  schema or cache implementation.
- Reused the existing selection, policy, base-image, shell-config, and
  demo-config parsers and the existing verified VFS compressor.
- Authenticated both bootstrap support outputs against the descriptor's exact
  byte count and SHA-256 before composition.
- Wrote the mirror handoff into a private directory with exact digest checks.
- Switched the canonical shell recipe to this CLI, restored the direct
  bootstrap dependency, declared the complete import closure, bumped revision
  23 to 24, and enforced the requested strict compressed-size gate.
- Kept the package's only published output as `shell.vfs.zst`; the report,
  bottle cache, base image, and mirror handoff remain private build artifacts.

### Bootstrap companion

- Aligned the portable package to Homebrew source commit
  `cf5bc21c6b127e168ef7cfa982ba7db62874690e`, version
  `6.0.12-153-gcf5bc21`, ABI 42, and build revision 6.
- Preserved raw prepared-tree provenance while deterministically normalizing
  its ZIP to the selected formula output identity.
- Extended the existing source lock to authenticate both the normalized ZIP
  and environment output; no replacement schema was introduced elsewhere.
- Added only the genuinely required `zip`/`unzip` native tools and deterministic
  ZIP script to the recipe/cache identity.

### Generated resolver projection

`packages/registry/program-packages.json` was regenerated and checked. The
important new identities are:

- `homebrew-bootstrap` wasm32 cache key:
  `adae2e6dde1174841ce310a7bef93dc6b13967bef3d1fea8c62c4bc780318e29`
- `shell` manifest SHA-256:
  `9f33aafbf2a96a74c41938460bca83189c221fd9721d58d6b9e7e5902d848c65`
- `shell` wasm32 cache key:
  `0b8b76bcd952af941e5a0e9159c2320706c3a8c6bc7d43b84bec3d00e9f6d165`

Expected reverse-dependent cache keys changed because the shell dependency
closure now includes `homebrew-bootstrap`; no unrelated recipe revision was
changed.

## Artifacts and inspection

### Bootstrap

Resolver output:

`~/.cache/kandelo/programs/homebrew-bootstrap-6.0.12-153-gcf5bc21-rev6-wasm32-adae2e6dde1174841ce310a7bef93dc6b13967bef3d1fea8c62c4bc780318e29`

| Output | Bytes | SHA-256 |
|---|---:|---|
| `homebrew-bootstrap.zip` | 5,251,369 | `26ac98e328573244d3e7c0c149f30114ef5d9c8882200f5a22e56f97d2541482` |
| `homebrew-brew.env` | 210 | `2eb3f05703b6a6f23feabda24f622bacd068115c7f74a0eac51bb4085e9eec5a` |

Additional locked source evidence:

- upstream source archive: 3,851,321 bytes,
  `18d3c5384b1a90e0dca3c044b31d8a2b61b500bc5b880a14b1e52a590088de40`;
- patched tree Git OID: `ae657d9bdebaa2218527f3e3a6b8b51e6907d365`;
- normalized patched-tree TAR SHA-256:
  `1a29720ca3ab7368940dc873396d93709e897bacc1b16cb9d9f153276546a2a3`;
- prepared portable Ruby `4.0.6`, Git `2.51.2`.

### Shell

Resolver output:

`~/.cache/kandelo/programs/shell-0.1.0-rev24-wasm32-0b8b76bcd952af941e5a0e9159c2320706c3a8c6bc7d43b84bec3d00e9f6d165/shell.vfs.zst`

| Property | Value |
|---|---:|
| Compressed bytes | 5,730,802 |
| Compressed SHA-256 | `5000efa83ba6f19df259cd497f6f609c25e56bb9ad74df38fcceeeb37cdedcec` |
| Strict cap | 10,485,760 |
| Headroom | 4,754,958 |
| Initial deferred groups | 38 |
| Deferred archive bytes | 53,367,761 |
| Deferred expanded bytes | 200,018,444 |
| Deferred payload bytes | 196,211,745 |
| Deferred entries | 17,837 |

Sealed mirror identity:

- repository: `kandelo-dev/homebrew-tap-core`;
- tag:
  `homebrew-shell-bottles-sha256-d5aa52c246ccb9a93751ef2c57c93e18a798cc1637ddd57f921fea957a61f48b`;
- collection SHA-256:
  `d5aa52c246ccb9a93751ef2c57c93e18a798cc1637ddd57f921fea957a61f48b`;
- plan SHA-256:
  `0eaf1454cd94eeddf45fe508e6a727f75344398540c5f84f33b85a9509b988ff`;
- plan bytes: 19,901; payload assets: 37.

### Boot transition

The final resolver-built `shell.vfs.zst` was restored, imported atomic seals
were verified, and its sealed URLs were served from the generated local mirror
plus the resolver-built bootstrap output.

| Point | Groups | Archive bytes | Entries | New fetches |
|---|---:|---:|---:|---:|
| Before brew touch | 38 | 53,367,761 | 17,837 | 0 |
| First brew touch | 35 | 40,897,943 | 11,114 | 3 |
| Second brew touch | 35 | 40,897,943 | 11,114 | 0 |

The first three assets were exactly:

1. `kandelo-homebrew-bottle-libyaml-80c927883bbbc995-layer.bin`
2. `kandelo-homebrew-bottle-ruby-c670cea14298b55d-layer.bin`
3. `homebrew-bootstrap.zip`

The remaining 35 groups are the ordinary bottle trees. The second call
returned `false`, confirming the atomic cohort was not downloaded again.

## Verification commands

All build and test claims ran through `scripts/dev-shell.sh`.

```bash
scripts/dev-shell.sh npm --prefix host test -- --run \
  test/homebrew-flat-lazy-vfs-cli.test.ts \
  test/homebrew-flat-lazy-vfs-composer.test.ts
# 40 passed

scripts/dev-shell.sh bash packages/registry/shell/test-build-shell.sh
# test-build-shell: ok

scripts/dev-shell.sh npx --prefix host vitest run --root . \
  tests/package-system/homebrew-bootstrap-package.test.ts
# 5 passed

scripts/dev-shell.sh npx --prefix host vitest run --root . \
  tests/package-system/build-input-import-closure.test.ts \
  -t 'shell declares every repository-local relative import'
# 1 passed, 17 skipped

scripts/dev-shell.sh bash scripts/test-homebrew-bootstrap-source.sh
# test-homebrew-bootstrap-source: pass

scripts/dev-shell.sh cargo run -p xtask \
  --target aarch64-apple-darwin -- build-deps program-index \
  --source-repo-root "$PWD" packages/registry \
  packages/registry/program-packages.json

scripts/dev-shell.sh cargo run -p xtask \
  --target aarch64-apple-darwin -- build-deps program-index-check \
  --source-repo-root "$PWD" "$PWD/packages/registry" \
  "$PWD/packages/registry/program-packages.json"
# pass

scripts/dev-shell.sh cargo run -p xtask \
  --target aarch64-apple-darwin -- build-deps --arch wasm32 \
  --binaries-dir /tmp/kandelo-lazy-shell-task1-final.vldvFd \
  --force-source-build resolve shell
# Built shell.vfs.zst (5000efa8..., 5730802 bytes; 38 deferred trees)

scripts/dev-shell.sh npm --prefix host run typecheck
# declaration build passed

git diff --check HEAD
# pass
```

A final `tsx -e` probe restored the exact resolver artifact with
`MemoryFileSystem.fromImagePreservingCapacity()`, called
`verifyImportedLazyAtomicGroupSeals()`, installed a local authenticated fetcher
for the retained mirror, and called `ensureMaterialized()` twice on
`/opt/kandelo/homebrew/bin/brew`. Its exact counts are recorded above.

The broad package-system sweep was also run:

```bash
scripts/dev-shell.sh npx --prefix host vitest run --root . tests/package-system
# 188 passed, 2 failed
```

Both failures are unchanged, out-of-scope input-closure defects in
`nginx-vfs` and `node-vfs`: each omits
`host/src/shell-runtime-layout.ts`, imported by the already-existing
`images/vfs/scripts/shell-runtime-layout.ts`. The `shell` case in the same
suite passes. Neither failing package nor shared layout file was modified by
this task.

## Concerns and deferred work

- The sealed mirror release tag does not yet exist remotely (the generated
  URLs currently return 404). This task intentionally stops at the package
  build and local authenticated mirror handoff; publishing that release is a
  later product/publication step. No publication workflow was changed.
- The repository's Cargo default target is Wasm, so direct host `xtask`
  invocations on this machine require the explicit host target shown above.
- The broad package-system sweep retains the two unrelated nginx/node closure
  failures described above; the scoped shell closure check is green.
- ABI remains 42 for the selected artifacts. `ABI_VERSION` and
  `abi/snapshot.json` were not changed.
- Existing worktree dirt in `libc/musl`, `tests/sortix/os-test`, `.serena/`,
  and `apps/browser-demos/test-results/` was preserved and is not part of this
  task.
