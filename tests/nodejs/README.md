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

The active completion goal extends beyond the initial baseline and first
fixes. Completion requires an audited public-API matrix and behavioral
evidence for Node, Chromium, Firefox and WebKit. The matrix must cover
documented exports, inherited methods, globals used by core modules,
aliases, descriptors, errors, asynchronous ordering and resource lifetime.
Documented experimental and legacy APIs stay in the inventory with their
real activation requirements. An experimental flag or upstream skip is
not permission to omit an implementation gap.

Reference discovery must combine the pinned API documentation, native
exports and upstream builtin exposure policies. Option-gated modules can
be absent from the default builtin list. Export discovery is a review
inventory, never a compatibility score; getter presence does not validate
its behavior, and own properties do not cover inherited APIs.

For each API, retain its upstream document/symbol, per-host state and
test evidence bound to actual source and runtime identities. Unknown,
partial, failed, skipped and unsupported states remain distinct. A
documented engine/platform boundary needs a concrete capability reason;
ordinary missing code, option handling, native bindings and syscall
defects remain work to implement. Portable algorithms such as Windows
path conversion are not excluded merely because Kandelo is POSIX.

Run unchanged upstream assertions and native differential controls, with
focused regressions for ordering, byte boundaries, cancellation and
lifetime where relevant. Callback-only success against a stub does not
validate the resource contract. Review the other upstream categories and
record their applicability rather than equating parallel/sequential with
the complete public core surface. Never refresh unselected baseline rows
from a filtered follow-up.

Continue through useful source work and targeted normal builds while the
full product rebuild remains deferred. Required deferred validation stays
visible and cannot be converted into completed compatibility. Changes
remain in focused draft PRs; completion of an individual fix is not
completion of this goal.

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
# Prepare and verify the pinned source and native reference first.
scripts/run-nodejs-library-tests.sh --prepare-only --out .context/nodejs-source-inputs
# This example is for the supported darwin-arm64 native reference.
export NODE_REFERENCE="$PWD/.context/nodejs-lts-cache-v2/node-v26.13.0-darwin-arm64/bin/node"
scripts/dev-shell.sh bash -c \
  'cd host && exec "$1" node_modules/vitest/vitest.mjs run --config vitest.node-core.config.ts' \
  _ "$NODE_REFERENCE"
```

The config contains only source-classified tests and omits the prepared
product/C-fixture global setup. Use the prepared reference directory
matching your host architecture.
The runner's host/build Node version and the pinned reference are separate
identities. Running Vitest under the build toolchain skips exact-native
controls and does not support a no-skips reference claim.

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

## Real TCP listener regression

The net module now owns real nonblocking bind/listen/accept operations.
Closing a server stops accepts immediately and waits for accepted
socket descriptors to close before reporting server closure. Socket end
performs a real write-half shutdown after writes complete; native watch
references drive ref/unref lifetime. Listener and accepted descriptors
are close-on-exec.

The focused normal-image regression runs the same IPv4/IPv6 lifetime,
bind-conflict, port-release and listener-unref programs used by the
pinned native controls, then tests both families against an independent
C client. The C program uses actual connect/write/shutdown/read calls.
It is compiled through the checkout SDK and stamped normally. No guest
compatibility APIs or upstream sources are substituted.

```sh
for engine in node chromium firefox webkit; do
  scripts/dev-shell.sh env WASM_POSIX_RESOLUTION_POLICY=source-only-v1 \
    WASM_POSIX_SOURCE_ONLY_BINARY_ROOT="$PWD/local-binaries/source-only-v1" \
    host/node_modules/.bin/tsx scripts/run-nodejs-tcp-server-tests.ts \
    "$engine" ".context/node-tcp-new-$engine"
