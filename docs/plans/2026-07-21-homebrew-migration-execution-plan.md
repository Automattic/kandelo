# Homebrew Migration Living Execution Plan

- Status: active
- Last reconciled: 2026-07-22
- Primary repositories: `Automattic/kandelo` and
  `Kandelo-dev/homebrew-tap-core`
- Purpose: preserve the complete Homebrew migration scope, record what has
  actually landed, and define the remaining execution order.

This is a living execution plan, not a claim that unfinished behavior is
supported. Update the status and evidence here as work lands. Do not delete a
goal merely because it is not part of the next pull request. A goal leaves this
plan only when it is completed with evidence or explicitly superseded with the
replacement decision recorded in the disposition log.

## Source Plans And Preservation Rule

This plan reconciles, rather than silently replaces, the earlier Homebrew work:

- the 2026-07-05 handoff and forward execution plan at Git commit
  `495250692766badd641ac623a26ba9417ee5059d`;
- the 2026-07-01 built-in-versus-custom publishing research and the
  2026-07-05 bottle-publishing checkpoint, also preserved at Git commit
  `495250692766badd641ac623a26ba9417ee5059d`;
- the 2026-06-30 registry-replacement contract at Git commit
  `1663df07620e535de57e8381694f56766109e14c`, whose reviewed document is
  Git blob `4e46613107051176cc41592f437bcf83a8a69fa2`;
- the 2026-06-28 all-package inventory whose last reviewed Git blob is
  `ed0dbe477554be8d7bb3fbe4f90e95450b5de85c`;
- `2026-06-25-homebrew-ci-github-packages-bottle-publishing-design.md`;
- `2026-06-27-homebrew-tap-layout-metadata-schema-design.md`;
- `2026-06-28-homebrew-vfs-builder-pour-link-design.md`;
- the 2026-07-05 Homebrew-idiomatic tap-layout draft, now tracked at
  `docs/plans/2026-07-05-homebrew-tap-layout-idiomatic-spec.md` with exact Git
  blob `415a0ab2ea1cec996c8df2bad8c0d2675046a7f7`; this preservation commit makes
  the source durable, because an untracked workspace copy is not a durable
  source plan; and
- product decisions made while landing PRs #973 through #1049. PR #1049
  landed at `466a685d9366d3b712c4fe998307e00157bd5d15`.

The historical plans contain point-in-time repository names, ABI versions,
package counts, and implementation guesses. This plan updates those facts but
retains their unresolved product scope. In particular, the following are not
removed:

- Formulae ultimately replace duplicate `packages/registry` package recipes;
- stock upstream Homebrew runs inside Kandelo and installs bottles;
- conventional third-party taps work through the same publisher and runtime;
- package failures and upstream-test results remain visible;
- Node.js and browser hosts remain peer product surfaces;
- every old registry role is classified before registry removal;
- service and application images become bottle-composed; and
- VFS packages ultimately declare Homebrew dependencies and support
  user-selected, mix-and-match composition.

## End State

Kandelo packages are first-class Homebrew packages:

1. A normal Formula is the source of truth for source identity, direct
   dependencies, build, install, and test behavior.
2. Trusted CI publishes immutable, public Homebrew bottles to the Formula's
   repository-rooted GHCR namespace and generates matching Kandelo sidecars.
3. A stock upstream `brew` running inside Kandelo can tap, resolve, pour, link,
   test, and uninstall packages from the first-party and third-party taps.
4. The VFS composer consumes those same verified bottle bytes. Image policy
   decides which complete bottle closures are embedded and which remain
   first-use deferred trees.
5. The main shell is small, starts offline, and exposes the broader software
   catalog through bottle-backed lazy filesystem references.
6. VFS recipes can themselves be packaged as Homebrew bottles with Homebrew
   dependencies, allowing users and products to combine reviewed VFS layers
   instead of requiring one monolithic image per runtime.
7. The temporary registry/build bridge is removed after every accepted package,
   support directory, platform artifact, and composite-image role has an
   explicit durable owner.

## Invariants And Locked Product Decisions

### Platform correctness

- Packages exercise the normal SDK, libc, resolver, VFS, syscall, host, and
  kernel path. A Formula or demo must not hide a Kandelo POSIX defect.
- Node.js and Chromium/browser validation are required before claiming a
  package or image works on both hosts.
- ABI identity, architecture, Formula revision, bottle rebuild, source commit,
  digest, byte count, and validation run remain explicit artifact evidence.
- The Homebrew platform tags remain `wasm32_kandelo` and `wasm64_kandelo`;
  kernel ABI identity lives in sidecars, release/package namespaces, cache
  identity, and validation evidence rather than being encoded into those tags.
