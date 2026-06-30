# Homebrew JS, DB, And Service Runtime Package Wave

Bead: `kd-nlyy`

Package set: `spidermonkey`, `spidermonkey-node`, `node`, `redis`, `nginx`,
`mariadb`

## Problem Statement

Kandelo needs the JavaScript runtime, database, and service-runtime packages
ported to the Homebrew bottle model without weakening the platform contract.
This wave is riskier than small CLI and library waves because the packages
exercise large C/C++ builds, multi-output formulae, threads, fork
instrumentation, TCP services, database bootstrap state, Node-compatible
JavaScript behavior, and browser-runtime claims.

The implementation must produce either working Homebrew formulae, bottles,
sidecars, provenance, Node/browser smoke evidence, and upstream-test status for
each package, or visible failed/deferred Homebrew status with concrete reasons.
Failures should identify whether the problem is package recipe state, tap
automation, SDK/sysroot inputs, POSIX/kernel behavior, host runtime behavior,
browser limits, or upstream test infrastructure.

## Non-Goals

- Do not implement the package ports in this design bead.
- Do not publish live tap state from the main `Automattic/kandelo` repository.
  Live formulae, bottle blocks, `Kandelo/` sidecars, provenance, and release
  assets belong in `Automattic/kandelo-homebrew`.
- Do not document guest `brew install` as user-facing support until guest
  Homebrew install is separately validated.
- Do not mark a package browser-compatible from a successful bottle build or a
  Node smoke alone.
- Do not make package-local patches hide fixable Kandelo POSIX, libc, VFS,
  kernel, fork, socket, or host-runtime defects.
- Do not treat helper/source entries such as `pcre2-source`, `node-compat`, or
  `npm` as standalone formulae in this wave; they are owner-local resources or
  sidecar/tooling data per `kd-u4sz`.

## Users And Operator Workflows

Maintainers need reviewable formulae and sidecar metadata that explain which
runtime claims are supported, which were skipped or failed, and why. The
metadata must remain useful after workflow logs expire.

Package porters need a safe sequence that starts with recipe normalization and
small runtime checks before spending CI capacity on long SpiderMonkey and
MariaDB builds.

Tap publishers need trusted workflow inputs that build through Homebrew,
generate bottle blocks and Kandelo sidecars from the same bottle bytes, and
publish failure status without deleting last-green metadata.

Node runtime operators need precomposed Homebrew VFS images that can run the
published binaries through `NodeKernelHost`, including service startup and
client request paths.

Browser operators need conservative compatibility claims. Browser support means
a wasm32 bottle was poured into a precomposed VFS image, booted in the browser
UI, and exercised with a package-appropriate smoke. Browser failures or skips
must stay visible instead of hiding the package from all status reporting.

## Current Package Inventory

`spidermonkey` builds Firefox ESR SpiderMonkey as `js.wasm`, depends on
`libcxx`, `openssl`, and `zlib`, disables fork instrumentation, and already has
Node and browser stress tests. It should be the first runtime in this wave
because `spidermonkey-node` and `node` depend on its build output.

`spidermonkey-node` and `node` both use
`packages/registry/spidermonkey-node/build-spidermonkey-node.sh` and produce
`node.wasm`. Their current `package.toml` files use Kandelo-local source URLs
with zero sha256 placeholders, so implementation must make their formula
provenance explicit. For the first Homebrew pass, keep bottle-producing formulae
self-contained unless the sidecar and VFS builder can represent a safe
formula-alias/dependency-owned binary model.

`redis` declares version `7.2.5`, but `build-redis.sh` currently builds
`7.2.7`. That mismatch is a blocking recipe-normalization item. The script also
needs the same SDK activation and `WASM_POSIX_DEP_*` source/out-dir contract as
the other Homebrew formulae before bottle publication. Redis installs
`redis-server` and `redis-cli`, so sidecars and link manifests must expose both
links.

`nginx` uses a wrapper around `build-nginx-local.sh`, applies fork
instrumentation, and has existing Node-side HTTP tests. Its Homebrew smoke
should cover `nginx -t` plus a real static HTTP request through Kandelo, not
just `--version`.

`mariadb` declares wasm32 and wasm64 support, builds host helper executables,
cross-builds `mariadbd` and `mysqltest`, and carries mysql-test data. It is the
heaviest item in this wave. Publish wasm32 first, then wasm64 if the wasm64
sysroot and LLVM `-O1` path remain green; otherwise publish a wasm64 failure
status with the exact build or runtime reason. Browser compatibility should
start as skipped or failed unless a dedicated browser database smoke proves the
claim.

Current checked-in package manifests for these packages still declare
`kernel_abi = 7` while the repository ABI is `16`. Implementation must normalize
ABI metadata before building current bottles and must not confuse this with an
`ABI_VERSION` bump.