done
```

Each host passed all five cases, with no timeout or harness error, at
implementation bdaf87bbe5125a96687d25dba2329bd4884d308f.
Reports `.context/node26-tcp-server-HOST/` and
`.context/node26-tcp-server-audit.json` retain identical source, image,
peer and runtime identities. The normal targeted build passed; 97
source/reference checks and the ABI snapshot check passed (ABI 55).
The complete product rebuild remains deferred.

This is the first real listener implementation, not complete net
compatibility. Callable constructors, listen overloads and descriptors,
IPC paths/fd listeners, maxConnections/drop, BlockList, socket options,
stream encoding/backpressure, timer unref and disposal remain gaps.
The unchanged networking/DNS inventory must remain a separate report;
these focused checks never refresh unselected baseline rows.

## Current evidence and limits

- All 83 source/harness tests pass under the exact native Node 26.13.0
  reference, including execution of the assembled bootstrap and
  adversarial fixture-cache integrity checks.

- Native harness controls verify real flags/environments, assertion and
  exit-listener failures, skips, deadlines, process termination and
  spawn errors. Ten unchanged upstream cases pass in bounded
  3-to-10-case resumption; a changed deadline is rejected without
  changing results.

- The preceding module-entry product passed thirteen Node-host core cases
  and all thirteen shared commands on Chromium, Firefox and WebKit. This
  covers the URL/Buffer/exit review findings, assertion brands and
  mismatches, positioned I/O, streaming stdin decoding, Response/Blob
  bodies and the existing process/stream checks.

- The resident-filesystem and IPv6 endpoint corrections pass 3,241 Rust
  workspace tests and doctests and the ABI snapshot check. Positioned I/O
  passed three unchanged Sortix C cases on Node and Chromium; the later
  networking fix passed seven unchanged networking C cases on both hosts
  under SourceOnly.
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

## Networking-only follow-up (2026-10-31)

The next collection selected every `net` and `dns` filename family in the
pinned parallel/sequential inventory: 174 TCP and 32 DNS files. It ran at
`f0eaf9086765e269dd7257c327e7e11e2a03c5af`, after the connection-policy,
public-global and native module-entry fixes. This is a module selection,
not a random sample or an alphabetical prefix. Other networking modules
and the other upstream categories remain outside this collection.

| Host | Pass | Fail | Upstream skip | Unsupported | Timeout | Harness error | Pending |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Node | 17 | 159 | 4 | 25 | 1 | 0 | 0 |
| Chromium | 17 | 160 | 4 | 25 | 0 | 0 | 0 |
| Firefox | 17 | 159 | 4 | 25 | 1 | 0 | 0 |
| WebKit | 17 | 158 | 4 | 25 | 1 | 1 | 0 |

Every host finalized all 206 cases. WebKit lost its execution context at
`sequential/test-net-response-size.js`; the harness-error row remains.
Resumption on matching inputs completed its three pending cases. The two
cross-host outcome differences involve that case and
`sequential/test-net-GH-5504.js`, which timed out on Node, Firefox and
WebKit and failed on Chromium. Its logs show missing Readable.setEncoding
before shutdown waits on spawned work. These anomalies are not passing
results or evidence of an outside-runtime defect. A separate fresh-page
WebKit replay of `test-net-response-size.js` used matching frozen image,
kernel and asset hashes and produced a guest connection-refusal failure;
the original context-loss row remains unchanged. Its replay is recorded at
`.context/node-webkit-response-frozen-rerun.json`.

All four reports retain the same 17 passing filenames. A callback-only
file such as `test-net-reuseport.js` can pass against the pre-existing
listening-server stub; it does not prove actual bind/listen or port
sharing. Real TCP client behavior is separately checked by the C-peer
fixture through SDK/POSIX sockets on all four hosts. The four upstream
skips result from crypto and IPv6 capability checks. IPv6 loopback works
in the real peer test; incomplete runtime capability metadata remains a
fixable gap. Unsupported launcher flags are separate from passing files.

The original eight affected files now have six passes and two failures
on each host. Public shell-global leakage and buffer Base64 export
identity no longer block their exit checks. Their two server-dependent
files expose missing `util.getCallSites()` and actual server behavior.

The Node report contains 40 failed files whose logs mention the missing
call-site API, sometimes alongside real connection errors. Further
clusters include connection refusal at the stub's port zero, missing
`dgram`/Resolver/lookupService APIs, socket option validation, Unix sockets
and stream/worker semantics. The next fixes should implement these in
their owning runtime modules and native bindings; diagnostic groups are
not independent root-cause counts.

Reports live at `.context/node26-net-dns-entrypoints-HOST/`; the combined
audit is `.context/node26-net-dns-entrypoints-audit.json`. Earlier failed
eight-case runs remain at `.context/node26-network-targeted-HOST/` and
`.context/node26-global-network-HOST/`. They are not merged with this
collection or the original full baseline. No 500-case post-networking
batch ran.

To reproduce the complete TCP/DNS filename selection with a fresh report,
prepare/list the pin and pass the unchanged filenames to the normal
runner. Substitute each guest host for `node`:

```sh
scripts/run-nodejs-library-tests.sh --list \
  --out .context/node26-network-inventory > .context/node26-network-list.log