- Formula tests and focused runtime smokes gate bottle publication. Complete
  upstream suites are tracked as pass, fail, partial, skipped, incomplete, or
  unavailable without making every upstream suite a default publication gate.
- Package status is keyed by package, version, Formula revision, bottle
  rebuild, architecture, ABI, and host where the host is applicable. Every
  non-success record carries a category, concrete reason, exact attempt or run,
  first useful error or durable artifact pointer, last-green state, owner
  class, and next action.
- Complete upstream-test evidence names the exact harness and command, start
  and end timestamps, pass/fail/skip/timeout/unsupported/incomplete counts,
  complete failure and skip lists, known-failure references, and digest- and
  size-bound artifacts. Missing parser categories are themselves recorded as
  incomplete evidence rather than flattened into success.
- Last-green selection is explicit in status, composition, and image
  provenance. A fallback must pass the same architecture, ABI, digest, byte
  count, cache identity, and complete-inventory checks as a current success;
  failure of those checks is visible and never silently selects another
  artifact.
- A Formula's `test do` exercises its result through Kandelo rather than a
  native-host substitute.
- Failed or deferred packages remain discoverable with their real reason; they
  do not disappear from the package index.

### Repository and publication identity

- `Kandelo-dev/homebrew-tap-core` is the canonical first-party repository and
  `kandelo-dev/tap-core` is its canonical Homebrew tap name.
- `Automattic/kandelo-homebrew` is retired and archived. It is historical state,
  not an alternate production tap.
- Bottle packages use the repository-rooted namespace, for example
  `homebrew-tap-core/zlib`. The package name does not use a `tap-core/` prefix.
- Production publication uses the caller repository's built-in `GITHUB_TOKEN`.
  A PAT was a bounded visibility experiment, not a production dependency.
- New package visibility is proved by repository-linked, public-by-default
  creation plus anonymous exact-byte readback. Do not add a per-package
  visibility mutation step.
- Formulae and bottle metadata remain Homebrew-native. Kandelo metadata is
  additive provenance, VFS planning, validation, status, and audit data; stock
  `brew install` must not require a Kandelo sidecar.
- Reuse upstream Homebrew build, install, test, and bottle semantics wherever
  they express the contract. The current production publisher intentionally
  uses Kandelo's credential-isolated OCI/ORAS transport and transactional
  sidecar finalizer instead of `brew pr-upload`/`pr-pull`. Kandelo-specific
  wrappers are limited to real target, trust, transaction, ABI, VFS, and
  cross-host validation boundaries and remain documented deviations rather
  than a second package manager.
- Bottle bytes are canonical in GHCR. A browser-compatible release or
  same-origin copy may be a transport mirror only when it is byte-identical and
  bound to the canonical bottle digest and size.

### Shell and VFS policy

- The main shell remains composed from public Homebrew bottles; there is no
  legacy package-archive fallback hidden underneath it.
- Bash is the image-defining shell. CI extracts Bash and its complete runtime
  dependency closure into the serialized base VFS so an offline boot reaches a
  prompt without a deferred fetch.
- Dash remains available as a deferred compatibility package initially. A
  change from `/bin/sh -> dash` to `/bin/sh -> bash` requires the full relevant
  POSIX shell and browser startup evidence; if that evidence fails, retain or
  embed Dash rather than weakening shell behavior.
- Dinit is not a generic main-shell dependency. A service-oriented image that
  uses Dinit as PID 1 embeds Dinit, `dinitctl`, and their complete runtime
  closure.
- The remaining shell package closure is represented as per-bottle first-use
  deferred trees. Opening, reading, mapping, or executing an owned path uses the
  same materialization path on Node.js and browser hosts. The first production
  cutover fetches and verifies the complete original bottle archive on first
  use of any file in that bottle; it does not require HTTP range access or
  per-file transport objects. Independently hashed finer-grained transport may
  be evaluated later without changing the guest VFS contract.
- Python, Perl, Erlang, and Ruby are intended to be usable lazily from the main
  shell. Do not create a default VFS image per language runtime. Retain the
  dedicated Node.js demo as the current exception.
- A future VFS packaging iteration gives each product VFS a Homebrew Formula,
  Homebrew dependencies, and a bottle so consumers can mix and match layers.
  This is deferred from the first lazy-shell proof, not removed.

## Evidence-Based Status Snapshot

The following is a point-in-time snapshot. A pull request, run, or package is
complete here only when its exact accepted artifact has been verified.

