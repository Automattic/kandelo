# Homebrew Migration Living Execution Plan

- Status: active
- Last reconciled: 2026-07-23
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
- The canonical shell exposes the normal `/usr/bin/brew` entrypoint but keeps
  Homebrew's own runtime/source tree as one integrity-bound first-use group.
  A derived demo may pre-materialize that exact group, but it must consume the
  same descriptor and digest instead of owning a second bootstrap recipe.
  Record separately whether such a derivative embeds only Homebrew's tree or
  its complete runtime dependency closure; those are different size and
  offline-use promises.
- A later documentation slice adds a normal `man` command and retains the man
  pages that each Formula would ordinarily install. Package-owned pages stay in
  the owning bottle and follow that bottle's existing first-use materialization
  boundary; do not create one transport object per page. Keep pages from the
  always-embedded closure in the base initially, and introduce one bounded docs
  sidecar only if an exact compressed before/after measurement shows a material
  startup-size benefit that justifies another ownership and release boundary.
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
| Core Formula coverage | Broad but incomplete | The live core tap currently contains 61 Formula files plus its Formula README, with 60 sidecar package records and 67 successful architecture-specific bottle records at this snapshot. This covers the expanded 42-Formula main-shell candidate, including its four language runtimes, but not every historical registry role; Formula presence alone does not prove publication. |
| Bottle-composed main shell | Phase 3 complete; Phase 4 has an immutable public candidate | PR #1060 landed at `e108a8c4a3259dcf8b646599355590542707adf7` and activated shell revision 17 with the reviewed three-bottle Bash closure and 35 independently deferred bottles. PR #1056 landed the aggregate deferred-tree budget at `1d3521473361524fcdf4febb23d33f20d7c7d515`; its exact post-merge Node.js and Chromium shell checks are green, and the production index selects the lazy image. The Phase 4 candidate extends the same policy to 36 roots and 42 Formulae while retaining only the same three embedded bottles. |
| Language bottles | Public publication complete; immutable revision-18 candidate and exact Node.js/Chromium language acceptance green | Ruby is public and runtime-verified. Coordinated run `29886510272` built, publicly uploaded, anonymously verified, and atomically finalized Python `3.13.3_1` and Erlang `28.2_1` at tap commit `00ba350ffcee7df02fb9f329bb3c62873ae50831`. Perl is published. The exact 5,885,691-byte revision-18 shell candidate and its 39 deferred bottles are bound to immutable release `homebrew-shell-bottles-sha256-b51c071bc0f5eabf230f10d26f8e6c397999323dfbf18cb6da11cec822f8c21b`. Anonymous public Node.js and Chromium acceptance start Python, Perl, Erlang, and Ruby lazily in isolated first-use steps. PR #1062 landed the bounded per-asset browser evidence ledger at `dc5bb1210f1359be17d1d4078a7d56ec14903e4a`; the remaining activation gate is the shared product-VFS headroom fix and its final exact regression run. |
| Third-party tap model | Live publisher proof complete; guest use remains | The stricter load-order-independent cross-tap runtime contract landed in Kandelo as PR #1046 at `bd2b090e3e6998350be24ed018bbb76d3eb5b012`, in the core tap as PR #82 at `caad125218a2e3c6f05d290151a32128ec6c54ac`, and in the canary as PR #13 at `25069ad2acb7f86746ec3d119a823e8210a7a1eb`. PR #1049 landed the active-repository tap-store correction at `466a685d9366d3b712c4fe998307e00157bd5d15`; core-tap PR #83 pinned it at `cbb439454adf2718b010d0fe2caffe7158340a0e`, and canary PR #14 pinned it at `ee4464b87b988b163608b6c3520c2260907bda61`. Independent run `29886510154` is completely green: public M4 package and index, anonymous exact-byte pour, dependency-bearing Node.js and Chromium image proof, transactional tap finalization, and immutable five-asset VFS release `homebrew-vfs-sha256-40a44df5c6f139a4e9105b5155040be757bc20596dc5dce2d7a64286447d9f3e`. Conventional third-party `brew tap` and `brew install` inside the guest remain Phase 5 work. |
| Deferred bottle trees | Generic producer and Phase 3 public proof complete; Phase 4 mirror public and relocation locally validated | PR #1051 landed the generic first-use substrate at `122e62a77ffeb40039bee3f2b29cd5f82ed6b1fe`. PR #1054 landed the exact original-bottle producer at `c16a48c693c8a6dea4ca14e7886b735bf685d51d`: one independently lazy tree per Formula, complete source and guest inventories, exact compressed transport identity, hardlinks, and independent TypeScript/Python validation. PR #1055 composes the exact 38-Formula namespace, PR #1060's exact head proves its immutable public mirror and canonical revision-17 cutover, and PR #1056 landed the aggregate-budget correction. The Phase 4 worktree adds receipt-owned relocation before exposing language runtimes, because exact bottle bytes are transport truth while a correct pour may replace only the placeholders named by that bottle's `INSTALL_RECEIPT.json`; its complete 39-bottle browser mirror is public and immutable. |
| Browser deployment and exact bottle delivery | Complete for the bounded current contract | PR #1064 landed bounded, single-writer Pages publication. PR #1070 landed exact browser bottle-download delivery. Production verification reached GitHub Pages commit `418bd04` through successful Pages run `29994147876`; the app, guide, API, and service worker returned HTTP 200. This evidence closes the observed deployment failure, but does not remove later Phase 4/5 product activation work. |
| Atomic package-generation foundation | Ready for PR and landing on the exact fixture-ownership baseline | The packaging/build worktree makes Rust-generated program policy, scalar mirrors, and multi-member mirror directories publish as validated atomic generations. It aligns Rust, TypeScript, shell, Vite, external registries, and the standalone npm package on one complete highest-priority registry projection, with self-contained lower-root fallbacks. Fixture-ownership PR #802 landed as `427185cff21ed213de8b8b6573b4f1a3757aa80d`; this active foundation is rebased on that exact commit, its `program-packages.json` was regenerated there, and a repository source audit now rejects obsolete flat package paths while preserving inventory-owned and direct-source test fixtures. Independent High/Medium review found no remaining blocker. Exact-baseline validation is green across all 507 xtask tests, all 105 package-system tests, host typechecking, Chromium/Firefox/WebKit Vite boundaries, package-root and sealed/local-generation contracts, resolver-bundle freshness, Pages/CI/merge-workflow contracts, and the 17-case Homebrew shell closure. This foundation does not by itself activate the Phase 4 shell candidate, guest `brew`, registry retirement, or bottle-declared VFS packages. |
| Guest upstream `brew` | Stock tap and bottle-pour proof complete in the opt-in image; product lifecycle incomplete | Draft PR #1059 pins upstream Homebrew, gives its unprivileged guest state the conventional writable layout, and passes exact Node.js/Chromium startup, config, operational doctor, first-party tap, and independent third-party tap discovery. An unmodified stock Bzip2 install pours and runs the public bottle once Homebrew can resolve the exact 19-Formula metadata closure for publisher-only native dependencies. Full `homebrew/core` is infeasible in the guest (about 1.3 GiB, including a 1.22 GiB Git pack); the product fix is a separately reviewed allowlist of custom Homebrew `Requirement` classes, not a partial core tap or unsupported dependency bypass. Main-shell activation, install/reinstall/uninstall, durable reboot state, and cross-tap M4 installation remain. |
| Registry replacement | Incomplete | Formulae are increasingly authoritative, but `packages/registry` still owns recipes, platform artifacts, tests, and composite-image definitions. It cannot be deleted yet. |
| Bottle-declared, mix-and-match VFS packages | Future retained scope | The current composer produces precomposed images. VFS Formulae/bottles and user-selectable composition remain a later product iteration. |