python3 - node <<'PY'
import json, re, subprocess, sys
host = sys.argv[1]
inventory = json.load(open('.context/node26-network-inventory/inventory.json'))
names = [t['name'] for t in inventory['inventory']
         if re.match(r'^test-(net|dns)(-|\.m?js$)', t['name'].split('/')[-1])]
raise SystemExit(subprocess.call([
    'scripts/run-nodejs-library-tests.sh', '--host', host, '--timeout', '30',
    '--out', '.context/node26-network-new-' + host, *names]))
PY
```

Select SourceOnly and its prepared output root as shown in the real TCP
regression section when testing local SourceOnly products. Neither
listing nor running this selection compiles packages.

## Failure-selected call-site follow-up (2026-10-31)

At `1df09ffc03d615095a459467d88430bfe6e4b7cc`, the runtime implements
`util.getCallSites()` through actual engine saved frames. Compilation
preserves CommonJS user lines and public ESM source URLs. The next
selection contains every one of the 40 Node-host failures mentioning the
missing API, the original eight networking controls, and the upstream
stack-formatting-hook test. Two controls overlap the failures, producing
47 unique files. This is a failure-derived selection, not sampling.

| Host | Pass | Fail | Upstream skip | Unsupported | Timeout | Harness error | Pending |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Node | 16 | 30 | 1 | 0 | 0 | 0 | 0 |
| Chromium | 16 | 30 | 1 | 0 | 0 | 0 | 0 |
| Firefox | 16 | 30 | 1 | 0 | 0 | 0 | 0 |
| WebKit | 16 | 30 | 1 | 0 | 0 | 0 | 0 |

The audit found no cross-host status/exit-code differences and matching
runtime and source identities. None of these logs retains the missing
call-site diagnostic. Nine networking files changed from failure to pass;
`sequential/test-net-server-address.js` now reaches an upstream capability
skip. The added stack-hook test passes. Server-stub and callback-only
passes still do not establish real listening-server conformance.

Reports remain separate at `.context/node26-call-sites-affected-HOST/`,
with `.context/node26-call-sites-affected-audit.json` recording the exact
selection, identities and status changes. They do not refresh unselected
cases in the 206-file collection or the original 5,147-file baseline.

The exact failure-derived filenames are checked in at
`tests/nodejs/selections/network-call-sites.json`, without expected
outcomes or allowances. Reproduce them through the normal runner:

```sh
python3 - node <<'PY'
import json, subprocess, sys
host = sys.argv[1]
selection = json.load(open('tests/nodejs/selections/network-call-sites.json'))
raise SystemExit(subprocess.call([
    'scripts/run-nodejs-library-tests.sh', '--host', host, '--timeout', '30',
    '--out', '.context/node26-call-sites-new-' + host, *selection['tests']]))