| Workstream | State | Evidence and remaining boundary |
|---|---|---|
| Public publisher foundation | Complete | Repository-rooted public GHCR creation, anonymous readback, immutable trust, retry/recovery, coordinated finalization, and immutable VFS releases are implemented. PR #1048 landed the clean-input coordinated-finalizer fix at `1618563d87dd2207077ce228040cc9b2c773eb5e`. The production path uses `GITHUB_TOKEN`. |
| Canonical tap migration | Complete for the production repository | PR #973 retargeted publication to `Kandelo-dev/homebrew-tap-core`; the old Automattic tap is archived. |
| Core Formula coverage | Broad but incomplete | The live core tap currently contains 61 Formula files plus its Formula README, with 60 sidecar package records and 67 successful architecture-specific bottle records at this snapshot. This covers the complete 38-Formula main-shell closure and several language runtimes, but not every historical registry role; Formula presence alone does not prove publication. |
| Bottle-composed main shell | Complete, currently eager | PR #1025 builds and publishes the current main shell from the exact public 38-Formula closure and proves the exact image in Node.js and Chromium. All poured content is currently serialized into the VFS, so laziness still needs restoration. |
| Language bottles | Public publication complete; lazy-shell acceptance pending | Ruby is public and runtime-verified. Coordinated run `29886510272` built, publicly uploaded, anonymously verified, and atomically finalized Python `3.13.3_1` and Erlang `28.2_1` at tap commit `00ba350ffcee7df02fb9f329bb3c62873ae50831`. It also published and anonymously read back the immutable browser-proven Python VFS release `homebrew-vfs-sha256-db98a17118afeb91d7c8d939fecc8c482ba765cbbe63b242ccf2834de2b48119`. Perl is published. Python, Perl, Erlang, and Ruby still need inclusion in the final lazy-shell language acceptance matrix. |
| Third-party tap model | Live publisher proof complete; guest use remains | The stricter load-order-independent cross-tap runtime contract landed in Kandelo as PR #1046 at `bd2b090e3e6998350be24ed018bbb76d3eb5b012`, in the core tap as PR #82 at `caad125218a2e3c6f05d290151a32128ec6c54ac`, and in the canary as PR #13 at `25069ad2acb7f86746ec3d119a823e8210a7a1eb`. PR #1049 landed the active-repository tap-store correction at `466a685d9366d3b712c4fe998307e00157bd5d15`; core-tap PR #83 pinned it at `cbb439454adf2718b010d0fe2caffe7158340a0e`, and canary PR #14 pinned it at `ee4464b87b988b163608b6c3520c2260907bda61`. Independent run `29886510154` is completely green: public M4 package and index, anonymous exact-byte pour, dependency-bearing Node.js and Chromium image proof, transactional tap finalization, and immutable five-asset VFS release `homebrew-vfs-sha256-40a44df5c6f139a4e9105b5155040be757bc20596dc5dce2d7a64286447d9f3e`. Conventional third-party `brew tap` and `brew install` inside the guest remain Phase 5 work. |
| Deferred bottle trees | Direct producer checkpoint in the current PR; Phase 3 composer in progress | PR #1051 landed the generic substrate at `122e62a77ffeb40039bee3f2b29cd5f82ed6b1fe`: exact transport identity, bounded tar+gzip and legacy ZIP decoding, hardlink preservation, atomic batch import and materialization, shared first-open/exec behavior, independent immutable runtime-layer identity, and boot-descriptor composition. PR #1052 landed the reviewed 3-embedded/35-deferred main-shell policy at `0dbeb2e0e644fff41510045dccb76f11e2d23042`; it selects `libcxx`, `ncurses`, and `bash` for physical embedding but does not yet compose or publish that shell. PR #1053 landed deterministic checked-in software-gallery browser fixtures at `77358bf5a6081c0561cd73c2bd7db3d15ac6730d`, keeping the exact browser gate independent of generated local files. The current `[Homebrew] Turn each bottle into an independently lazy VFS tree` PR maps every selected Formula to its own byte-identical original-bottle candidate tree, carries complete source and guest inventories, validates package/keg/activation and mode-copy bindings in both TypeScript and the independent release validator, and publishes the descriptor plus the exact multi-bottle asset set. The boot runtime-layer consumer remains intentionally one requested root per layer reference; Phase 3 uses the collection primitive directly for the multi-root main shell. Focused host, release, ABI, and synthetic direct-TAR Chromium validation gate this checkpoint. This is still not the production shell cutover: the in-progress Phase 3 composer must compute ownership across all 38 Formulae, materialize exactly the three policy-selected bottles, retain exactly 35 trees as pending, publish their browser-readable mirrors, republish the shell artifact, and run complete command-surface evidence. |
| Guest upstream `brew` | Partial experiment | A bootstrap image can run upstream Homebrew and its Ruby support. General `brew tap`/`brew install` from public first-party and third-party bottles is not yet a supported shell capability. |
| Registry replacement | Incomplete | Formulae are increasingly authoritative, but `packages/registry` still owns recipes, platform artifacts, tests, and composite-image definitions. It cannot be deleted yet. |
| Bottle-declared, mix-and-match VFS packages | Future retained scope | The current composer produces precomposed images. VFS Formulae/bottles and user-selectable composition remain a later product iteration. |

