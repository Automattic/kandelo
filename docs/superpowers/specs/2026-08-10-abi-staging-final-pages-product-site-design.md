# Final Admitted-Product Pages Site

**Status:** Approved Plan 5 Tasks 8–9 hardening design

**Scope:** Automattic/kandelo and kandelo-dev/homebrew-tap-core

**Deployment boundary:** This design prepares and tests an inert Pages canary.
It does not activate promotion, deploy production Pages, delete artifacts, or
remove legacy infrastructure.

## Purpose

The current Plan 5 canary recomposes and tests seven canonical VFS products,
then copies them beside a browser bundle that was already built from legacy
`local-binaries` or `binaries` VFS assets. The artifact can therefore be
complete according to its manifest while the normal browser UI executes
different bytes.

The final site must instead be built from the admitted product identities. A
ready canary means all three statements are true for one exact Kandelo main
revision:

1. every Pages product was recomposed from current inputs and admitted
   Homebrew layers and passed its declared Node and browser evidence;
2. current tap main still contains the exact admitted Formula metadata
   projection; and
3. the assembled browser actually requests the seven manifest-owned VFS paths,
   with no legacy or candidate fallback.

## Decision

Use one producer invocation with two internal phases. Do not add a runtime
`.well-known` manifest resolver as a second browser authority, and do not rerun
OCI discovery, product composition, or evidence after the site build.

A runtime resolver would spread asynchronous manifest parsing and failure
behavior across the default rootfs, the shell image, optional gallery images,
the network demo, and BrowserKernel default artifacts. It would also leave
legacy imports easy to bundle accidentally. Building the final site only after
the product identities exist gives Vite one closed mapping and makes duplicate
VFS assets mechanically rejectable.

## Authority And Invariants

- Kandelo current main owns product manifests, source and generated registries,
  evidence definitions, browser source, the site builder, and the producer.
- Immutable admission records authenticate canonical bottle layers, but an
  historical record is usable only while its Formula metadata projection is
  still present on current tap main.
- Candidate VFS bytes are never fetched or relabeled. Candidate records supply
  provenance and input identity only.
- Product composition and Node/browser evidence run once. The final browser
  build consumes only their sealed identities and private output paths.
- The final source tree contains exactly seven product VFS files, all at the
  paths in `PagesSiteManifestV1`. It contains no VFS under Vite `assets/`,
  legacy binary mirror paths, a candidate namespace, or another ABI.
- `platform-rootfs` and `browser-main-shell` are eager. The other five products
  are lazy. Placement changes are evidence-relevant failures.
- Promotion and Pages activation remain checked-in disabled or legacy at this
  partial-landing boundary. Cleanup remains observe-only.

## Phase A: Authenticate And Build Products

The producer starts from the existing bounded production handoff and performs
the current Task 8 work:

1. reobserve the clean exact Kandelo source, runtime, ABI, and registries;
2. anonymously authenticate candidate records and immutable admissions;
3. recapture non-Homebrew inputs from current main;
4. anonymously read canonical Homebrew layers;
5. recompose and build the seven products in dependency order; and
6. run every registered Node and browser evidence definition.

Admission discovery also receives a clean anonymous checkout of current tap
main. For each selected record, protected tap code must:

- prove the admission's metadata source is an ancestor of current main;
- validate the exact Formula, sidecar, top-index row, and link-manifest
  projection against current main; and
- return a canonical projection observation bound to the tap commit and tree.

Kandelo does not reimplement tap Formula parsing. It invokes the protected tap
validator and binds the resulting tap source and projection digests into Pages
readiness.

Successful Phase A produces an in-process sealed product set. Each entry has
only:

- product ID and eager/lazy mode;
- canonical site path;
- SHA-256 and byte count;
- private artifact path; and
- the already-validated receipt and admission identity needed by readiness.

The private map is not a public deployment record and cannot be supplied by a
workflow caller. If a process boundary becomes unavoidable, it must become a
canonical `PagesProductSetV1` bound to run ID and attempt, source tree, ABI,
registry digest, receipts, admissions, and every artifact, and must be fully
revalidated before Phase B.