## Execution Order

Work in different repositories may proceed concurrently when immutable inputs
make the results independent. Do not serialize unrelated Formula rollouts, but
do preserve the single-writer finalization and exact-commit trust contracts.

### Accelerated landing tranches

The remaining critical path is grouped into coherent tranches to avoid paying
the serialized `prepare-merge` and immutable-publication cost once per small
prerequisite. This changes landing mechanics, not product scope or acceptance
criteria:

1. Land the atomic package-generation foundation by itself because its exact
   staging and public-bottle proof were already running when batching was
   selected. Do not discard that evidence by expanding its head late.
2. Land one packaging tranche containing the dedicated guest Homebrew program
   package, fail-closed VFS publication integrity, and native Homebrew
   `Requirement` support. Preserve the individual commits and PR references so
   failures and review history remain attributable.
3. After explicit runtime-change approval, land one generic VFS tranche that
   makes lazy and eager package trees consume one verified archive description
   and binds lazy URLs to their intended source. Keep kernel or POSIX changes
   outside this tranche.
4. Rotate the tap's reusable-workflow trust pins to the exact landed
   `Requirement`-support commit, then finalize the native-Requirement Formula
   rollout.
5. Land one product cutover tranche that keeps Bash and its startup closure
   eager, keeps optional bottles and Homebrew itself lazy, exposes the normal
   `/usr/bin/brew` entrypoint, and proves the exact image in Node.js and
   Chromium.