## Execution Order

Work in different repositories may proceed concurrently when immutable inputs
make the results independent. Do not serialize unrelated Formula rollouts, but
do preserve the single-writer finalization and exact-commit trust contracts.

### Phase 1: Close the active publication and federation work

1. Completed by PR #1048 and run `29886510272`: fix the
   coordinated-finalizer boundary that let one package's generated sidecars
   dirty the provenance source for the next package, then publish Python and
   Erlang against the final trusted publisher pins.
2. Completed: verify final tap commit
   `00ba350ffcee7df02fb9f329bb3c62873ae50831`, Formula bottle blocks,
   sidecars, public package visibility, immutable tags, and anonymous
   exact-byte reads.
3. Completed: PR #1046 passed its exact-head and synthesized-merge gates and
   landed as `bd2b090e3e6998350be24ed018bbb76d3eb5b012`.
4. Completed: the first-party core tap and independent canary were pinned to
   landed immutable producer and dependency commits through core PR #82 and
   canary PR #13.
5. Completed by independent run `29886510154`: the M4 third-party proof passed
   dependency resolution, public anonymous bottle fetch, tap finalization,
   Node.js VFS acceptance, Chromium VFS acceptance, and immutable release
   readback at canary tap head
   `a299f1bf894627ff2c2ccf5cdbb9837c9d820a97`.

Checkpoint: Phase 1 is complete. PRs #1048 and #1049 are landed, and both tap
callers pin #1049's immutable merge commit. Independent M4 run `29886510154`
is green through its immutable release at canary tap head
`a299f1bf894627ff2c2ccf5cdbb9837c9d820a97`. Python/Erlang run `29886510272`
is green through public upload, anonymous verification, atomic tap
finalization, and immutable Python VFS release readback at core tap head
`00ba350ffcee7df02fb9f329bb3c62873ae50831`.

Acceptance:

- Python and Erlang have durable, public, anonymously readable bottle and
  sidecar identities.
- A conventional independently owned tap consumes the exact locked core
  package through the same reusable workflow with no dependency-tap secret.

### Phase 2: Land the generic deferred-tree substrate

The substrate must solve the general VFS problem, not special-case Python or a
demo button.

1. Introduce a versioned descriptor with independent transport identity,
   decoder, complete inventory, ownership, and activation policy.
2. Retain explicit bounded ZIP support for existing Vim/NetHack consumers, and
   add bounded browser-safe tar+gzip support for original Homebrew bottle bytes.
3. Preserve regular files, directories, modes, symlinks, and hardlink inode
   relationships. Reject unsafe paths, duplicates, cycles, unsupported types,
   missing or extra members, digest drift, and inventory drift.
4. Enforce compressed-byte, inflated-byte, per-entry, aggregate-entry, and
   entry-count caps while decoding.
5. Decode and validate a complete group before atomically mutating the VFS.
   Failed materialization must leave retryable, unchanged filesystem state.
6. Route ordinary `open`/`read`, mapping, and `exec` through one shared
   materialization contract on both Node.js and browser workers. Concurrent
   consumers fetch and materialize one time.
7. Preserve descriptors through VFS serialization, worker protocol transfer,
   URL rewriting, snapshot, restore, and filesystem rebase. Review the VFS/ABI
   compatibility impact explicitly.
8. Keep transport identity separate from location. Node.js may read public
   GHCR directly; browser deployment uses a byte-identical immutable mirror
   when GHCR's bearer-token CORS flow cannot be consumed safely.

Acceptance:

- Focused parser and MemoryFS tests cover success, concurrency, retry, limits,
  malformed archives, inventory mismatch, hardlinks, snapshot/rebase, and the
  legacy ZIP adapter.
- Producer-backed exact original-bottle bytes materialize on first ordinary
  read and execution in Node.js. Chromium proves the same decoder, inventory,
  first-use, fetch-count, and rollback behavior through a synthetic
  browser-readable direct-TAR route. Live public-release mirror retrieval
  remains a Phase 3 cutover item.
- Registration and `stat` alone do not fetch first-use trees.