PY
```

All three upstream `test-util-getcallsites` files were also collected in
separate reports. The exact native reference passed all three. Every
guest host recorded one pass, one failure and one upstream skip, with no
unsupported cases, timeouts, harness errors or pending files. The
stack-formatting-hook test passes; source-map remapping fails explicitly;
the general API file skips because it requires Amaro. That skip does not
establish the unexecuted assertions. Permanent native/guest CJS, ESM and
eval fixtures separately check record shape, source coordinates and
validation.

These reports are `.context/node26-call-sites-api-HOST/`, except the
completed Node report is `.context/node26-call-sites-api-node-r2/`.
`.context/node26-call-sites-api-audit.json` binds their identities. The
first Node attempt failed during image writing with host ENOSPC before
preflight or any test case; its `run-error.json` remains separate. The
retry used a fresh output directory. Reproduce the API collection with:

```sh
scripts/run-nodejs-library-tests.sh --host node --timeout 30 \
  --out .context/node26-call-sites-api-new-node \
  parallel/test-util-getcallsites.js \
  parallel/test-util-getcallsites-sourcemap.js \
  parallel/test-util-getcallsites-preparestacktrace.js
```

The earlier call-site product passed 14 Node-host core cases and all
fourteen commands on Chromium and WebKit. Firefox timed out twice in the
combined exit-code fixture at its unchanged 120-second deadline. A later
unchanged, single-project run passed all fourteen commands under lower
concurrent load. The original failures remain recorded; mixed outcomes
do not establish the cause or a reliability claim. Reports remain at
`.context/node-browser-prepared-reports/playwright.IAOJHS/`,
`playwright.jPIKF8/` and `playwright.d9w5j6/`.

### Default fatal shutdown

A native differential reproduction found that the guest drained live work
after an uncaught synchronous exception, and delayed unhandled-rejection
reporting until every timer and I/O watch had drained. A parent with an
open interval could therefore hang indefinitely after a fatal error.
Timer callback exceptions were also discarded by the native shell loop.

The owning Node-mode event loop now exits on a synchronous fatal error,
reports unhandled rejections after the microtask checkpoint, and retains
thrown timer/ESM values. Standalone SpiderMonkey shell behavior is
unchanged. A nonzero assigned process.exitCode still permits ordinary
work to finish, and a rejection handled during the same checkpoint does
not become fatal. Custom uncaughtException/unhandledRejection policy,
beforeExit and complete timer ordering remain implementation gaps.

The normal targeted shell build passed 93 source/reference checks, all
15 Node-host core cases and the ten-program fatal regression on Chromium,
Firefox and WebKit. The regression includes file/eval/ESM errors, timer
and Promise failures, live child I/O, and nonfatal controls. The real
C-socket peer check also passed on all four hosts. These are focused
checks; no complete product rebuild was performed. The unchanged broader
fourteen-command browser core check passed on all three engines with
retries disabled (13.1 minutes total), recorded at
`.context/node26-core-goal-browser-reports/playwright.0lAhBE/`.
The focused fatal-browser report is `playwright.mo1elZ/` in that parent.

The unchanged upstream sequential/test-net-GH-5504.js now fails on all
four hosts at the actual missing Readable.setEncoding method, with no
timeout or harness error. Earlier reports contained three timeouts and
one failure. This is a newly exposed failure, not a compatibility pass.
Reports are `.context/node26-fatal-upstream-HOST/`; the combined source
and runtime identity audit is
`.context/node26-fatal-upstream-audit.json`. The pre-fix differential
reproduction is retained at `.context/node26-fatal-exit-red.json`.

Real TCP bind/listen/accept is now implemented and covered above. The
remaining priorities include DNS/Resolver APIs, accurate capability
metadata and socket/stream controls
including Readable.setEncoding, and the remaining process event policies.
Persistent EventEmitter listener defaults/warnings and assertion
diagnostics/native key comparisons remain confirmed gaps. Call-site
source-map remapping and the other partial APIs in
`packages/registry/node-compat/README.md` also remain incomplete. The
other 37 upstream categories need configuration and fixture review.

## TCP follow-up: complete networking selection

The unchanged 206-case net/dns filename selection is now complete on all
four hosts at implementation bdaf87bbe5125a96687d25dba2329bd4884d308f.
Every host reports 47 pass, 123 fail, 5 upstream skips, 25 unsupported,
6 timeouts and no harness errors or pending cases. The audit found no
per-case status/exit-code differences, and verified identical target,
source, selection, code inputs, image and runtime hashes. Reports remain
separate at `.context/node26-tcp-net-dns-HOST/`; the combined audit is
`.context/node26-tcp-net-dns-audit.json`.

The earlier complete 206-case Node report had 17 passes. Across the staged
fixes, 31 failures became passes; 6 became timeouts, one prior pass now
fails, one timeout now fails and one failure became an upstream skip.
The prior pass was test-net-reuseport.js: the old synthetic Server never
bound a port. It now exposes a real second-bind failure. In the earlier
47-case call-site selection, seven more failures now pass, while the two
server-unref cases now correctly report their throwing timer callbacks;
timer unref remains a no-op. No failing/unsupported/skipped case counts as
passing compatibility, and unselected baseline rows remain unchanged.

The current product also passed all 15 Node-host core cases and the
previous real-C-peer client regression on every host, including dialing,
local binding and cancellation. Full product/POSIX/memory/performance
gates remain deferred. The public API inventory is still unreviewed;
these results do not establish complete networking or Node compatibility.

The exact selection is committed at `selections/net-dns.json`, rather
than an arbitrary-sized sample. It is bound to this source pin. To repeat
one host through the normal runner, first prepare a small job wrapper:

```sh
cat > .context/run-net-dns.py <<'PY'
import json, subprocess, sys
selection = json.load(open('tests/nodejs/selections/net-dns.json'))
pin = json.load(open('packages/registry/node-compat/target.json'))
if (selection['version'], selection['sourceCommit']) != (pin['version'], pin['source']['commit']):
    raise SystemExit('Update the selection for this source pin')