## Dependency And Baseline Requirements

Implementation should start from `origin/main` after the dependency-root wave
from `kd-zq4n` has landed, or explicitly merge
`origin/gascity/kd-1mr/kd-zq4n-dependency-roots` into the bead branch. That
wave adds formulae for `openssl`, `libcxx`, `libxml2`, `libpng`, `libcurl`,
`ncurses`, extends sidecar generation to derive program links from
`package.toml` outputs, and adds reusable Homebrew package Node smoke tooling.

The `kd-u4sz` classification is also a design dependency:

- `pcre2-source` is folded into the owning MariaDB formula as a source/helper
  input.
- `node-compat` and `npm` are sidecar/tooling-owned data for the SpiderMonkey
  and Node-compatible runtime path.
- Helper entries should not become standalone Homebrew packages unless later
  evidence shows a real shared runtime need.

## Architecture And Data Flow

The main repository owns package build scripts, validation tooling, reusable
workflows, sidecar schemas, VFS planner/builder code, smoke tests, and reference
docs. The live tap repository owns formulae, bottle blocks, generated
`Kandelo/` sidecars, provenance reports, GHCR bottle URLs, and
`bottles-abi-v<N>` release assets.

Formulae should call the normal Kandelo build scripts through the trusted
Homebrew workflow. Each formula must set:

- `HOMEBREW_KANDELO_ROOT`
- `HOMEBREW_KANDELO_ARCH`
- `HOMEBREW_KANDELO_NODE`
- `HOMEBREW_KANDELO_LLVM_BIN`
- `WASM_POSIX_DEP_VERSION`
- `WASM_POSIX_DEP_SOURCE_URL`
- `WASM_POSIX_DEP_SOURCE_SHA256`
- `WASM_POSIX_DEP_OUT_DIR`
- `WASM_POSIX_DEP_WORK_DIR`
- `WASM_POSIX_DEP_TARGET_ARCH`

Formulae install only the produced Wasm artifacts into the keg. Kandelo VFS
planning data, browser compatibility, cache keys, and validation evidence stay
in generated sidecars, not in Formula Ruby.

Trusted CI builds each `(formula, arch)` with
`.github/workflows/reusable-homebrew-bottle-publish.yml`, applies the Kandelo
Homebrew bottle-tag patch in a temporary Homebrew worktree, runs `brew test`
through Kandelo, uploads bottle bytes, generates sidecars, validates metadata,
and publishes success or failure status.

Sidecar generation must use the package output list, not a hard-coded
`bin/<formula>` link. This is required for `redis` (`redis-server`,
`redis-cli`) and `mariadb` (`mariadbd`, `mysqltest`), and it avoids future
breakage for shared SpiderMonkey/Node artifacts.

The VFS planner consumes `Kandelo/metadata.json`, resolves the requested package
closure, rejects ABI/cache-key/path/link drift, and selects only bottles whose
runtime metadata supports the requested host. The Node builder then verifies
bottle bytes and pours/link-manifests into a precomposed Homebrew-prefix VFS.

Node smokes should boot the poured VFS through `NodeKernelHost`. Browser smokes
should boot a published wasm32 precomposed VFS through the browser UI and run a
package-appropriate command or service probe before setting
`browser_compatible = true`.

## Package-Specific Design

### SpiderMonkey

Add a `spidermonkey` formula that builds `js.wasm` through
`build-spidermonkey.sh` and installs it as `bin/js`. Formula `test do` should
run `js -e 'print(1+1)'` through Kandelo. Node smoke should run a broader shell
sample covering file I/O, shared memory worker startup when available, exception
reporting, and non-zero syntax/runtime failure behavior.

Browser smoke should adapt the existing SpiderMonkey browser stress path to the
Homebrew VFS image. It should prove repeated `js` launches do not leak
processes and stay inside the memory ceiling before sidecars record browser
support.

### SpiderMonkey Node Runtime And `node`

Keep the SpiderMonkey Node-compatible runtime explicit: `spidermonkey-node`
owns the `node.wasm` build path, while `node` preserves the existing package
name and user-facing command. If the implementation chooses separate formulae,
both must have clear provenance and must not pretend to be upstream Node.js. If
it chooses an alias/dependency model, the sidecar and VFS builder must first
prove that dependency-owned binaries and links are represented safely.

Node smoke should cover:

- `node --version`
- `node -e` with `process`, `console`, `Buffer`, `path`, `util`, and `assert`
- CommonJS package resolution and symlinked package bins
- ES module shebang behavior and visible exception messages
- selected crypto/zlib parity tests
- npm install only if `npm` helper data is available and the outcome is
  recorded as pass/fail/skip with reason

Browser smoke can start with `node --version` and a small `node -e` sample, but
must not claim npm/browser support unless the browser fetch, filesystem, and
runtime behavior are actually exercised.