Checkpoint: the generic deferred-tree substrate landed through PR #1051 at
`122e62a77ffeb40039bee3f2b29cd5f82ed6b1fe`.
The 3-embedded/35-deferred selection policy landed through PR #1052 at
`0dbeb2e0e644fff41510045dccb76f11e2d23042`, and the deterministic checked-in
browser fixtures used by the exact gate landed through PR #1053 at
`77358bf5a6081c0561cd73c2bd7db3d15ac6730d`.
The direct producer follow-up retains exact original bottle bytes, one package
per tree, complete source and guest projections, and multi-asset release
closure. Its new source inventory and `archive-copy-mode` fields are additive:
new hosts accept existing schema-4 ZIP and legacy serialized trees, while old
hosts fail closed on the unfamiliar direct shape. They do not change the
kernel/process ABI. The current direct-producer PR is the remaining Phase 2
checkpoint. The Phase 3 composer is in progress, not complete: it still must
apply the landed policy to the globally owned 38-Formula collection, publish
the deferred mirrors, and republish and validate the resulting shell. Those
items remain the boundary between Phase 2 and the Phase 3 cutover.

### Phase 3: Restore full main-shell laziness

1. Generate a complete inventory for the exact reviewed 38-Formula shell
   closure from each original bottle, including modes, link targets, hardlinks,
   digest, byte count, Formula identity, and tap commit.
   The measured baseline is 47,486,181 compressed bottle bytes and 9,761
   archive entries, including 1,039 hardlinks; current link manifests alone are
   therefore not a complete deferred-tree inventory.
2. Classify the closure by image policy:
   - embedded base: Bash and its complete runtime closure, plus the namespace,
     profile, certificates, configuration, and metadata needed for an offline
     first prompt;
   - first-use: Dash initially, general utilities, editors, games, network
     tools, compression tools, and their non-embedded dependencies.
3. Publish browser-readable, byte-identical immutable mirrors for only the
   deferred bottles. Never recompress them into a new ZIP as the production
   endpoint.
4. Build the serialized VFS with truthful namespace stubs for every deferred
   file and link. Preserve the current migration lock's command surface,
   substitutions, conflict ownership, profile fragments, writable runtime
   state, and demo metadata.
5. Decide `/bin/sh` from evidence. Prefer Bash for the default image if the
   complete POSIX and startup surface passes; otherwise preserve Dash semantics
   without introducing a network dependency into boot.
6. Publish the resulting shell through the normal package and browser release
   path and update the exact shell acceptance gate.

Producer checkpoint: the low-level collection interface can already run the
complete plan once, apply global collision ownership, and return one exact
bottle payload/tree per package plus the complete eager conflict report. It
does not choose or serialize the product partition. Phase 3 must compute
ownership across the full 38-Formula closure before selecting Bash's complete
embedded runtime closure. PR #1052 fixes that partition at three embedded
packages (`libcxx`, `ncurses`, and `bash`) and 35 deferred packages. The
in-progress composer must materialize exactly those three globally projected
trees, leave exactly 35 pending, preserve the full-plan consumer-owned profile
and runtime state, generate the exact production shell partition, retrieve its
public mirrors, and publish and measure the resulting shell. Before publication,
the exact closed host/VFS binding must pass without `page.route` or service-worker
interception. After publication, Chromium must read the real anonymous public
URLs through the normal browser worker/VFS fetch path. This checkpoint does not
remove or defer any of those acceptance items.

Acceptance:

- With all deferred transports disabled, the image boots offline into its
  embedded Bash prompt and its embedded closure has no unresolved lazy inode.
- Every non-embedded bottle remains unfetched at boot and materializes exactly
  once on first ordinary access or execution.
- The complete locked command surface passes on Node.js and Chromium.
- The produced shell archive and deployed browser asset are exact-byte bound.
- Report compressed VFS size, embedded bytes, total deferred bytes, first-prompt
  fetch count, and representative first-use fetch sizes before and after.

### Phase 4: Expose language runtimes lazily in the main shell

1. Add Python, Perl, Erlang, and Ruby plus each exact runtime dependency closure
   to the shell's reviewed lazy package selection.
2. Keep their complete standard libraries and runtime data in the owning bottle
   groups; do not fake availability with only an interpreter executable.
3. Exercise representative interpreter, standard-library/module, filesystem,
   process, and dependency behavior on Node.js and Chromium.
4. Keep the language-specific VFS builders only where they remain explicit
   tests or compatibility tools. Do not advertise one default product image per
   language. The existing Node.js demo remains the deliberate exception.

Acceptance:

- A fresh main shell lazily starts each language and runs its reviewed smoke
  without prefetching unrelated language groups.
- Runtime paths, dynamic libraries, modules, and data resolve from the normal
  installed Homebrew prefix.

### Phase 5: Ship usable upstream Homebrew inside Kandelo

1. Reassess the existing bootstrap image against current main and record exact
   results for `brew --version`, `brew config`, `brew doctor`, `brew tap`, and
   bottle installation.
2. Give guest Homebrew a truthful writable installation/state model without
   weakening the immutable provenance of the base image or canonical bottle
   cache.
