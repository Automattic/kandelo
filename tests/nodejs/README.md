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

The compatibility goal is public Node 26 LTS APIs across all four hosts,
with explicit engine and platform limits. Implementation gaps remain
failures to close; platform limits must not be counted as passing support.

## Prepare and inspect without rebuilding

```sh
scripts/run-nodejs-library-tests.sh --prepare-only
scripts/run-nodejs-library-tests.sh --list --out .context/nodejs-inventory
```

Preparation verifies pinned archive and extracted-tree hashes, including
empty directories, entry kinds, links and permission modes. The default
cache is `.context/nodejs-lts-cache-v2`; older file-only verification
stamps are rejected. Use a fresh cache rather than reusing a weaker stamp. A
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

## Real TCP client regression

After preparing the normal shell product, this focused check compiles one
small C peer through the checkout's SDK, stamps its ABI contract, and runs
Node against its real IPv6 loopback listener. It checks address fallback,
local binding, actual endpoints, AbortSignal behavior and descriptor
release. It uses no JavaScript listening-server substitute.

```sh
export WASM_POSIX_RESOLUTION_POLICY=source-only-v1
export WASM_POSIX_SOURCE_ONLY_BINARY_ROOT="$PWD/local-binaries/source-only-v1"
for host in node chromium firefox webkit; do
  scripts/run-nodejs-network-tests.sh "$host"
done
```

Every invocation writes a fresh report; an explicit output directory is
accepted as the second argument and cannot overwrite an existing result.
Source tests also exercise intermediate-attempt deadlines, deduplication,
family ordering, cancellation and late completion through the actual
shared policy with a controlled private engine boundary. The guest test
covers real sockets, including cancellation racing immediate completion;
it does not establish pending external-TCP deadlines on every backend or
complete TLS handshake lifetime behavior.

## Current evidence and limits

- All 69 source/harness tests pass under the exact native Node 26.13.0
  reference, including execution of the assembled bootstrap and
  adversarial fixture-cache integrity checks.

- Native harness controls verify real flags/environments, assertion and
  exit-listener failures, skips, deadlines, process termination and
  spawn errors. Ten unchanged upstream cases pass in bounded
  3-to-10-case resumption; a changed deadline is rejected without
  changing results.

- The rebuilt normal shell product passes eleven Node-host core cases
  and the complete shared contract on Chromium, Firefox and WebKit. This
  covers the URL/Buffer/exit review findings, assertion brands and
  mismatches, positioned I/O, streaming stdin decoding, Response/Blob
  bodies and the existing process/stream checks.

- The resident-filesystem and IPv6 endpoint corrections pass 3,241 Rust
  workspace tests and doctests, the ABI snapshot check, and three
  unchanged Sortix C cases on both Node and Chromium under SourceOnly.
  The kernel keeps ABI 55. A full product rebuild, broad POSIX suites
  and performance comparisons have not run.

- Source isolation on native Node passed eleven unchanged codec files
  and five positioned-filesystem files. Six selected unchanged FileAPI
  WPT inputs passed 494 subtests with no skips. Assertion isolation passed
  seven of fourteen files; seven fail on messages, diffs, source
  expressions and unsupported native key comparisons. Other helpers and
  core APIs stayed native. These are source-conformance observations,
  not guest baseline passes or real browser WPT coverage.

- The source checks from the browser memory gate pass 161 host tests and
  seven protocol/ownership checks. The full application-switching and
  engine teardown gate remains unrun; its complete product preparation
  is deferred with the full rebuild.

- Two incomplete four-host baseline attempts are retained separately.
  Archive auditing first found an omitted empty WASI fixture directory,
  then upstream cases exposed missing documentation and source headers.
  The composer now copies the complete pinned source archive, preserving
  directories, modes, files and links. Guest readiness checks empty
  directories and reads documentation, headers and the root license.
  The resulting image fits the existing capacity; no ceiling was raised.
  Browser pages cache immutable input bytes and copy them for each fresh
  kernel, without sharing mutable guest state.

## Complete initial baseline (2026-10-31)

All four reports completed the same 5,147-case inventory at
`66db9db1f640afdb57a1a91e79c06df4653c74de`, using the complete source
archive and the targeted normal shell product. Every case has retained
stdout/stderr and exactly one result. The audit found zero per-case
status/exit-code differences across hosts and matching kernel, base image,
suite image and input hashes.

| Host | Pass | Fail | Upstream skip | Unsupported | Timeout | Harness error | Pending |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Node 24.15.0 host | 3 | 3,721 | 0 | 1,423 | 0 | 0 | 0 |
| Chromium 153.0.8010.12 | 3 | 3,721 | 0 | 1,423 | 0 | 0 | 0 |
| Firefox 155.0 | 3 | 3,721 | 0 | 1,423 | 0 | 0 | 0 |
| WebKit 26.6 | 3 | 3,721 | 0 | 1,423 | 0 | 0 | 0 |

The guest API target on every host is Node 26.13.0. Node 24 in this table
is the independent execution host, not the API target. Each completed
runner exits 1 because cases failed; that is not a harness incident.

The passing files are `test-regression-object-prototype.js`,
`test-vm-not-strict.js` and `test-zlib-no-stream.js` in `parallel/`.
Their assertions remain unchanged. A passing file is not complete module
coverage, and export presence is not implementation coverage.

The failures on each host group as follows:

| Failure cluster | Cases | Representative |
| --- | ---: | --- |
| Missing net family-attempt timeout API in `test/common` | 3,687 | `parallel/test-assert-async.js` |
| Side-effect ESM import rewriting | 32 | `parallel/test-cli-node-cli-manpage-env-vars.mjs` |
| Incorrect `require.main` identity | 1 | `parallel/test-cli-eval.js` |
| EventEmitter listener defaults and warning dispatch | 1 | `parallel/test-global-console-exists.js` |

Most test bodies are blocked by a shared helper prerequisite. These are
not 3,687 independently diagnosed networking bugs, and this baseline does
not establish the behavior of the blocked core modules. Five minimal
native-versus-guest programs confirm the four clusters: all five succeed
under the pinned native reference and fail in the guest. No harness shim
supplies the missing APIs or alters upstream source.

Reports are retained under `.context/node26-v3-full-HOST/`, with the
combined audit at `.context/node26-v3-baseline-audit.json`. The runtime
kernel hash is
`36d97bfbef2e46a8813de186742daf4b1cc07803822b3830bfdca96e37393258`;
the suite image hash is
`172a0fa13b365e250fc5fe18c03380014388da8f8e66087ba77184808c479673`.
The manifests bind the remaining artifact and source identities.

These runs used `--all --limit 500 --timeout 30`, resuming unchanged
reports until pending reached zero. For a new run, choose a fresh output
directory and repeat the second command until complete:

```sh
scripts/run-nodejs-library-tests.sh --host node --all \
  --limit 500 --timeout 30 --out .context/nodejs-new-node
scripts/run-nodejs-library-tests.sh --host node --all \
  --limit 500 --timeout 30 --out .context/nodejs-new-node --resume
```

Use separate output directories for `chromium`, `firefox` and `webkit`.
The wrapper enters the declared dev shell and never compiles products.

The next work is real networking defaults and connection attempts, then
a fresh four-host run to expose the blocked test bodies. The ordered
backlog also includes loader identity/import parsing, EventEmitter
warnings, assertion diagnostics/native key support, and the partial APIs
listed in `packages/registry/node-compat/README.md`. The other 37 upstream
categories still need configuration and fixture review.

Earlier 3,925-case results in `docs/software-unit-tests.md` used an older
harness and source version. They are historical and do not establish
current LTS compatibility.