### Redis

Normalize the recipe before writing the formula:

- make `package.toml` and `build-redis.sh` agree on the Redis version and
  source sha;
- source `sdk/activate.sh`;
- honor `WASM_POSIX_DEP_SOURCE_URL`, `WASM_POSIX_DEP_SOURCE_SHA256`,
  `WASM_POSIX_DEP_VERSION`, `WASM_POSIX_DEP_OUT_DIR`, and
  `WASM_POSIX_DEP_WORK_DIR`;
- install both `redis-server` and `redis-cli` into the Homebrew keg.

Formula `test do` should at minimum run `redis-server --version` and
`redis-cli --version` through Kandelo. Node smoke should start `redis-server`
inside the Homebrew VFS, wait for readiness on a loopback port, run
`redis-cli PING`, verify `PONG`, and shut the server down cleanly.

Browser smoke should be a separate pass. If browser loopback/service wiring is
not ready, publish `browser_compatible = false` with a skipped or failed
browser-smoke outcome explaining the exact missing boundary.

### nginx

Add an `nginx` formula that calls the existing build wrapper and installs
`bin/nginx`. The formula must preserve the current fork-instrument-last rule.
Formula `test do` should run `nginx -t` through Kandelo with a minimal config.

Node smoke should pour the Homebrew VFS, launch nginx with `master_process on`,
send an HTTP request through the TCP bridge, verify the static response, and
stop the server. This should reuse the existing `packages/registry/nginx/test`
coverage rather than creating a formula-only runner that bypasses the normal
kernel path.

Browser smoke should use the service-worker HTTP injection path only after a
precomposed Homebrew VFS image boots in the browser. A successful browser smoke
should verify the response body and server header; otherwise publish explicit
browser skip/failure status.

### MariaDB

Add a `mariadb` formula that builds and installs `bin/mariadbd` and
`bin/mysqltest`. Keep `pcre2-source` as a MariaDB-owned source/helper input,
not a standalone runtime dependency. The formula must preserve per-arch sysroot
and build directories so wasm32 and wasm64 artifacts cannot cross-link.

Formula `test do` should verify the Wasm headers and run lightweight
Kandelo-executed checks that do not require a long server bootstrap. Node smoke
should do the real service proof:

1. Build a Homebrew VFS containing the poured MariaDB bottle.
2. Bootstrap system tables in a writable data directory.
3. Start `mariadbd`.
4. Run `mysqltest` or an equivalent Kandelo client query for `SELECT 1`.
5. Record server stderr, startup time, query result, and shutdown status.

The upstream mysql-test suite is too large for a single unqualified gate. The
implementation should publish a complete upstream-test status artifact naming
which mysql-test commands or subsets ran, which were skipped, and why. If no
upstream subset runs, that must be recorded as skipped with a reason and a
follow-up or blocker bead.

Browser smoke should initially be conservative. MariaDB uses substantial memory
and thread/service behavior. A browser-compatible claim requires a dedicated
Chromium smoke that boots the Homebrew VFS, starts or bootstraps MariaDB within
browser limits, runs a query, and records artifacts. Otherwise publish
browser-compatible false with the concrete browser limit or missing test path.

## Alternatives Considered

Build all six packages in one workflow matrix without pre-normalization.
Rejected because stale ABI metadata, the Redis version mismatch, and
multi-output sidecars would turn predictable recipe problems into long CI
failures.

Treat `node` as only a tap alias for `spidermonkey-node`. Deferred. It is the
least duplicate model, but the current sidecar and VFS metadata must first
prove alias/dependency-owned executable links are safe and understandable.

Make service packages Node-only and skip browser work entirely. Rejected as a
default because Kandelo treats browser and Node hosts as peer product surfaces.
Browser support may be skipped or failed with reasons, but the status must be
explicit.

Use existing package archive `index.toml` data as Homebrew metadata. Rejected.
Homebrew bottle selection belongs to formula bottle blocks and GHCR bottle URLs;
Kandelo package archives and Homebrew sidecars are separate publication
contracts.

Create standalone formulae for `pcre2-source`, `node-compat`, or `npm`.
Rejected for this wave based on `kd-u4sz`; they are helper/source inputs owned
by MariaDB or SpiderMonkey/Node runtime formulae.

## Risks And Mitigations