3. Close ordinary platform blockers in Ruby, process/pipe behavior, networking,
   TLS, GHCR bearer authentication, filesystem links/permissions, or subprocess
   execution at their owning layer.
4. Make the upstream `brew` command available from the main shell. Its own
   embedded-versus-deferred policy may be selected from measured startup and
   size evidence; invoking it must not depend on host-side Formula emulation.
5. Prove a first-party core bottle install and a cross-tap M4 install, including
   dependency resolution, linking, execution, upgrade/uninstall state, and loud
   failures for ABI or digest mismatch.
6. Preserve and run the historical build-time pour proof before deciding its
   disposition: boot Kandelo, have stock upstream `brew` install the exact
   reviewed shell closure, call `saveImage()`, and compare package ownership,
   links, Homebrew receipts, and provenance with the direct composer. Record an
   evidence-backed keep, replace, or retire decision; the existence of the
   current direct composer is not that evidence by itself.

Acceptance:

- Stock upstream Homebrew, with only the documented Kandelo target/platform
  boundary, installs and runs public bottles inside Kandelo on Node.js and
  Chromium.
- User documentation can finally publish truthful `brew tap` and
  `brew install` instructions.
- The historical build-time `brew`-pour/`saveImage()` proof has exact run
  evidence and an explicit disposition against the direct composer.

### Phase 6: Finish package migration and retire duplicate recipes

Use a machine-checked inventory. Do not infer completion from the number of
Formula files.

1. Reconcile every historical registry entry against the live tap, including
   renamed identities such as `cpython -> python`, `file -> file-formula`, and
   browser-bundle-to-Formula replacements.
2. Port or explicitly classify remaining leaf packages, heavy runtimes,
   services, internal artifacts, source helpers, support directories, and
   composite images.
3. Preserve the unresolved ownership decisions for:
   - platform/internal artifacts: `kernel`, `userspace`, `kandelo-sdk`, and
     `kernel-test-programs`;
   - support/source roles: `node-compat`, `npm`, and `pcre2-source`;
   - incomplete or ambiguous packages: `sqlite-cli`;
   - not-yet-core service/runtime work including Dinit, PHP, Redis, Nginx,
     SpiderMonkey/Node, MariaDB, Tcl, msmtpd, and their dependent images.
4. Move authoritative source, dependency, install, and test behavior to
   Formulae. Keep a documented, bounded build-script bridge only while a heavy
   port cannot yet be expressed idiomatically; give every bridge an owner and
   exit criterion.
5. Remove registry recipes only after Formula, bottle, sidecar, build-from-source
   fallback, Node/browser smoke, docs, and recovery operations cover the same
   role. Platform artifacts that do not belong in Homebrew move to a named
   platform-owned release contract instead of disappearing.
6. Enumerate every historical and current declared `(Formula, architecture)`
   target. Each declared wasm32 or wasm64 pair needs current success evidence
   or an explicit `failed`, `deferred`, `unavailable`, `blocked`, `excluded`,
   or intentionally removed disposition. Any architecture narrowing is an
   explicit reviewed disposition, never an inferred consequence of a missing
   bottle.
7. Make package reconciliation durable for `success`, `failed`, `pending`,
   `building`, `deferred`, `unavailable`, `blocked`, and `excluded` states.
   Generate both operator and community reports, and add negative tests that
   reject missing categories, reasons, attempts, first errors or artifacts,
   fallback completeness, owners, or next actions.
8. Maintain one deviations register for `HOMEBREW_KANDELO_ROOT` and the SDK
   bridge, the target/tag patch, every Tier-2 build script, the tap
   trust/audit boundary, and fork instrumentation. Every row names why the
   deviation exists, its platform or external boundary, its owner, and its
   exit criterion. The `kandelo-sdk` ownership decision must settle the SDK
   bridge rather than leaving it as ambient worktree state.

Acceptance:

- A generated report accounts for every original registry directory and every
  live tap Formula with one authoritative owner and disposition.
- That report accounts for every declared Formula architecture and records
  explicit evidence or disposition for each historical and current wasm32 or
  wasm64 target.
- No accepted package has two drifting recipe sources.
- Removing the registry bridge does not remove tests, patches, demos,
  provenance, source distribution, or failure visibility.
- Negative schema and report tests prove that non-success packages,
  last-green failures, incomplete upstream-test evidence, and architecture
  narrowing cannot disappear from operator or community views.

### Phase 7: Bottle-compose service, application, and selectable VFS layers

This phase preserves the wider image ambition while allowing the shell proof to
land first.

1. Define a VFS Formula/bottle contract: a VFS package declares normal Homebrew
   dependencies and bottles its own image-owned files, configuration, service
   graph, writable-state declarations, and presentation metadata.
