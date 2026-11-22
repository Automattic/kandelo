# Maintaining the upstream Node runtime

This describes the maintained upstream runtime, not Kandelo's preserved legacy
JavaScript compatibility frontend. Initial shipping qualification has passed;
the complete core-module port and B6 catalog/roadmap review remain unfinished.
A successful build or an inventory entry does not establish module conformance. See [runtime status](nodejs-upstream-runtime.md#current-state).

The accountable owners below are repository components. The execution/release
record must also identify the person responsible for each proposed upgrade.

| Accountable component | Inputs and responsibility | Regression boundary |
| --- | --- | --- |
| `spidermonkey-core` | Authenticated Mozilla archive, section-selected `engine-patches.json`, then the complete sorted producer patches. Own engine execution, parsing, tracing, allocation and interception. | Native engine/bridge lifetime tests, VM controls and installed CLI/file gates. Source application alone cannot qualify semantics. |
| `spidermonkey-node-bridge` | Original Node/V8 source and the explicitly staged native bridge files in `build-bridge.py`. Preserve V8-shaped source interfaces with actual SpiderMonkey values, realms, roots and callbacks. | `node-native-lifetime-tests`, matching native references, VM/REPL and final installed consumer gates. |
| `spidermonkey-node` | Original Node configure/GYP, registration lists, Environment, startup, loaders and native policy. Its patches select the actual target/engine and the individually approved source boundaries. | Separate CLI, path/filesystem/timers, CJS and ESM gates; distinct default and feature builds. |
| `node-amaro` | Pinned native transformer, private dynamic-library ABI and complete upstream lazy JavaScript wrapper. | Default CJS/ESM TypeScript and library/callback/thread retirement controls. |
| Native dependency recipes | Isolated pinned libraries, target configuration, symbol visibility and original consumer settings. | Their actual Node consumers and guest OS effects. A standalone library test does not qualify the Node binding. Dependency consolidation remains a later review. |
| `node-browser-bundle` | Normal installed Node/npm archive, executable modes, links, documentation and deferred package ownership. | Deterministic offline and controlled-registry npm tests; separately selected public-network tests; actual normal-app tests on all browser engines. |
| Shared Kandelo libc/kernel/host components | Real process, descriptor, resolver, socket, memory and retirement state. No Node-specific host service. | Applicable shared runtime/POSIX suites, Node/browser parity and browser-memory checks. |

## Record the exact maintained surface

The [source contract catalog](nodejs-upstream-bridge-contracts.json) assigns every
actually staged bridge file and selected patch a maintenance role, reason for
the adaptation, protecting consumer contracts and explicit test limits. The
inventory retains each input's actual component owner and digest. It reads the
staging list from `build-bridge.py` and selected patches from the engine projection
and real patch chains, rejecting missing, duplicate, unstaged or unselected
documentation entries. Excluded historical shell patches remain identified
separately. Current counts are 87 selected patches, 43 excluded historical
patches and 68 staged bridge files; these are source counts, not API or test
coverage denominators.

This catalog does not select build inputs or certify every method in a file.
Complete-build checks protect source compatibility; runtime protection is
limited to the cases in each exact release record. A shared prerequisite such
as GC or callback retirement does not establish every consumer's behavior.

Keep the distinction visible during upgrades. Wire transfer, complete heap and
profiling services, general guest Wasm and unselected API variants need their
own required acceptance. Shared GC/callback tests alone do not qualify those
consumers. Older package README timing notes describe intermediate source
batches; the current runtime status and identified release evidence determine
which candidate was actually built and tested.

### Temporary native versions of Wasm helpers

Native builds of upstream Wasm helpers are temporary execution adaptations.
Here, native means a guest C/Rust library loaded through Kandelo's normal
`dlopen`. That library still targets Kandelo's Wasm machine format; the
adaptation replaces the helper's use of guest Node's `WebAssembly` APIs.
The intended destination is each original upstream Wasm path once WebAssembly
execution inside guest Node is implemented and qualified. General guest Wasm
remains a later iteration; a native helper does not establish Wasm support.

| Helper | Upstream and native route | Status and migration back |
| --- | --- | --- |
| Amaro TypeScript transformer | Pinned Amaro 1.1.11. Retain the complete upstream lazy JavaScript wrapper; replace its Wasm glue with the private native Rust backend in `node-amaro`. Node's availability check recognizes the actual native capability. | The current candidate passes initial default-TS CLI/file gates on all four hosts and normal-app TS checks in all three browsers. Initial canonical shipping qualification has passed. Qualify original Amaro Wasm imports, memory, exceptions and cleanup, then restore its upstream backend/availability check and retire the native library/ABI after default CJS/ESM TypeScript and lifetime tests pass on all four hosts. |
| Undici HTTP/1 parser | Pinned Undici llhttp 9.3.1 C sources, isolated from Node HTTP's llhttp 9.4.3. The approved candidate uses a lazy native guest library, real buffer/callback/cleanup glue and one explicit parser-factory JavaScript change. Preserve parser algorithms and remaining Fetch code. | The current candidate passes eight controlled HTTP/HTTPS cases, five callback/error/GC/cleanup cases and Worker retirement separately on all four hosts, plus normal-app Fetch and the reported interactive HTTPS command in all three browsers. Initial canonical shipping qualification has passed. This differs from Node's existing Fetch execution path. Qualify original Undici Wasm callbacks, memory growth/views, interruption and cleanup, then restore its original factory and retire the private binding/library after the same HTTP/HTTPS/body/redirect/stream/cancel/error/lifetime cases pass separately on all four hosts. |

For each additional native version of a bundled Wasm helper, extend this record
with exact upstream version/archive identity, maintained source boundary,
native dependency and lifetime owner, protecting tests, implementation status
and concrete removal steps. Bind exact source/artifact identities in the release
inventory and preserve original Wasm sources. Review both paths during upgrades.
Retiring a helper removes its private adapter and build changes. Shared Kandelo
platform fixes keep their own owners and regression tests.

The user's direction is to document these adaptations and migrate them back.
A future Wasm backend still needs its own reviewed design and acceptance;
exposing a `WebAssembly` object alone is insufficient. Meaningful new source
boundaries retain the execution plan's explicit-review requirement.

For every release candidate, retain an inventory of:

- Each base engine patch and its included **and excluded** complete file
  sections, with the manifest's reason and digest. Excluded shell/bootstrap
  sections are preserved history; they are not available as fallback behavior.
- Each complete producer engine, Node build and native-source patch, its digest,
  touched files, owning component, purpose and protecting test inventory.
- Every native bridge input actually staged by `build-bridge.py`, including the
  private header interfaces and source preparation scripts. Do not inventory
  an unused V8 API as an implementation requirement merely because it exists.
- Original archive and intake-manifest identities, direct dependency versions
  and build revisions, selected profiles, compiler/SDK, ABI, generated build
  inputs and resulting artifact identities.

The engine manifest already classifies every legacy patch section. Keep that
classification authoritative. A release inventory should reference it rather
than maintain a second independent selection list. Patch and bridge tests can
overlap, but the inventory must identify gaps honestly. An old development
receipt or a test on a different artifact is not a current passing result.

The current candidate's exact source/artifact identities, 18 VM controls and
HTTP Fetch/provider controls are retained under
`.context/node-upstream-execution/shipping-vm-fetch-core27-parser2-20261121/`.
They pass separately on all four hosts; normal-app checks also pass on the three
browsers. `MAINTAINED-JS-BOUNDARIES.json` authenticates the two Node patch-chain
JavaScript changes and records the inspected native Amaro wrapper staging.
Canonical/browser-memory and permanent npm qualification have passed. The
installed naming change has also passed separate four-host npm and normal-app
checks. See the checked-in [validation summary](nodejs-upstream-validation.json)
for the bounded gates, artifact identities and remaining limits. These results
do not establish full core-module conformance.

## Reproduce an upstream upgrade

1. Preserve the current candidate, frozen acceptance inventories, original raw
   sources and full failure logs. Use a separate checkout; never edit registry
   inputs while their normal package build is validating them. Record exact
   upstream versions, archive digests and any coordinated toolchain PR commit.
2. Authenticate the new upstream source archive independently. Compare its full
   source inventory with the previous intake. Review changes to Node startup,
   Environment, loaders, registration lists, callback policy, parser diagnostics,
   contextify, GC/cleanup and dependency settings. A clean textual patch does
   not establish unchanged behavior.
3. Reapply the base engine section projection using
   `spidermonkey-core/apply-engine-patches.py`, then all producer patches in the
   recipe's sorted order. Reject unexpected identities, rejects, fuzz and
   offsets. Keep complete source files and whole diff sections; do not recover
   a failed patch by extracting old function bodies.
4. Apply the Node and native-source patch chains to fresh complete files in the
   same order as the normal build. Retain full application output and verify
   both forward and reverse identities. Explicitly reject offsets as well as
   fuzz in this upgrade review, even where a build's `patch -F0` invocation
   would otherwise allow an offset. Update reviewed hashes only after examining
   the source changes that caused the conflict.
5. Reconcile the bridge's pinned V8 metadata, source hashes and generated
   interfaces. Compare the corresponding upstream operation and Node callers
   together. Preserve Node policy and adapt engine operations at their owner;
   do not grow an alternate loader, timer queue or process policy in the bridge.
6. Review native dependency versions/configuration with their consuming owners.
   Preserve symbol isolation and loader/callback/buffer lifetimes. Keep the
   approved capability follow-ups explicit. A newly missing backend is work,
   not permission to suppress a registration or advertise successful behavior.
7. Build complete normal default and feature profiles through
   `scripts/dev-shell.sh`, with SourceOnly explicit and cache GC disabled for
   the retained run. Preserve upstream registration lists. Collect complete
   related compiler/linker failures, fix that set and retain the failed run
   before starting a changed candidate. Do not retry unchanged commands.
8. Authenticate the resulting executable, providers, kernel, host sources and
   normal package/image. Run installed startup first, then all applicable
   frozen CLI/slice/CJS/ESM, VM/REPL, JS/TS, npm, native retirement and
   browser-memory checks. Run approved real HTTP Fetch cases once that backend
   is selected and implemented. Keep Node, Chromium, Firefox and WebKit separate,
   with the existing finite budgets and no automatic retries.
   Regenerate the maintenance inventory against the actual build selection.
   Review changed/new source roles, reasons and protecting tests in the contract
   catalog; an unclassified input must stop inventory generation. Preserve the
   preceding inventory rather than overwriting its source or result identities.
9. Publish a release-readiness record that binds each result to those exact
   artifacts. Include failures, skips, unrun checks, network boundaries,
   maintained adaptations, test gaps and limitations. Create a reproducible
   local shipping checkpoint only after every required check passes. Initial
   shipping and the later B6 review do not establish the full 19-family port.

A meaningful change to an approved source, ownership, capability or acceptance
boundary stops for the user's explicit review. Routine compiler/link/startup
fixes within those boundaries do not need repeated permission. Another version
upgrade is not required merely to validate this maintenance procedure.