## Phase B: Build The Final Site

A fixed current-main site-builder consumes the sealed product set. It builds
the browser, documentation, and API output in a fresh private directory and
then inventories the result.

Canonical Vite mode uses a closed product-map plugin:

- `@rootfs-vfs` resolves only to `platform-rootfs`;
- the shell import resolves only to `browser-main-shell`;
- Node, nginx, nginx/PHP, WordPress/SQLite, and WordPress/MariaDB imports
  resolve only to their mapped products;
- authored relative imports and `import.meta.glob` matches naming one of these
  VFS artifacts resolve to the same canonical mapping;
- an unmapped VFS import, absent map entry, duplicate mapping, wrong load mode,
  candidate URL, or fallback to `local-binaries` or `binaries` is fatal; and
- URL modules export the canonical product path instead of causing Vite to
  copy another asset.

The builder writes each VFS exactly once at its content-addressed product path.
It emits a small generated browser product map containing ID, path, digest,
bytes, and placement. The normal Kandelo loader uses this map as its sole Pages
product authority. Product fetches are memoized, require exact byte count and
SHA-256 before boot, and never fall back:

- eager products begin fetching before product activation; and
- lazy products make no VFS request until their gallery profile is selected.

After the build, the producer rehashes every product and site file, constructs
`PagesReadinessRecordV1`, `PagesSiteManifestV1`, and the hidden deployment
manifest, reobserves Kandelo current main, and atomically renames the complete
output.

## Registry Freshness

The workflow runs the authoritative `xtask abi-staging registries check` before
materialization. The producer independently compares the source Pages and test
registries with their generated JSON projections. A source-only or
generated-only mutation is a hard failure, not a hold.

The generated browser product map must have exactly the same product IDs and
load modes as the checked Pages registry and exactly the reviewed gallery
mapping. Callers cannot add gallery or deployment entries.

## Hold Behavior

Expected incompleteness, including a missing candidate, admission, or current
input, produces an atomic directory containing exactly `readiness.json`.

The canary validates readiness before looking for a site manifest:

- a hold is retained as an ordinary bounded workflow artifact and summarized
  with its exact digest and blocker set;
- a hold never invokes `upload-pages-artifact` and never validates or uploads a
  nonexistent site tree; and
- a ready result validates the site manifest and inventory before uploading
  one inert Pages artifact.

Malformed identity, source drift, projection drift, registry drift, or
unexpected output remains a hard failure.

## Browser Proof

The decisive integration test serves the exact assembled `source-tree` under
the production base path with its service worker and cross-origin isolation
headers. It does not build a separate fixture site.

In fresh Chromium contexts the test must:

1. parse the hidden deployment manifest as the expected seven-product ledger;
2. observe the two eager canonical VFS URLs exactly once before gallery
   activation;
3. observe no lazy VFS request before activation;
4. activate one representative preset for each of the five lazy products and
   require only its canonical URL and a basic successful boot;
5. hash every VFS response and compare its byte count and SHA-256 with the
   deployment manifest; and
6. fail on any other VFS request, including Vite assets, legacy mirrors,
   candidate namespaces, prior-ABI paths, or external origins.

Negative tests cover corrupt bytes, wrong length, missing or extra product,
wrong load mode, duplicate platform rootfs, and any fallback path. Existing
per-product Node and Chromium evidence remains required; this additional test
proves the final-site integration contract.

## Landing And ABI-Test Snapshot

The earliest truthful snapshot for testing a new ABI pull request is reached
when:

- Plans 1–4 and Plan 5 Tasks 1–5 are landed with promotion disabled;
- Task 6 is explicitly deferred rather than exposed as a functioning repair
  lane;
- Task 7 cleanup is observe-only and its analysis engine preserves custody;
- this Tasks 8–9 hardening passes local, cross-repository, and assembled-site
  Chromium tests; and
- both repository pull requests pass CI.

Before real successor admissions exist, the hosted canary is expected to
produce a truthful hold. That hold is sufficient to stage inactive Task 10
code, but not to activate or deploy it. After successor promotion and
admissions, the canary must be rerun and produce `ready = true` before any
activation or production Pages change.