2. Compose VFS packages and ordinary Formula bottles through the same verified
   closure planner. Detect ownership conflicts before mutation and retain exact
   provenance per layer.
3. Let products and users select compatible VFS layers instead of requiring a
   fixed image for each language runtime.
4. Apply the contract to the Node.js demo and then service/application images:
   Dinit-based services, MariaDB test/runtime, LAMP, and WordPress.
5. Embed boot-critical supervisors and their closures in service images; leave
   optional application/data groups deferred where first-use semantics are
   truthful.
6. Produce a durable, generic software-gallery/index record for every eligible
   Formula and VFS entry. Eligibility requires exact wasm32 publication
   success, an immutable image identity, explicit `browser_compatible`
   evidence, and a real Chromium boot of that image. Per-run diagnostics are
   inputs to this durable index, not the endpoint; launch failures remain
   visible instead of removing the entry or presenting a synthetic success.

Acceptance:

- At least two independently bottled VFS layers with shared and cross-tap
  dependencies compose deterministically in either declared load order or fail
  before mutation with a real ownership conflict.
- Node.js and Chromium boot and exercise the resulting service/application
  image through the same image and runtime contracts.
- Eligible Formula and VFS entries survive as durable gallery/index records
  bound to exact wasm32, immutable-image, compatibility, and real Chromium
  evidence, including visible launch failures.

### Phase 8: Operations, documentation, and final cleanup

1. Update package authoring, publishing, third-party tap, browser/VFS, guest
   Homebrew, rollback, rebuild, and incident-response documentation from the
   actual supported paths.
2. Keep old ABI releases and live last-green bottles needed for reproducibility
   and rollback. Retired never-live `hello` packages may remain when repository
   permissions prevent deletion; they are not a migration blocker.
3. Record GitHub Packages storage/quota policy and source-distribution/licensing
   requirements before broad heavy-runtime retention grows unbounded.
4. Decide whether to upstream Kandelo architecture/tag support to Homebrew or
   continue carrying the minimal reviewed patch, and document the maintenance
   boundary.
5. Remove obsolete fixtures, canary-only secrets, dead workflows, duplicate
   package definitions, and compatibility scaffolding only after their
   replacement acceptance has passed.
6. Run the exact final Node.js, Chromium, POSIX/libc/Sortix where relevant,
   package publication, anonymous readback, guest install, third-party tap, and
   deployed-browser acceptance matrix. Report anything not run.
7. Add dated amendment headers to the preserved 2026-07-01 publishing research
   and the relevant 2026-07-05 publishing checkpoint and handoff. Point those
   headers to this living plan and its disposition log while preserving the
   historical text. Clearly mark superseded conclusions about upload tooling,
   ABI-in-tag naming, guest-`brew` support, the pour/composer path, and lazy
   archive format; do not rewrite the old documents as if they predicted the
   current design.
8. Decide whether artifact attestations are required for first-party and
   third-party bottles. If required, make them additive to commit, digest,
   byte-count, and anonymous-readback evidence; if not required, record the
   explicit decision, rationale, owner, and reconsideration boundary.
9. Keep the generic software gallery/index durable outside individual CI run
   diagnostics, and verify that eligibility and launch-failure evidence remain
   queryable after a newer failed attempt.

Acceptance:

- The historical amendment headers preserve the old text while routing current
  decisions to this plan.
- The artifact-attestation requirement or explicit non-requirement is recorded
  for both first-party and third-party publication.
- Durable status and gallery records retain non-success attempts, exact
  artifact and browser evidence, last-green selection, and visible launch
  failures after CI artifacts expire.

## Inventory Preservation Ledger

The historical inventory comprised 73 package manifests plus the
`node-compat` and `npm` support directories. Its complete source remains the
reviewed blob named above. The current registry has 75 valid manifests plus
those two support directories: `hello` was retired while `icu`, `libiconv`, and
`libzip` were added. The following grouped ledger prevents the remaining roles
from being lost while the machine-readable reconciliation is built.

- Shell/base and CLI roles: `bash`, `bc`, `bzip2`, `coreutils`, `curl`, `dash`,
  `diffutils`, `fbdoom`, `file`, `findutils`, `gawk`, `git`, `grep`, `gzip`,
  `less`, `lsof`, `m4`, `make`, `modeset`, `msmtpd`, `nano`, `netcat`,
  `nethack`, `posix-utils-lite`, `sed`, `tar`, `tcl`, `texlive`, `unzip`,
  `vim`, `wget`, `xz`, `zip`, and `zstd`.
- Libraries and dependency roots: `icu`, `libcurl`, `libcxx`, `libiconv`,
  `libpng`, `libxml2`, `libzip`, `ncurses`, `openssl`, `sqlite`, and `zlib`.