A tranche may be split when a real correctness or review boundary requires it,
but queue convenience alone is not a reason to restore one PR per small step.
Batching must never weaken exact-head validation, immutable
artifact identity, browser/Node parity, POSIX correctness, or an explicit
merge-approval boundary.

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
  browser-readable direct-TAR route. The completed Phase 3 cutover additionally
  proves live anonymous retrieval from the immutable public-release mirror.
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
kernel/process ABI. PR #1054 landed that producer at
`c16a48c693c8a6dea4ca14e7886b735bf685d51d` after its exact-head staging and
synthesized-merge suites passed. Core-tap PR #84 rotated publish, dry-run, and
maintenance callers to that immutable Kandelo commit and landed at
`e7cfe3140e692965cd7abf10e8029633c5d20c02`.

Checkpoint: Phase 2 is complete. PR #1055 supplied the Phase 3 composer and
closed-transport proof. PR #1060 landed the immutable public mirror, anonymous
public-transport acceptance, and canonical revision-17 package cutover at
`e108a8c4a3259dcf8b646599355590542707adf7`.

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

Producer checkpoint: the low-level collection interface runs the complete plan
once, applies global collision ownership, and returns one exact bottle
payload/tree per package plus the complete eager conflict report. It does not
choose or serialize the product partition. PR #1052 fixes that partition at
three embedded packages (`libcxx`, `ncurses`, and `bash`) and 35 deferred
packages. PR #1055 applies the partition after computing ownership across all
38 Formulae, materializes exactly those three globally projected trees, leaves
exactly 35 pending, preserves the full-plan consumer-owned profile and runtime
state, and generates the measured production-shell candidate. Its exact closed
host/VFS binding passes without `page.route` or service-worker interception.
The completed publication gate additionally makes Chromium read the real
anonymous public URLs through the normal browser worker/VFS fetch path.

Pre-publication evidence checkpoint (2026-07-22):

- The composer owns the complete 38-Formula namespace exactly once, embeds the
  three-Formula Bash closure (`libcxx`, `ncurses`, and `bash`), and leaves all
  35 other original bottle payloads independently deferred.
- Two clean builds from the exact tap checkout produced byte-identical reports,
  mirror bundles, and a 512 MiB-capacity shell image. The compressed image is
  5,439,544 bytes with SHA-256
  `9056b9d1874e39ca8dc70b5389c1f88fa14df6b822616ce4fc2f8a01ee34bdc6`.
  The current revision-16 eager shell asset is 31,724,141 compressed bytes in
  public package archive SHA-256
  `10ce3daf0b804fd722e9f7c48189302597351a9072b4903181cbdff0bcb1a788`, so this
  candidate removes 26,284,597 bytes (82.85%) from the initial shell download.
  Its embedded bottle closure accounts for 7,934,040 original compressed
  bottle bytes; the 35 deferred bottles account for 39,552,141.