raise SystemExit(subprocess.run([
    'host/node_modules/.bin/tsx', 'scripts/run-nodejs-library-tests.ts',
    '--host', sys.argv[1], '--out', sys.argv[2], '--timeout', '30',
    *selection['tests'],
]).returncode)
PY
export WASM_POSIX_RESOLUTION_POLICY=source-only-v1
export WASM_POSIX_SOURCE_ONLY_BINARY_ROOT="$PWD/local-binaries/source-only-v1"
scripts/agent-job start -- scripts/dev-shell.sh python3 \
  .context/run-net-dns.py node .context/net-dns-new-node
```

Repeat with fresh directories for chromium, firefox and webkit. Collect
the terminal job result; exit 1 is expected while cases remain failures.
The initial run is retained, including failures, before any focused replay.

The next failures to close include real interface/capability metadata,
reuse-port binding, large writes/backpressure, maxConnections/drop,
callable constructors/overloads, stream encoding and timer reference
semantics. An independent C getifaddrs probe confirms that the current
libc interface list has IPv4 but omits the working IPv6 loopback address;
Node also ignores that existing list. Fix the owning state/API instead
of overriding upstream capability checks. A mixed fatal callback plus
throwing exit listener also exposes status 3 where native Node returns 1;
the following exit-listener fix closes that reproduced mapping gap.

## Exit-listener status and diagnostics

The Node-mode finalizer now preserves the validated exit status after an
exit listener throws, including an explicitly assigned zero. Explicit
`process.exit()` keeps the status selected by the listener, and already
fatal callbacks retain the original diagnostic rather than reporting a
secondary listener error. The shell saves and restores the original
exception while querying the actual status; it never re-emits exit.
Standalone SpiderMonkey shell behavior is unchanged.

The targeted product at production commit
`61ff0a65a9d2b7463375b93eb1ed89aa1a913444` passed:

- 114 source/reference checks under exact Node 26.13.0, with no skips.
- All 16 Node-host core cases.
- Six browser tests, serially with no retries or skips: 17 new listener
  programs and ten preceding fatal-exit programs on each browser engine.
- Five real TCP cases on each of the four hosts, including C peers.
- Three unchanged upstream exit files on each host:
  `test-process-exit.js`, `test-process-exit-recursive.js` and
  `test-process-exit-handler.js`. All passed, with no unsupported, skip,
  timeout or harness-error rows.

The permanent fixtures include natural, explicit and fatal exits,
cleared/zero/changed statuses, thrown falsy values and stalled top-level
await. Their commands are in `host/test/fixtures/node-exit-listeners.ts`;
the browser spec is `node-exit-listeners.spec.ts`. Run the upstream
selection with the normal runner and fresh per-host report directories.

Frozen artifact hashes are in
`.context/node26-exit-listener-runtime-inputs/manifest.json` (Node archive
`a4d24764af4fef68dbe10f138b8bc5d85c8f3d305f1e0766eb0fb58b4703f338`).
The upstream and TCP audits are
`.context/node26-exit-listener-upstream-audit.json` and
`.context/node26-exit-listener-tcp-audit.json`. Browser report
`.context/node26-exit-listener-browser-reports/playwright.2ZbHyQ/` and
Node report `.context/node-prepared-reports/vitest.V4hW55/` retain results.

An initial targeted build failed the engine's include-order check before
being corrected. An initial guest fixture used an unregistered lazy grep
asset and failed; equivalent Bash literal checks removed that incidental
dependency before the passing run. Both failed logs remain retained.
The ABI snapshot check passed at ABI 55. No full product rebuild ran.
Custom exception/rejection hooks, beforeExit, complete timer ordering and
stalled-module warning text remain gaps; this is not complete lifecycle
or core-module conformance.

## Draft delivery stack

The changes remain in focused draft PRs. None has been merged or deployed.
The complete product rebuild, broad POSIX and application-switching
memory gate, and performance comparisons remain deferred. The separate
Claude/npm/Bun remainder is preserved outside this stack.

| Scope | Draft PR |
| --- | --- |
| Four confirmed review findings | [#1595](https://github.com/Automattic/kandelo/pull/1595) |
| LTS target and restored upstream harness | [#1604](https://github.com/Automattic/kandelo/pull/1604) |
| Streaming text decoding | [#1605](https://github.com/Automattic/kandelo/pull/1605) |
| Assertion semantics | [#1606](https://github.com/Automattic/kandelo/pull/1606) |
| Eval shutdown and natural exit | [#1607](https://github.com/Automattic/kandelo/pull/1607) |
| Positioned filesystem I/O | [#1608](https://github.com/Automattic/kandelo/pull/1608) |
| Response/Blob body state | [#1609](https://github.com/Automattic/kandelo/pull/1609) |
| Wide filesystem offset validation | [#1610](https://github.com/Automattic/kandelo/pull/1610) |
| Complete upstream source fixtures and baseline | [#1611](https://github.com/Automattic/kandelo/pull/1611) |
| Real TCP connection-attempt policy | [#1612](https://github.com/Automattic/kandelo/pull/1612) |
| Public globals and private embedding utilities | [#1613](https://github.com/Automattic/kandelo/pull/1613) |
| Native module graphs and file entrypoints | [#1614](https://github.com/Automattic/kandelo/pull/1614) |
| Engine call-site records and selected reruns | [#1615](https://github.com/Automattic/kandelo/pull/1615) |
| Default fatal shutdown with live work | [#1616](https://github.com/Automattic/kandelo/pull/1616) |
| Real TCP listeners and half-close | [#1617](https://github.com/Automattic/kandelo/pull/1617) |
| Exit-listener status and fatal diagnostics | [#1619](https://github.com/Automattic/kandelo/pull/1619) |

Earlier 3,925-case results in `docs/software-unit-tests.md` used an older
harness and source version. They are historical and do not establish
current LTS compatibility.