- Language and heavy runtime roles: `cpython`, `erlang`, `perl`, `php`, `ruby`,
  `spidermonkey`, `spidermonkey-node`, and `node`.
- Service roles: `dinit`, `mariadb`, `nginx`, and `redis`.
- Platform/internal/source/support roles: `kandelo-sdk`, `kernel`,
  `kernel-test-programs`, `userspace`, `pcre2-source`, `sqlite-cli`,
  `node-compat`, and `npm`.
- Composite and VFS roles: `rootfs`, `shell`, `erlang-vfs`, `python-vfs`,
  `perl-vfs`, `node-vfs`, `vim-browser-bundle`, `nethack-browser-bundle`,
  `mariadb-vfs`, `mariadb-test`, `lamp`, and `wordpress`.

The live tap also contains Formulae that were not one-to-one names in that
historical inventory, including support utilities and split dependencies. They
must appear on the generated reconciliation rather than being treated as
unowned extras. The registry has also gained `icu`, `libiconv`, and `libzip`
since that historical inventory; this ledger deliberately carries them
forward too.

## Disposition Log

Record explicit scope changes here. Do not rewrite history by deleting an old
goal from an earlier section.

| Decision | Disposition |
|---|---|
| Retarget `Automattic/kandelo-homebrew` to `Kandelo-dev/homebrew-tap-core` | Completed by PR #973; the old repository is retired and archived. |
| Use a PAT for public package creation | Superseded by the proven built-in `GITHUB_TOKEN` repository-linked public-creation path. The PAT remains experiment history only. |
| Publish `hello` as the ongoing canary | Superseded. `hello` was retired from product publication by PR #1028; Zlib/core bottles and independent M4 provide real controls. |
| Build the current main shell from bottles | Completed by PR #1025, but the output is eager. Restoring laziness remains Phase 3. |
| Require `brew pr-upload`/`pr-pull` plus Skopeo for bottle transport | Superseded by the implemented credential-isolated OCI/ORAS transport, while upstream Homebrew remains authoritative for build/test/bottle semantics. |
| Encode kernel ABI in the Homebrew platform tag | Superseded. Keep `wasm32_kandelo`/`wasm64_kandelo`; bind ABI through sidecars, namespaces, caches, and validation evidence. |
| Delete `Kandelo/link` as soon as host composition exists | Superseded for the current verified composer. Link manifests remain valid additive inputs; deferred bottles additionally require a complete mode/link/hardlink inventory. |
| Use a derived ZIP as the Homebrew lazy-layer endpoint | Rejected for production. Preserve original bottle bytes and use decoder-neutral descriptors; ZIP remains a supported legacy/general archive format. |
| Boot-prefetch Bash | Superseded by the explicit decision to embed Bash and its complete runtime closure in the shell VFS. |
| One default VFS per language | Rejected, except for the retained Node.js demo. Languages belong in the main shell as lazy bottle groups. |
| Bottle dependencies and one bottle per VFS | Retained as Phase 7 rather than required for the first lazy-shell cutover. |
| Treat the direct composer as sufficient retirement evidence for the historical build-time `brew` pour plus `saveImage()` proof | Unresolved. Phase 5 must run the exact reviewed closure through stock upstream `brew`, save the image, compare ownership, links, receipts, and provenance, and then record an evidence-backed disposition. The current direct composer does not silently retire this proof. |

## Completion Definition

The migration is complete only when all of the following are true:

- public first-party and independent third-party publication is reproducible,
  immutable, anonymously readable, and recoverable;
- the main shell embeds only its audited always-needed closure and lazily reads
  the rest from exact public bottle bytes on both hosts;
- Python, Perl, Erlang, and Ruby work lazily from the main shell;
- upstream `brew` inside Kandelo installs first-party and third-party bottles;
- every historical registry and support role has a durable owner and no
  accepted package has duplicate authoritative recipes;
- every historical and current declared `(Formula, architecture)` pair has
  exact success evidence or an explicit failed, deferred, unavailable,
  blocked, excluded, or intentionally removed disposition, including every
  declared wasm32 and wasm64 target;
- VFS packages can declare bottle dependencies and participate in reviewed
  mix-and-match composition;
- service/application images use that model without demo-specific runtime
  shortcuts;
- documentation, status, upstream-test outcomes, rollback, source/license
  obligations, and deployed-browser evidence match the implementation;
- operator, community, and software-gallery indexes durably expose non-success
  package attempts, last-green choices, complete upstream-test evidence, and
  real browser launch outcomes;
- every retained Homebrew deviation has a named boundary, owner, and exit
  criterion, including a settled owner for the SDK bridge; and
- all remaining limitations are named platform or external boundaries, not
  implied success.