- The strict composer owns a canonical Unix-epoch timestamp instead of
  inheriting a Nix, CI, or developer `SOURCE_DATE_EPOCH`. A checked-in artifact
  lock binds that timestamp to the exact compressed image digest and byte
  count, so the closed candidate and canonical package wrapper cannot silently
  produce different shell bytes from the same package closure.
- The embedded canonical mirror plan binds every deferred URL, package, tree,
  SHA-256, and byte count. Its immutable release tag is
  `homebrew-shell-bottles-sha256-047ae996f54f4417a11123ddd4d906db08a4ea944fc3002d187bdf4b2340d88b`.
  Recovery reconstructed the exact 35 payloads plus plan as the intended
  36-asset release closure from anonymously readable canonical GHCR inputs.
- Closed Node.js and real Chromium product acceptance both boot embedded Bash
  offline, materialize only Dash, Git, and NetHack through ordinary guest use,
  and leave the other 32 bottles pending. Chromium additionally proves all 35
  exact local payload bindings reach the kernel worker and that no ambient
  GitHub bottle request escapes closed mode. First prompt fetches zero bottles;
  the three representative first uses fetch 156,581, 6,815,615, and 1,982,626
  bytes respectively (8,954,822 bytes total).
- This evidence deliberately preceded activation of the canonical shell
  package. The subsequent activation gate published and anonymously read back
  the exact mirror, repeated the Node.js/Chromium proof against public
  transport, and changed the canonical package revision without a broken URL
  window.

Activation checkpoint (2026-07-22): PR #1060 landed the final cutover as
revision 17 at `e108a8c4a3259dcf8b646599355590542707adf7`. The exact 36-asset
mirror is public and bound to tap commit
`74359eeeaf01908c78fbb4ed398b41ae361ee90d`; exact post-merge Node.js and
Chromium public-transport checks are green, and the production index selects
the lazy image. The synthesized-merge gate also found and fixed a general
`getdents64` boundary bug that could consume a directory record before the
caller had room for it. The landed repair has fork, spawn, `SCM_RIGHTS`,
procfs, devfs, root-mountpoint, Node.js, and Chromium coverage.

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

Implementation checkpoint (2026-07-22; stacked and not yet a supported
canonical release):

- The reviewed shell selection now contains 36 direct roots and 42 Formulae.
  `libcxx`, `ncurses`, and Bash remain the only three physically embedded
  bottles; all 39 other exact original bottles remain independently deferred.
- The eager composer and first-use decoder now share Homebrew's receipt-owned
  text-relocation contract. They verify the original compressed bottle first,
  accept only bounded canonical paths from `INSTALL_RECEIPT.json`
  `changed_files`, replace the standard Homebrew placeholders only in those
  files, preserve hardlink inode identity, and reject a descriptor whose
  relocation markers differ from its bottle receipt. The immutable content
  digest and byte count continue to identify the unmodified `.tar.gz` bottle.
- Against exact tap commit
  `e7cfe3140e692965cd7abf10e8029633c5d20c02`, the materialized local candidate
  is 5,885,691 compressed bytes with SHA-256
  `7a08d342b4e1d00976623d18da74a2d1a923f4eafe88c93253e2947ec0a49cce`.
  Its exact 39 deferred bottles plus mirror plan were anonymously recovered
  from canonical GHCR packages and published as the 40-asset immutable release
  `homebrew-shell-bottles-sha256-b51c071bc0f5eabf230f10d26f8e6c397999323dfbf18cb6da11cec822f8c21b`.
  Exact public Node.js acceptance boots a fresh embedded Bash shell offline,
  then starts Python, Perl, Erlang, and Ruby in isolated first-use steps.
  Across the language matrix, seven distinct bottles totaling 49,704,666 bytes
  are fetched; each step fetches no unrelated language and the full run leaves
  the remaining optional bottle trees pending.
- Exact public Chromium reached the same shell and language runtime behavior,
  then revealed that the browser Inspector reconstructed its audit table from
  a 512-event raw progress ring. Large bottle streams could evict every event
  for an earlier completed bottle even though the materialized filesystem
  remained correct. PR #1062 landed the separately bounded per-asset
  authoritative summary ledger, lifecycle reset semantics, UI consumption,
  and full API tests at
  `dc5bb1210f1359be17d1d4078a7d56ec14903e4a`; the raw ring remains bounded for
  recent diagnostics without being treated as durable completion evidence.
