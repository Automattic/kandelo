# Pinned Node.js compatibility tests

`packages/registry/node-compat/target.json` pins the guest API target and
matching upstream source/native reference archives. It currently targets
Node **26.13.0 (Lithium LTS)**, verified against the official distribution
index on October 31, 2026. Source tag `v26.13.0` resolves to
`18b32a3b1552e199a01f1a8d9fd64aa756d3b75b`.

The host/build toolchain remains the repository's declared Node 24.
`--host native` means the checksum-verified reference binary, whereas
`--host node` means Kandelo running on the Node host. A compatibility target
is not a claim of full Node conformance.

## Prepare and inspect without rebuilding

```sh
scripts/run-nodejs-library-tests.sh --prepare-only
scripts/run-nodejs-library-tests.sh --list --out .context/nodejs-inventory
```

Preparation verifies pinned archive and extracted-tree hashes. A
harness-owned CommonJS package boundary surrounds the cache so embedding
it beneath this repository does not change upstream module semantics.
Upstream sources, fixtures, helpers, assertions and package files remain
unchanged. Downloads and source image composition never compile packages.

`inventory.json` contains all 5,147 `parallel`/`sequential` cases from this
pin, their source hashes, real flags and environment requirements. Both
`.js` and `.mjs` tests are included, matching Node testpy's filename rule.
An accompanying audit counts candidate files in the other 37 categories.
Those categories need their own configuration/build/fixture review and are
outside this initial baseline; the inventory is not the entire Node test
repository or the official Python runner's status-filtered result set.

## Run bounded, resumable batches

```sh
# Native reference, complete parallel/sequential inventory in bounded batches:
scripts/run-nodejs-library-tests.sh --host native --all \
  --out .context/nodejs-native --limit 100 --timeout 30
scripts/run-nodejs-library-tests.sh --host native --all \
  --out .context/nodejs-native --limit 100 --timeout 30 --resume

# Guest hosts, after rebuilding products through the normal build graph:
scripts/run-nodejs-library-tests.sh --host node --all \
  --out .context/nodejs-node --limit 100
scripts/run-nodejs-library-tests.sh --host chromium --all \
  --out .context/nodejs-chromium --limit 100
# Use separate reports for --host firefox and --host webkit.
```

Selectors can name a category, an exact category/file, or a
filename (all matching categories). Each report pins the selected inventory; a filtered report is
never a full-inventory baseline. Shell setup may print toolchain messages
before stdout JSON; the files under `--out` are the machine-readable
report contract.

The manifest binds target/source, per-case metadata, runner sources,
timeout, host toolchain, reference binary or guest image/kernel/assets,
browser version, host runtime source/built files, and toolchain inputs. Resume refuses a different contract or duplicate
rows. Full stdout/stderr logs are retained per case. The summary explicitly
counts finalized and pending cases and whether the selected inventory is
complete. Exit 1 indicates failure/timeout/harness errors; exit 2 indicates
an incomplete or unsupported run. Unsupported is never passing support.

Outcomes are `pass`, `fail`, `upstream-skip`, `unsupported`, `timeout`, and
`harness-error`. TAP failures cannot become passes merely because a runner
exits zero. Raw failures are retained; upstream expected-failure/platform
status files do not turn them green. RLIMIT_AS metadata is explicitly
unsupported until a resource-limit launcher exists.

Native cases receive actual CLI flags and metadata environments. Guest
flags require verified CLI mappings; unmet requirements are recorded as
unsupported. No test wrapper fabricates `process.execArgv`, supplies fake
`net` methods, or changes upstream assertions. `node:test` cases receive
the real reporter flags used by testpy. Guest readiness checks require the
pinned version/platform and reject known assertion false positives before
any upstream passing counts can be produced.

Native deadlines terminate the test's process group, including remaining
members after a normal parent exit. Guest cases use fresh kernels and
normal VFS launches; teardown is awaited. Browser runs own loopback input
and Vite servers and do not attach to a user's demo.

## Source checks without product rebuilds

```sh
scripts/dev-shell.sh bash -c \
  'cd host && npx vitest run --config vitest.node-core.config.ts'
```

The config contains only source-classified tests and omits the prepared
product/C-fixture global setup. To use the exact LTS oracle, prepare it
first and replace `npx vitest` with its absolute `bin/node` path followed by
`node_modules/vitest/vitest.mjs` from `host/`. The runner's host/build Node
version and the pinned reference are separate identities.

## Current evidence and limits

- Fifteen source/harness tests pass under the exact native Node 26.13.0
  reference: nine URL/exit/Buffer contracts and six harness tests.
- Native harness controls verify real flags/environments, assertion and
  exit-listener failures, skips, deadlines, process termination and spawn
  errors. Bootstrap generation is checked without compiling the engine.
- Ten unchanged upstream URL, exit-code, positional-read validation and
  streaming-decoder tests pass on the pinned native reference.
- Existing products boot through this runner on Node, Chromium, Firefox
  and WebKit and are correctly rejected at the old Node 22 identity. No
  upstream passing counts are produced from those stale products.
- The complete 5,147-case native baseline has not run. Guest baselines and
  three-engine integration remain unrun on updated products. The user
  deferred a full rebuild; existing products predate the new target.
- Existing guest `assert` false positives must be fixed before its
  readiness check can pass. Other known gaps include positioned descriptor
  offsets, response consumption and streaming UTF-8. These are runtime
  work, not harness shims.

Earlier 3,925-case results in `docs/software-unit-tests.md` used an older
harness and source version. They are historical and do not establish
current LTS compatibility.