| Risk | Mitigation |
|---|---|
| Old `kernel_abi` values produce stale or rejected package metadata. | Normalize package manifests to current ABI before bottle builds; do not bump `ABI_VERSION`; report ABI evidence in sidecars. |
| Redis version drift builds bytes that do not match the manifest. | Fix the manifest/script/source-sha mismatch before formula work and make the formula pass manifest values through `WASM_POSIX_DEP_*`. |
| Multi-output packages publish incomplete VFS links. | Require sidecar generation from `package.toml` outputs and add validation that poured VFS images contain every declared executable. |
| Build-time dependencies become accidental runtime VFS dependencies. | Keep helper/source inputs owner-local; use sidecar dependencies only for packages that must be present in the poured runtime image. |
| Browser compatibility is overclaimed. | Require wasm32 precomposed VFS plus Playwright/browser smoke evidence before `browser_compatible = true`. |
| Service smoke tests become demo-specific shortcuts. | Reuse package-owned Node/browser runtime paths and exercise Kandelo kernel networking, fork/thread behavior, and VFS state. |
| Long builds hide root causes in truncated logs. | Preserve full build logs, publish outcome lists, and record failure layer classification per formula and arch. |
| MariaDB wasm64 consumes capacity but fails late. | Build wasm32 first, then wasm64 with explicit `-O1`/sysroot status; publish wasm64 failure metadata if necessary. |
| Duplicate Node-compatible artifacts create maintenance burden. | Start with explicit provenance and self-contained formulae, then create a follow-up for alias/dedup sidecar support if duplicate bottles become costly. |

## Implementation Sequence

1. Rebase or merge onto the dependency-root Homebrew wave from `kd-zq4n` or a
   main branch that contains it.
2. Run recipe audit scripts for this wave: manifest ABI, version/source sha,
   declared outputs, `build.toml` revision policy, SDK activation, and
   `WASM_POSIX_DEP_*` compliance.
3. Normalize package recipes without changing runtime behavior: current ABI
   metadata, Redis version/source alignment, and any missing out-dir/work-dir
   handling.
4. Add or update formulae in the tap fixture/template for `spidermonkey`,
   `spidermonkey-node`, `node`, `redis`, `nginx`, and `mariadb`.
5. Extend sidecar generation and validation only where the dependency-root wave
   is insufficient for this package set, especially service smoke outcome
   fields and package-specific runtime commands.
6. Build and dry-run publish `spidermonkey` first, then
   `spidermonkey-node`/`node`, then `redis`, then `nginx`, then `mariadb`.
7. For each successful bottle, generate and validate sidecars, build a
   Homebrew VFS image, and run the package-specific Node smoke.
8. For each package and arch, run or explicitly record browser smoke status.
   Only successful wasm32 browser smokes may set browser-compatible metadata.
9. Record upstream-test support/status artifacts for every package. Use
   complete pass/fail/skipped outcome lists, with skipped reasons.
10. Run the relevant focused checks and then the project full gate required by
    the implementation bead before closing or publishing completion claims.

## Test And Documentation Plan

Focused package checks:

- Ruby syntax and Homebrew audit/style checks for each formula.
- `bash -n` for changed build and Homebrew scripts.
- Sidecar generation and `cargo xtask homebrew-validate` over accumulated tap
  state.
- VFS planner/builder tests for multi-output links and dependency closure.
- Package-specific Node smokes for every successful formula/arch.
- Browser smokes for wasm32 packages where browser support is claimed.

Required full-gate commands before implementation closure:

- `cargo test -p kandelo --target aarch64-apple-darwin --lib`
- `cd host && npx vitest run`
- `scripts/run-libc-tests.sh`
- `scripts/run-posix-tests.sh`
- `bash scripts/check-abi-version.sh`

Outcome artifacts:

- bottle build/test passed, failed, and skipped lists;
- sidecar/provenance validation passed, failed, and skipped lists;
- Node smoke passed, failed, and skipped lists;
- browser smoke passed, failed, and skipped lists;
- upstream test passed, failed, and skipped lists with reasons;
- complete failure list before and after any fixes.

Documentation updates should target `docs/homebrew-publishing.md`,
`docs/package-management.md`, `docs/porting-guide.md`,
`docs/browser-support.md`, and `homebrew/kandelo-homebrew/README.md` if this
wave changes formula authoring, package status, runtime claim rules, browser
gallery behavior, or operational runbooks. Do not update user-facing install
instructions until guest Homebrew install is validated.

## Open Questions

1. Should `node` remain a separate bottle-producing formula for v1, or should a
   follow-up add explicit alias/dependency-owned executable sidecar support?
2. Should sidecar dependencies distinguish build-time formula inputs from
   runtime VFS closure dependencies before MariaDB and SpiderMonkey publish?
3. Which Redis and MariaDB browser smokes are acceptable first claims under
   browser memory, networking, and service-worker constraints?
4. Should MariaDB wasm64 be attempted in the same implementation PR as wasm32,
   or published as an explicit failed/deferred arch status after wasm32 proves
   the core path?
5. What upstream-test subset is considered meaningful for MariaDB without
   turning this package wave into a full mysql-test convoy?
6. Should duplicate SpiderMonkey/Node bottle bytes be deduplicated at GHCR or
   left as separate Homebrew bottle artifacts for clarity?