- The exact revision-18 shell test is green in Node.js and Chromium, while the
  broader browser suite exposed a separate shared-image capacity defect in a
  shell-derived WordPress image. The image retained about 250 MiB of free data
  blocks but used all 32,768 inode slots after inheriting the expanded lazy
  namespace, so normal boot-time configuration failed with `ENOSPC`. The fix
  is an explicit reusable data-and-inode headroom contract for every product
  VFS, with package revision and browser regression evidence, not a
  WordPress-only exception.
- The initial proof used the exact locally built directory fix from draft PR
  #1058. PR #1060 superseded that draft, landed the general `getdents64` fix,
  activated canonical revision 17, and completed the Phase 3 package cutover.
  There is no remaining kernel prerequisite for revision 18. Canonical PR
  #1056 and the browser ledger in PR #1062 have now landed. The stacked exact
  shell/language test is green in Node.js and Chromium. Canonical activation
  now waits only for the shared product-VFS headroom fix, its derived-product
  regression, and the final exact restack against landed prerequisites.

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
4. Make the upstream `brew` command available from the main shell. The
   canonical/base shell registers Homebrew's tree as a package-level lazy
   reference behind the ordinary `/usr/bin/brew` entrypoint, with no bootstrap
   download during boot. The first invocation materializes and verifies that
   coherent tree; repeat invocations do not fetch it again. A derived demo may
   pre-materialize the same exact tree through a generic composer policy.
   Invoking `brew` must not depend on host-side Formula emulation.
5. Prove a first-party core bottle install and a cross-tap M4 install, including
   dependency resolution, linking, execution, upgrade/uninstall state, and loud
   failures for ABI or digest mismatch.
6. Preserve and run the historical build-time pour proof before deciding its
   disposition: boot Kandelo, have stock upstream `brew` install the exact
   reviewed shell closure, call `saveImage()`, and compare package ownership,
   links, Homebrew receipts, and provenance with the direct composer. Record an
   evidence-backed keep, replace, or retire decision; the existence of the
   current direct composer is not that evidence by itself.
7. After the existing in-guest Clang/LLVM proof is audited and integrated,
   exercise Homebrew's normal source-build path inside Kandelo. Source builds
   must use the guest SDK/toolchain and ordinary Formula contract rather than a
   host-built artifact substitution; bottle-only support is an intermediate
   milestone, not the final package-manager boundary.

Implementation checkpoint (2026-07-22; draft PR #1059 and not yet a supported
main-shell capability):

- Stock upstream Homebrew at exact commit
  `4ead8619231cb15cbe15e8e8188081e347d6f7cd` runs as the unprivileged
  `linuxbrew` user through its conventional writable repository, Cellar, tap,
  cache, configuration, lock, and temporary-state paths. Exact Node.js and
  Chromium runs use the same 805,315,495-byte bootstrap image with SHA-256
  `46033f3579781ac0891a9792d4bc32e47bac37cc80a4f47112eb6824412ebc49`.
- A strengthened main-shell probe found that the previous Bash bottle was
  built without programmable-completion builtins. Upstream `brew --version`
  therefore emitted `compgen: not a shell builtin` even though the script
  later exited zero. Core-tap PR #85 landed the general Bash build and exact
  builtin-test correction at
  `9cb60ec8181afb0c04a14440b5a66b03e81b48e6`. Production run `29963546302`
  published and anonymously re-read Bash `5.2.37_2` rebuild 3; finalizer
  `fccc3970db092dd1a173b8d0859e620d1d3e2e2a` binds the 1,783,637-byte public
  bottle with SHA-256
  `bef5fef66621e5692db4268997f7ab5ad30bf6c9f18ea578453843a142c4a87b`.
  Built-in `brew` remains unclaimed until the lazy bootstrap and its exact
  Node.js/Chromium proof advance together.
- An exact working revision-19 comparison measured the embedded design before
  selecting the lazy policy: revision 18 is 5,885,691 compressed bytes;
  corrected Bash alone produces 5,904,540 bytes; and embedding Homebrew's tree
  produces 8,770,196 bytes. The bootstrap therefore accounts for about
  2,865,656 compressed bytes in that comparison, plus 3,549 paths and about
  26.8 MB of allocated VFS blocks. The final lazy image still needs integrity,
  inventory, and trigger metadata, so its exact savings must be measured from
  the built lazy artifact rather than inferred by subtracting these images.
- Stock `brew config`, the bottles-only operational doctor checks, public
  first-party tap discovery, and independent canary-tap discovery pass without
  an implicit core clone. Full doctor retains the truthful warning that the
  image does not contain a source-build developer toolchain.
- Homebrew resolves Formula metadata before pruning build-only Formula
  dependencies from a bottle install. With the exact recursive 19-Formula
  Linux metadata closure present (85,664 uncompressed bytes; 38,910 ZIP bytes),
  unmodified `brew install --no-ask --force-bottle
  kandelo-dev/tap-core/bzip2` downloads, pours, links, and executes the public
  bottle. Its receipt records `poured_from_bottle: true` and zero runtime
  dependencies. The partial metadata tree is diagnostic evidence, not a
  product artifact.
- A real `homebrew/core` checkout is not viable: it measures about 1.3 GiB,
  including a 1.22 GiB Git pack with 3,612,638 objects, and a bounded guest
  clone remained incomplete after eight minutes while reaching about 20 GiB
  host RSS. The general next change represents publisher-only native tools as
  statically allowlisted custom Homebrew `Requirement` classes, binds every
  class to an exact native Formula and protected executable, and preserves the
  existing sealed build/test plan and provenance. Unsupported dependency-skip
  flags, a synthetic core API, and a curated partial core tap remain rejected.

Acceptance:

- Stock upstream Homebrew, with only the documented Kandelo target/platform
  boundary, installs and runs public bottles inside Kandelo on Node.js and
  Chromium.
- User documentation can finally publish truthful `brew tap` and
  `brew install` instructions.
- The canonical shell boots without fetching Homebrew's tree, first
  `/usr/bin/brew` use fetches exactly the declared bootstrap group(s), and a
  derived pre-materialized variant proves identical guest behavior and source
  identity without a second recipe.
- With the guest Clang/LLVM capability integrated, at least one representative
  Formula builds from source entirely inside Kandelo and records truthful build
  provenance; unsupported toolchain features fail as real platform boundaries.
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
9. Replace the narrow `man` applet currently bundled into
   `posix-utils-lite` with a normal, separately owned `man` Formula/package and
   require every applicable Formula to retain and link its ordinary manual
   pages. The current applet only probes `/usr/share/man/man[1-9]` and copies
   source roff bytes directly, so it is not the user-facing contract to
   preserve. The replacement must search the Homebrew prefix, select sections,
   format pages, and use the ordinary pager path. Keep pages in their owning
   bottle so `man <topic>` triggers at most the same package-level first-use
   fetch as the corresponding program. Do not fragment pages into per-file
   downloads. The revision-18 candidate already contains 349 deferred manual
   files (5,414,179 uncompressed bytes across 20 bottle groups) and 138 manual
   files from the embedded closure (1,534,914 uncompressed bytes); measure the
   exact compressed base-image delta before considering one docs sidecar for
   the embedded set.

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
- Node.js and Chromium can run `man` for an embedded package and for a fresh
  deferred package. The deferred case fetches only the owning bottle, page
  links and `MANPATH` resolve through normal Homebrew layout, and the package
  inventory rejects an applicable Formula that silently drops its pages.

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
| Build the current main shell from bottles | PR #1025 completed the eager bottle composition. PR #1060 subsequently completed Phase 3 by activating revision 17 with Bash, `libcxx`, and `ncurses` embedded and the other 35 bottles independently deferred. |
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
- a normal `man` command resolves the ordinary manual pages shipped by
  applicable embedded and deferred packages;
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
