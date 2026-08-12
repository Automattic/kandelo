# Generic ABI Bottle Staging and Promotion

**Status:** Approved design; not yet implemented

**Scope:** Automattic/kandelo and kandelo-dev/homebrew-tap-core

**Applies to:** A generic ABI N to ABI N+1 transition

**First acceptance fixture:** integration/abi43-batch-linear-20260801

This document specifies the intended replacement for Kandelo's current
post-merge-only Homebrew bottle workflow. It describes future behavior. Until
the implementation and acceptance work described here has landed, the existing
reference documentation and workflows remain authoritative for supported
behavior.

The design deliberately uses N and N+1. The named successor-ABI branch is the
first planned acceptance fixture, not a number or branch name that workflow
code may hardcode.

## Purpose

An ABI-changing Kandelo pull request needs to be testable with the software
that Kandelo actually ships before it merges. At the same time, requiring
every Formula in the first-party tap to finish before merge would make kernel
development depend on unrelated package failures.

The system therefore has two different completion models:

1. **Required product readiness is a merge gate.** Every bottle needed by a
   Kandelo-shipped, merge-gating VFS image must exist, the VFS must build, and
   its declared Node and browser evidence must pass for the exact pull-request
   head.
2. **The remaining first-party bottle set is eventually consistent.** Builds,
   verification, and promotion continue independently after merge. A failed
   Formula blocks only its dependants and products, not unrelated Formulae.

The same product-readiness model applies to applicable kernel and host changes
within an ABI epoch. Those changes may reuse unchanged bottles, but they must
still rebuild and test affected shipped VFS products with the exact candidate
kernel and host runtime.

The design favors producing useful artifacts and actionable diagnostics over
running work that cannot yet be interpreted safely. Incomplete build-input
capture is an immediate ordinary staging failure in the MVP, not a job that
waits indefinitely or silently reuses an old bottle. Selected policy guards
may be overridden by a maintainer for one exact request and subject when urgent
circumstances justify the risk. Any resulting candidate and admission remain
visibly classified as accepted with override. Identity and integrity
contradictions are never overrideable.

## Goals

- Stage bottles from an exact Kandelo pull-request head before merge.
- Derive merge-gating bottle requirements from authoritative VFS product
  manifests and consumer-owned test/deployment registries rather than a
  hand-maintained Formula list.
- Keep candidate execution uncredentialed while still publishing public,
  content-addressed candidates through protected code.
- Reuse an unchanged bottle without rebuilding when all output-affecting build
  inputs are completely captured and identical.
- Preserve the exact source used by an actual build alongside its candidate.
- Keep candidate identity, verification, and final admission as separate
  facts.
- Promote successful Formulae independently after the exact pull request
  merges.
- Preserve historical ABI bottles and Formula metadata without requiring
  consumers to suffix Formula names with an ABI.
- Keep Pages deployments atomic in the MVP: publish a complete new site or
  retain the last complete site, without treating that rollout policy as a
  permanent restriction on future per-image kernel/VFS publication.
- Provide useful local and unit testing for the staging components so hosted
  GitHub runs are final integration evidence, not the primary debugging loop.
- Mark replaced Homebrew staging infrastructure for later removal, without
  putting a broad legacy refactor on the critical path.

## Non-goals

- A complete semantic ABI classifier. The structural ABI checker is automated;
  deeper semantic modeling is explicitly deferred.
- A global all-or-nothing tap campaign or a single canonical tap-wide
  selection.
- Blocking a Kandelo merge on every Formula in the first-party tap.
- Running pull-request-controlled code with registry, repository, Check,
  Release, Pages, or identity-token write permission.
- Treating a candidate build as endorsed merely because Kandelo automation
  built or published it.
- Adding ABI suffixes to Formula names or to VFS dependency declarations.
- A GitHub App in the first MVP. Public polling and manual reconciliation are
  sufficient initially.
- First-party orchestration of arbitrary third-party taps that Kandelo does
  not declare as dependencies.
- Restoring the full stock in-guest Homebrew tap/install lifecycle as a release
  gate before the successor-ABI vfork work has been measured.
- Man pages, broad Homebrew performance work, or Rust semantic ABI modeling.

## Terms

**Request**
: A canonical, immutable JSON asset issued by trusted Kandelo automation for
  one exact pull-request head and target ABI.

**Bottle contract**
: The normalized set of output-affecting inputs that determines whether a
  previously built bottle may be reused without rebuilding.

**Candidate**
: A structurally valid bottle produced for a staging request and published in
  a visibly nonendorsed namespace. A candidate exists before and independently
  of verification.

**Attempt**
: The immutable result of one build operation. A failed attempt can have
  diagnostics without having a candidate.

**Verification receipt**
: An immutable record of a test performed against one exact candidate.

**Admission**
: The immutable record that one exact candidate was accepted for canonical
  publication after its pull request merged. Admission does not rewrite where
  or how the candidate was built.

**Required product**
: A checked-in VFS product selected by a merge-gating test or consumer-owned
  shipped-product registry whose declared evidence is required for the current
  pull request to merge.

**Background set**
: First-party tap Formulae not needed by the required products for this pull
  request. Their builds continue independently and do not gate the merge.

**Tap main**
: The main branch of kandelo-dev/homebrew-tap-core. It represents current-ABI
  Formula metadata.

**Kandelo main**
: The main branch of Automattic/kandelo. It owns the kernel, host runtime,
  product requirements, request issuance, and merge policy.

## Core Semantics

Several distinctions are intentional and must remain understandable in both
documentation and nearby implementation comments.

### Provenance is not content identity

The exact pull-request head, request digest, run, job, and producer source are
recorded as provenance. They do not change a bottle's reuse identity merely
because another commit or workflow run exists. A candidate changes identity
when an output-affecting build input, dependency materialization, target ABI,
architecture, or exact bottle byte stream changes.

This means a later pull-request head may reuse an earlier candidate when its
complete bottle contract is identical. It also means the system does not claim
that a bottle was rebuilt merely because a new commit was pushed.

Because a candidate OCI record includes factual producer provenance, its
candidate_record_digest would differ if the same bytes were genuinely rebuilt
by another producer. That does not change the bottle_contract_digest or
bottle_layer_digest. Normal reuse points the new request at the existing
candidate and adds a reuse/reference record rather than manufacturing a new
producer history.

### Identity precedes verification

The successful builder seals bottle bytes and their candidate identity first.
Verification then acts on those exact bytes. Retesting creates another receipt;
it never renames or mutates the candidate. Failed and successful verification
receipts can coexist truthfully.

### Candidate does not mean endorsed

A public candidate is useful for inspection, reuse, and third-party
experimentation. Its namespace, OCI annotations, and status records must state
that it is an unmerged, noncanonical staging artifact. Formula metadata,
default product images, and canonical channels never select it until an
admission permits promotion.

### Promotion is admission, not rewritten history

Promotion publishes the same bottle layer in the canonical ABI-qualified
namespace and records the protected state that admitted it. The candidate's
original producer remains its producer. The merge commit is admission
provenance, not a retroactive build source.

### Independent Formula progress is not a partial product claim

Formulae build and promote independently. A consolidated report shows all
results but is not an all-or-nothing tap gate. In contrast, one shipped VFS
product is ready only when all of its actual dependencies and declared evidence
are ready, and a Pages site is deployed only when every product included in
that deployment is ready.

## System Overview

~~~mermaid
flowchart LR
  PR[Exact Kandelo PR head] --> ISSUE[Protected request issuer]
  ISSUE --> REL[Public PR prerelease request asset]
  REL --> REC[Tap reconciler]
  REC --> PLAN[Tap snapshot and dependency plan]
  PLAN --> BUILD[Uncredentialed bottle builds]
  BUILD --> PUB[Protected candidate and source publisher]
  PUB --> VERIFY[Independent candidate verification]
  VERIFY --> VFS[Required VFS composition and E2E]
  VFS --> CHECK[Kandelo exact-head Check]
  CHECK --> MERGE[PR merge]
  MERGE --> REC
  REC --> PROMOTE[Independent canonical promotion]
  PROMOTE --> TAP[Tap main and protected abi/N history]
  PROMOTE --> PAGES[Atomic Pages product build]
~~~

The public request and public content-addressed records are the cross-repository
protocol. Kandelo and the tap do not share a broad token. Each repository reads
the other's public facts and uses only its own repository-scoped credentials
for protected writes.

## Repository Responsibilities

### Automattic/kandelo

Kandelo owns:

- ABI version and structural snapshot validation;
- test and shipped-product VFS requirements;
- exact-head request generation and issuance;
- trusted request and evidence schemas;
- the bounded first-party guard registry;
- the required exact-head Check;
- kernel, host, VFS, Node, and browser test implementations;
- the policy current at merge; and
- Kandelo Pages deployment.

Protected Kandelo code may read candidate and verification records from the
tap. It does not receive the tap's package or contents-write token.

### kandelo-dev/homebrew-tap-core

The tap owns:

- Formula source and dependency resolution;
- the exact tap snapshot used for each plan;
- uncredentialed bottle execution;
- protected candidate, source-custody, and canonical OCI publication;
- candidate verification receipts;
- reconciliation of request and pull-request lifecycle;
- current-ABI Formula bottle metadata on tap main;
- protected historical abi/N branches; and
- the eventually consistent background Formula set.

The tap does not decide whether later commits on Kandelo main invalidate an
already merged request. A later relevant Kandelo change follows its own request
and merge lifecycle.

### Third-party taps

A VFS product manifest addresses each software dependency at the tap that owns
it. The first-party MVP recognizes kandelo-dev/homebrew-tap-core directly
rather than introducing a mapping registry.

The public request format is intentionally readable by other tap owners. A
third-party tap not addressed by Kandelo may poll these events and invoke its
own caller-owned workflow under its own permissions. A generic reusable
third-party adapter is a later extension; the first-party lane is the priority.

## Canonical VFS Products and Consumer Registries

TOML is the human-authored format. JSON remains the generated canonical
interchange format because deterministic encoding and hashing matter there.

The legacy package.toml/build.toml package registry is being retired as VFS
product authority. The staging MVP therefore introduces the long-lived VFS
product manifest now rather than first adding a staging-only requirements
overlay that would soon be replaced. Existing package and image builders may
serve as transitional implementation adapters, but they are not independent
sources of software dependencies or product identity.

Each VFS product has one version-1 product manifest near the code that owns it.
Its normative shape begins as:

~~~toml
schema = 1
id = "browser-main-shell"
architecture = "wasm32"
output = "main-shell.vfs.zst"

# Transitional implementation hook. It consumes this manifest's resolved
# inputs and may not introduce an undeclared software source.
builder = "images/vfs/scripts/build-main-shell-vfs-image.sh"

[[software.homebrew]]
tap = "kandelo-dev/homebrew-tap-core"
formulae = ["bash"]
materialization = "embedded"

[[software.homebrew]]
tap = "kandelo-dev/homebrew-tap-core"
formulae = ["ruby"]
materialization = "lazy"

[[mounts]]
path = "/"
source = "built-image"

[boot]
argv = ["/opt/kandelo/homebrew/bin/bash", "-l", "-i"]

[evidence.node]
test = "main-shell-startup"

[evidence.browser]
test = "main-shell-basic-e2e"
~~~

The product manifest owns the stable product identity, architecture, output,
composition inputs, software sources and Formula roots, materialization
policy, filesystem/mount intent, boot contract, and basic product evidence.
Formula roots are ordinary names; the tap derives ABI-qualified candidate or
canonical locations and transitive dependencies. Version 1 contains no ABI
number, resolved dependency list, candidate URL, build matrix, command text,
runner, credential, retry, timeout, or workflow policy.

A transitional builder hook may perform filesystem transformations that are
not yet expressed by a generic compositor. It receives the exact normalized
manifest and resolved inputs. Its report must prove that every Homebrew bottle,
layer, and other software source in the resulting image came from that
manifest. Introducing an undeclared source, Formula root, or materialization
mode is a hard failure. As generic composition improves, builder-specific code
can shrink or disappear without replacing the manifest or staging protocol.

Product ownership does not grant deployment placement. In particular, a VFS
manifest has no Pages inclusion flag. The browser application owns a small,
inert Pages product registry adjacent to its existing VFS source/import
registry. That registry references VFS product IDs and is consumed or
validated by both the browser build and the protected staging planner. It is
the authority for which VFS products belong to a Pages deployment. A product
cannot publish itself by changing its own manifest.

Merge-gating test registrations likewise reference product IDs and stable
Node/browser evidence IDs rather than repeating Formula roots. Applicability
has one explicit required, informational, or not-applicable value for ABI,
kernel, and host changes. Every Pages product is required for applicable ABI,
kernel, and host changes; test-owned products may select a narrower scope.
Change-scope follows selected tests and consumers to product manifests, then
derives the bottle requirements from the product's declared software sources.

Lazy behavior remains a product contract. A product may reference a complete
VFS image lazily, and its image may retain content-addressed bottle or package
layers that materialize only on exec/open. Requiring those bottles before
merge proves that the references are available and testable; it does not force
their bytes to be embedded eagerly. Build reports and basic E2Es verify the
declared materialization policy.

Candidate and canonical OCI repositories are deliberately distinct so an
unmerged object cannot look endorsed. A pre-merge VFS therefore contains lazy
candidate references. After admission, the final product is recomposed around
the unchanged promoted bottle layers using canonical references and reruns its
required product evidence. The product semantics and bottle bytes remain
unchanged, but the VFS bytes may differ because repository locators changed.
The MVP does not claim exact candidate-VFS byte reuse. A future neutral
content-addressed locator or resolver indirection may remove that recomposition
without weakening candidate labeling.

All product, test, and Pages registries are inert data. Protected Kandelo code
parses and validates them without sourcing or executing pull-request-controlled
workflow or application code.

## Automated ABI Classification

### Structural enforcement

The existing ABI snapshot remains the automated authority for its covered
surface. Ordinary pull-request CI and protected merge preparation must both
run the structural ABI check.

An incompatible structural change without an ABI_VERSION bump and regenerated
abi/snapshot.json is a hard failure. A pull request that already bumped from N
to N+1 may continue adding structural ABI work before merge, but every new head
creates a new snapshot identity and request. Candidate bottles whose bottle
contract includes the previous structural snapshot become ineligible for reuse
and rebuild automatically.

No developer declaration such as “implementation-only ABI change” is accepted
as classification authority.

### Explicit semantic limitation

The structural snapshot cannot yet prove that an existing syscall retained the
same argument meaning, errno behavior, blocking and restart behavior, memory
effects, fd/OFD effects, process effects, signal effects, or inheritance
rules. It also cannot prove that every ABI-affecting host assumption is already
represented in Rust-owned metadata.

The MVP must say this clearly in CI diagnostics and documentation. Relevant
conformance tests, exact-head VFS tests, and broad path selection reduce the
risk, but they are supporting evidence rather than a complete semantic
classifier.

Moving more kernel and host implementation into Rust should make a later
machine-readable semantic model easier because ABI-owned state transitions can
be expressed through shared typed primitives. Rust alone does not make the
proof automatic. The future project is to define a canonical semantic model,
generate structural and protocol views from it, restrict implementation
effects to modeled primitives, compare normalized transition models, and prove
or model-check implementation refinement.

Until that project exists, the system must never claim that an unchanged
structural snapshot proves unchanged semantics.

## Exact-head Request Issuance

### Same-repository pull requests

For a same-repository pull request, protected Kandelo automation issues a
request automatically for each applicable exact head. It checks out the head
as untrusted source or data, validates generated results with protected code,
and never executes candidate-controlled code in the write-capable request
writer.

Adding commits creates another immutable request asset. A protected policy,
consumer registry, or product-manifest rule change on Kandelo main may also
issue a new request for the same head under the newer policy. Earlier requests
remain valid historical requests and may continue to finish. The required
Check always binds the current exact head and the current protected policy and
requirements digests. Fingerprint-identical candidates from earlier heads or
policy revisions may be reused.

The staging source is the pull-request head itself, not a synthetic merge with
main. Informational base facts may be recorded, but they cannot alter the
checkout or build identity. Normal branch protection still decides whether the
pull request can merge with current main.

This separation is intentional. A synthetic merge would make staging depend
on an unrelated moving main branch, prevent useful exact-head evidence for a
temporarily conflicting pull request, and obscure which source the maintainer
or author actually requested. Current-main mergeability and current protected
requirements are still checked before merge; they are not folded into the
bottle producer identity. The rationale must appear beside the request planner
and its exact-head tests so a future cleanup does not reintroduce synthetic
source authority accidentally.

### Fork pull requests

Fork pull requests do not trigger expensive staging automatically. The intended
authorization is a top-level maintainer comment:

~~~text
/run-abi-staging <full-lowercase-40-character-head-sha>
~~~

Protected base-owned code verifies the commenter has the required repository
role, the SHA was the pull request's head when commanded, and the command body
is exactly one unquoted line. Leading whitespace, Markdown blockquotes,
quoted strings, fenced or inline code, list items, HTML wrappers, edited
near-matches, abbreviated SHAs, uppercase SHAs, and extra text are rejected.
In particular, neither of these takes effect:

~~~text
"/run-abi-staging ..."
> /run-abi-staging ...
~~~

The SHA-bearing command removes the label race: the authorization names the
only source that may be built. If the fork advances afterward, the issued
request remains buildable for the commanded SHA, while the new head needs a new
command.

Positive and negative parser tests run in ordinary CI whenever parser or
workflow files change, and protected workflow mutation tests ensure the base
definition—not the pull request's definition—remains authoritative.

Fork issuance may be deferred from the first deployable MVP. If it is deferred,
forks remain staging-disabled; no weaker label or automatic fallback is added.

## Canonical Request Format

Each generated request is canonical compact JSON with exactly seven logical
sections:

1. schema and kind;
2. pull_request;
3. authoritative build_source;
4. authoritative target_abi;
5. normalized requirements;
6. Kandelo-owned issuance; and
7. explicitly non-authoritative informational_context.

The authoritative build source contains the exact repository, commit, and tree.
The target ABI contains the derived ABI number and structural snapshot
identity. Requirements contain selected product/test/consumer roots and
evidence requirements, plus every product and registry path and digest.
Issuance binds the trusted issuer, policy and guard-registry version, and
same-repository or exact-SHA fork authorization mode.

Base commit, base tree, previous ABI observations, and a branch/ref hint belong
only in informational_context. Validators reject any attempt to use those
fields for checkout, reuse, applicability, or promotion.

The request deliberately excludes:

- a tap revision;
- resolved transitive Formula dependencies;
- the background Formula inventory;
- a build graph or matrix;
- runner, retry, timeout, or concurrency policy;
- candidate, verification, promotion, or cleanup state;
- source-custody objects; and
- mutable status.

Those facts are derived or created by the repository that owns them.

## Public Request Feed

Kandelo maintains one public GitHub prerelease per ABI-staging pull request.
Its tag is abi-staging-pr-<pull-request-number>. The prerelease contains request
assets only. Each issued head-and-policy request appends one asset:

~~~text
candidate-request-<full-head>-sha256-<digest>.json
~~~

The protected writer enforces append-only project policy and refuses a
different byte stream at an existing name. The full source head in the asset
name is a human- and machine-readable discovery index, not the trust authority.
Validation requires the filename head to equal build_source.commit and the
filename digest to equal the canonical request bytes.

More than one request digest may name the same source head when current policy
legitimately changed. There is no timestamp, upload-order, commit-hash ordering,
or mutable “latest” pointer. For the current pull-request Check, Kandelo reads
GitHub's exact current head SHA, filters assets by that full SHA, validates
their bytes, and selects the request whose policy and requirements digests
equal the currently protected rules. Semantically duplicate same-head,
same-policy requests have the same canonical digest. Requests for older heads
are ignored only for the current Check; they remain authorized historical work
and may finish or supply reusable candidates.

The prerelease description and exact-head Check show the ordinary public
download URL, so a regular user can find it in the GitHub UI without an API
call. Numeric Release and asset IDs may be recorded as audit metadata but are
not required operator input.

When the pull request merges, this prerelease remains the historical request
index. It is not promoted, retagged, or appended with a second class of
“merged” event. The public GitHub merged-pull-request fact is the promotion
trigger. When a pull request closes or reopens, no lifecycle event asset is
added; reconciliation reads its public GitHub state.

## Discovery and Reconciliation

The first-party tap runs one protected reconciler every five minutes. It:

1. scans for every new valid request asset, including an explicitly issued
   older head that remains buildable after its pull request advances;
2. validates request URL, filename, bytes, schema, issuer, head, ABI, and
   addressed tap;
3. claims work idempotently by request digest;
4. reconstructs durable progress from immutable records;
5. schedules ready bottle, verification, and product work; and
6. checks the public open, merged, closed, or reopened state of every claimed
   pull request.

Discovery is at-least-once. GitHub concurrency is only a best-effort mutex, not
durable state or provenance. Repeated automatic scans and manual reconciliation
coalesce around the request digest and independently addressed receipts.

A protected manual workflow accepts one request_asset_url. It may be invoked
immediately. The URL must stay within the expected GitHub repository, tag, and
asset-name grammar; redirects must stay inside the reviewed GitHub asset
download boundary. Manual and scheduled paths call the same coordinator and
have identical validation and effects.

If an automatically issued request has not been claimed within 15 minutes, the
Kandelo Check reports discovery delayed and links the manual URL. This is an
observability threshold, not an authorization boundary or mandatory wait.

A future narrowly installed GitHub App may invoke this same reconciliation
path to reduce latency. It must remain an optional delivery adapter rather than
becoming the public protocol or shared authority.

## Pull-request Lifecycle

| Pull-request state | Coordinator behavior |
|---|---|
| Open, exact request active | Schedule required work first, then background work; reuse complete matching receipts. |
| New head | Issue and reconcile a new request; old exact-head work may finish; only the current-head Check can gate merge. |
| Merged | Adopt the exact request; promote eligible candidates independently and continue the background set. |
| Closed without merge | Stop new batches, retries, product VFS builds, and promotion; allow already running bottle jobs to finish. |
| Reopened at same exact head | Reactivate the request, cancel pending cleanup, and resume only missing or retry-eligible work. |
| Reopened at a different head | Require a new request and, for a fork, a new exact-SHA maintainer command. |

Closing never rewrites completed attempts or candidates. A valid candidate
that finishes after closure remains visibly nonendorsed and follows cleanup
policy. Reopening does not reset attempt counts, retry exhaustion, timeouts, or
prior failures.

## Tap Planning and Dependency Scheduling

After validating a request, protected tap code snapshots the exact tap commit
and tree it will plan. The request supplies ordinary Formula roots; the tap
resolves those roots through its own Formula definitions into the actual
transitive dependencies for each required VFS product.

The immutable plan separates:

- **required Formulae:** every Formula needed by at least one selected
  merge-gating test or shipped product, including its actual dependencies; and
- **background Formulae:** the remainder of the first-party tap inventory for
  the target ABI.

This is scoped dependency resolution, not a canonical global “closure” or
tap-wide selection. Different products can be ready independently. The
background set never gates the Kandelo merge.

The coordinator schedules Formulae when their direct dependencies have usable
candidate layers. It uses repeated bounded batches rather than a workflow job
that waits for hours or assumes a fixed dependency depth. A failed dependency
blocks only its dependants. Independent siblings continue.

Every ABI change makes the target ABI and structural snapshot part of each
bottle contract, so a new ABI normally causes the full first-party tap sweep to
rebuild. Within the same target ABI, complete fingerprint equality can reuse a
candidate across requests.

## Knowing Whether a Bottle Is Unchanged

Without building, the system cannot prove that a new build would coincidentally
emit the same bytes. It can prove that a previously built result remains
applicable when the complete set of output-affecting inputs is unchanged.

The canonical bottle_contract_digest covers at least:

- target ABI, structural snapshot identity, and architecture;
- Formula identity, version, revision, rebuild, Formula source, resources, and
  patches;
- selected build script and every declared Kandelo source input it reads;
- SDK, libc, sysroot, toolchain, instrumentation, and environment-policy
  identities;
- Homebrew source and native-input receipts;
- build policy that affects installed bytes; and
- each direct dependency's exact bottle-layer digest plus explicit
  materialization-policy peers.

The exact request head, branch name, PR number, workflow run, and producer
commit are recorded but do not enter this digest unless their underlying bytes
are an actual captured build input.

There is no separate authoritative dependency_materialization_digest that
duplicates a dependency bottle digest. The dependent contract names the exact
dependency bottle layer and any separate policy input that controls how those
bytes are exposed to the build.

The decision table is:

| Capture state | Comparison | Action |
|---|---|---|
| Complete | Identical | Reuse the exact prior candidate and its source/verification records as applicable. |
| Complete | Changed | Rebuild that Formula; if its resulting dependency layer changes, rebuild affected reverse dependants. |
| Incomplete | Unknown | Fail staging immediately with build_input_capture_incomplete and actionable capture diagnostics. Do not build or silently reuse under ordinary policy. |

This conservative rule fails promptly instead of leaving the pull request
waiting on work whose identity cannot be interpreted. The diagnostic names the
uncaptured or ambiguous inputs, affected Formulae and products, and the exact
override subject. A separate uncredentialed diagnostic bottle build is useful
future work but is not required by the MVP.

An authorized maintainer may accept this one capture risk for an exact request,
Formula, architecture, and contract subject. That override permits the normal
uncredentialed builder to run. Protected code still validates the resulting
inert bottle and every nonoverrideable integrity rule, then publishes a public
candidate and eventual admission explicitly classified accepted_with_override.
The override never makes capture complete and never licenses a different
request or resulting subject.

## Source Custody

Source is preserved with actual build outputs, not merely with the request.

For each candidate, the build produces an inert source-custody capsule
containing:

- the exact Kandelo Git commit and tree used by the build;
- pinned Kandelo submodule commits and the required preserved submodule
  content;
- the exact tap commit/tree and Formula source used by the build; and
- a canonical manifest of capsule members and digests.

The protected publisher validates regular-file inventories, sizes, hashes,
Git object identities, and expected source relationships without executing
capsule content. It publishes the capsule by digest under:

~~~text
ghcr.io/kandelo-dev/homebrew-tap-core-abi-<N>-source-custody
~~~

Candidates reference the neutral capsule digest. Multiple candidates may share
one capsule without duplicating bytes. Source objects remain while any
candidate, verification, admission, or canonical bottle references them, then
receive a 30-day unreferenced grace period.

The first deployable MVP must preserve Kandelo and tap Git sources and pinned
submodules. Complete layered custody for every external source role may follow
incrementally. Legacy infrastructure cannot be removed until the consumer
audit and complete custody coverage prove that its source-retention role has
been replaced.

## OCI Storage and Naming

GitHub Releases are used for the small, human-discoverable per-PR request feed.
GHCR is used for large content-addressed bottle, source, and evidence objects.

Canonical bottles use one OCI repository per Formula under an ABI-qualified
tap namespace:

~~~text
ghcr.io/<owner>/<homebrew-repository>-abi-<N>/<formula>
~~~

Candidates use the visibly nonendorsed namespace:

~~~text
ghcr.io/<owner>/<homebrew-repository>-abi-<N>-candidates/<formula>
~~~

Pre-merge VFS product bytes and compact evidence live under a reserved
products/<product-id> subtree of that same ABI-qualified noncanonical
namespace. They are product evidence, not Formula packages, and validators
forbid Formula metadata from referring to them. Their OCI manifests bind the
VFS, build report, requirements, runtime inputs, and verification-receipt
digests so Kandelo can read the evidence anonymously by digest.

The candidate OCI manifest points at the exact bottle layer and binds factual
build/provenance data. The manifest digest is the candidate_record_digest.
Verification is not embedded in that manifest.

Packages are created lazily by the first protected publisher using the public
tap repository's scoped GITHUB_TOKEN with packages: write and the correct OCI
source association. After first write and every later write, protected code
verifies repository association, manifest and layer digest/size, and anonymous
public readback. A namespace is not considered usable before these checks pass.

Kandelo Homebrew platform tags remain stable:

~~~text
wasm32_kandelo
wasm64_kandelo
~~~

The ABI belongs in OCI roots, sidecar/record metadata, and protected tap
history—not in Formula names or platform tags. VFS manifests request ordinary
Formula names. The builder derives the ABI-qualified canonical or candidate
location from the selected ABI and repository.

## Durable Record Model

Compact canonical records preserve every fact needed for identity, reuse,
promotion, and trust decisions. Raw logs and large diagnostics may expire under
normal GitHub retention.

### Attempt record

Records request, Formula, architecture, bottle contract, source capsule,
runner/build facts, terminal outcome, guard codes, and diagnostic references.
A failed attempt with no valid bottle has no candidate record.

### Candidate record

Binds:

- exact bottle-layer SHA-256 and byte count;
- Formula/version/revision/rebuild, ABI, and architecture;
- bottle-contract digest and normalized component identities;
- direct dependency bottle-layer identities;
- candidate OCI manifest digest and reference;
- source-custody digest;
- producer request/head/run provenance; and
- explicit nonendorsed classification.

### Verification receipt

Binds one candidate digest, test definition and inputs, kernel/host/VFS
identities where applicable, outcome, guard codes, and run provenance. Every
retry creates another immutable receipt.

### Product evidence record

Binds the exact VFS product manifest, selecting consumer/test registries,
resolved Formula layers, VFS image and report, exact kernel and host identities,
Node/browser test definitions, and their verification receipts.

### Admission record

Binds the promoted candidate layer, qualifying verification or override
receipts, exact merged pull request and merge commit, tap source state,
canonical OCI reference/readback, and Formula metadata update. It preserves
the original producer rather than claiming a final-main rebuild.

### Deletion record

When unreferenced candidate bytes are removed after grace, a compact tombstone
retains the identity, reason, time, and prior record references. Canonical
layers and source still referenced by admissions are not deleted.

## Build, Publication, and Verification Boundaries

### Uncredentialed build

The build job:

- checks out the exact request source and planned tap source;
- receives contents: read only, no secrets, and no persisted credentials;
- reconstructs or verifies declared dependencies by exact digest;
- builds through the normal Kandelo SDK, libc, package, Homebrew, and VFS
  paths;
- emits bottle bytes, normalized contract inputs, source capsule, and bounded
  diagnostics to the Actions artifact service; and
- cannot write GHCR, Releases, Checks, branches, Pages, or attestations.

### Protected candidate publisher

A separate write-capable job runs protected exact-revision code. It treats the
build artifact as inert, requires bounded regular-file inventories, verifies
all hashes and identities, validates the candidate record, publishes source and
candidate OCI objects, and performs anonymous readback. It never executes a
script from the artifact or sources artifact-provided environment.

### Independent verifier

The verification execution job runs read-only against the public candidate
digest. It does not trust a mutable candidate tag and does not rebuild the
bottle. It emits a bounded inert result. A separate protected receipt publisher
validates that result against the candidate and test definition before
publishing each result as a separate immutable receipt.

A structurally valid candidate remains public if verification fails. The
failed receipt makes it ineligible under ordinary policy but leaves the exact
bytes available for investigation, later retest, or an explicit maintainer
override.

## Required VFS Products and Pre-merge Evidence

For every product selected through a merge-test or consumer registry, the tap
planner resolves the product manifest's Formula roots and dependencies needed
to build that VFS. Every one of those bottles is part of the required
pre-merge set.

Once the required candidates exist, the product job:

1. composes the VFS from exact candidate bottle layers;
2. binds the VFS report to the exact product manifest, selecting registries,
   tap plan, structural ABI snapshot, kernel, host, bottle layers, and source
   records;
3. boots and runs the declared basic Node test;
4. boots and runs the declared basic browser E2E; and
5. publishes a product evidence record.

Every shipped main-browser VFS must have at least one basic E2E. A test should
exercise the product's normal boot and principal executable or service, not
merely parse metadata. A manifest may declare additional informational tests
that do not block.

The exact kernel/host identity belongs to runtime_evidence_digest, not the
bottle contract merely because a commit changed. Consequently:

- a kernel/host change with unchanged complete bottle contracts may reuse the
  same bottle layers;
- its VFS and runtime evidence still rerun against the new exact kernel/host;
- an SDK, libc, ABI snapshot, instrumentation, or other build-observable change
  changes the bottle contract and rebuilds affected Formulae.

The comprehensive stock in-guest Homebrew tap/install/pour lifecycle is not an
MVP release gate. The required evidence is exact composition plus the
manifest-declared product startup/E2E. This narrower claim must remain explicit
until the successor-ABI vfork path supports broader proof within bounded
resources. The lifecycle already exists as a diagnostic and has completed on
a larger local host; current standard hosted publication intentionally makes
the narrower claim after the 16 GiB runner exhausted memory. The successor-ABI
vfork fixture should measure whether the full lifecycle can return to the
hosted release gate without changing its semantics.

## Kandelo Pull-request Check

A protected Kandelo reconciler reads public request, candidate, verification,
and product records and emits one exact-head Check. The Check is a
human-readable projection, not the authoritative datastore.

It includes:

- request asset URL and digest;
- target ABI and structural snapshot identity;
- tap plan/snapshot;
- required Formula and product results;
- background progress as informational detail;
- blockers, guard codes, retries, timeouts, and override links; and
- links to immutable records and public OCI objects.

The required conclusion is successful only when every selected required
product has all resolved bottle dependencies, a valid VFS, and all declared
required evidence. Background Formula failures do not change that conclusion.

Protected merge preparation recomputes applicability using the policy and
requirements current on Kandelo main. If current policy adds evidence, the
current exact head must satisfy it before merge. The historical request remains
truthful about what it originally requested; it cannot freeze obsolete merge
rules.

## Merge-triggered Promotion

Promotion begins only after GitHub reports that the exact pull request
associated with the request merged. This avoids a pre-merge race without
requiring the tap to monitor arbitrary Kandelo main commits.

For an ABI N to N+1 transition, the protected abi/N branch must already exist,
be protected, and be verified against the exact pre-activation tap state before
the first N+1 canonical promotion or tap-main current-ABI mutation. This is an
activation barrier, not a complete-set gate: after it succeeds, Formulae may
promote independently.

The reconciler verifies:

- request and merged PR identity;
- target ABI and exact candidate;
- candidate and source integrity;
- qualifying verification or exact override receipts;
- tap Formula source still matches the candidate plan; and
- the canonical namespace and destination are safe.

If the tap Formula source changed since planning, that Formula records
tap_source_drift and is replanned/rebuilt against current tap source. Its
dependants wait only if the resulting dependency bottle layer changes.
Unrelated Formulae continue.

Promotion creates the canonical OCI manifest and top-level index around the
unchanged candidate bottle layer. It also copies the exact candidate bottle
metadata blob so later canonical VFS composition has a real endorsed descriptor
reference rather than an invented locator. Candidate and canonical manifest
digests may differ because annotations and references differ; both copied-layer
digests and bytes must be exact. Anonymous readback is mandatory before
admission.

Each Formula then receives a narrow generated metadata update on tap main,
guarded by compare-and-swap against the reviewed Formula source. The write
touches only generated bottle/current-ABI metadata for that Formula. A conflict
or unexpected path fails rather than overwriting concurrent work.

The required set should normally be immediately promotable after merge.
Background candidates continue to build, verify, and promote independently.
No “complete core set” condition delays the merge or unrelated promotion.
Kandelo may publish the merged kernel without waiting for that background set;
the pre-merge required products are the evidence that the kernel has the
software it needs for its declared tests and shipped VFS products.

## ABI-qualified Tap History

When an ABI N+1 pull request merges:

1. the tap creates or verifies a protected abi/N branch at the exact current-N
   tap state before current metadata advances;
2. tap main changes its declared current ABI to N+1;
3. previous-ABI bottle metadata is no longer a default on tap main;
4. unpromoted N+1 Formulae are represented as unavailable for the current ABI,
   never by silently serving an N bottle to an N+1 kernel; and
5. each promoted Formula adds its N+1 bottle metadata independently.

Consumers and VFS declarations continue to use ordinary Formula names. The
builder resolves the selected ABI through tap state and ABI-qualified OCI
namespaces. A consumer that intentionally reconstructs ABI N uses protected
abi/N metadata or exact content-addressed records; it does not suffix each
Formula dependency.

The already-scheduled ABI N sweep is allowed to drain to terminal success or
failure after N+1 merges. When every scheduled N job is terminal, ABI N changes
from retiring to retired. This does not gate N+1.

Retired does not mean immutable failure:

- a Formula that failed on N may be retried so maintainers can repair old
  software availability;
- a security issue may force a rebuild for any ABI, including retired ABIs;
- repairs use the protected abi/N source/metadata and ABI-qualified namespace;
  and
- historical canonical bottles remain publicly retrievable.

## Atomic Pages Publication

The Pages owner is Kandelo, while bottle and Formula metadata remain tap-owned.
A protected Pages workflow on Kandelo main consumes only admitted canonical
bottles and verified product inputs.

For one site revision, it resolves every product included by the checked-in,
Pages-owned product registry. Deployment begins only after all of the following
are present:

- every product's canonical bottle dependencies;
- a successfully constructed VFS;
- the declared basic Node/browser evidence; and
- the exact site/gallery metadata for the same product set.

Because candidate and canonical lazy references use visibly different OCI
repositories, Pages recomposes each selected product from admitted canonical
inputs and reruns its required basic evidence. It reuses the unchanged promoted
bottle layers, not the candidate VFS byte stream. The deployed record names the
exact final VFS bytes and current-main source it actually used.

If any dependency build, promotion, VFS build, or required E2E fails or times
out, that site revision is not deployed. The workflow records the blockers and
ends without replacing the current deployment. The last complete Pages site
stays live.

The coordinator does not keep a runner waiting for missing bottles. It records
blocked readiness, returns, and retries reconciliation when new receipts
appear.

Atomic whole-site deployment is the MVP rollout policy, not a permanent VFS
architecture promise. A later Pages design may ship an exact compatible
kernel/host identity beside each product and gradually activate individually
ready VFS images. That future design must remain explicit about which kernel,
ABI, and product bytes are selected; it does not weaken the MVP's last-complete
site behavior.

## Retries and Timeouts

The initial defaults are:

- bottle build attempt: six hours;
- VFS composition plus required E2E: three hours; and
- three automatic retries after the initial attempt for a classified transient
  infrastructure failure.

Timeout is a terminal attempt outcome, not proof that the Formula is
permanently broken. A later reconciliation can schedule the permitted retry.
Retries use deterministic full jitter derived from the request digest, exact
subject identity, and retry number, with successively bounded windows. The
reason must be documented beside the scheduler: deterministic jitter spreads
related jobs to avoid a recovery stampede while keeping unit tests, replay, and
operator expectations reproducible. A coordinator records next_eligible_at and
returns; it does not consume a runner by sleeping. After automatic retry
exhaustion, maintainers may request another attempt without deleting history.

Application failures, deterministic contract failures, and integrity failures
are not automatically retried as infrastructure noise. The guard registry owns
the classification.

## Maintainer Overrides

Overrides are an emergency escape hatch for an exact request and subject, not
a way to turn unidentified bytes or an integrity contradiction into success.
Most overrides act on an exact existing artifact. The one MVP exception is an
incomplete-capture override, which may authorize the normal uncredentialed
build for the named request/Formula/architecture; the protected publisher then
binds the accepted-risk record to the exact resulting candidate digest.

A protected manual workflow records:

- exact request, Formula, architecture, candidate digest, and bottle layer;
- exact guard codes being accepted;
- maintainer identity and repository authorization;
- bounded human justification; and
- policy/guard-registry version.

The public immutable override receipt changes eligibility to
accepted_with_override. Reports and admissions retain that distinction.

For a pre-build incomplete-capture override, candidate digest and bottle layer
are absent initially and must be filled by protected code from the first valid
result of that exact authorized build. All other override subjects require the
existing candidate identity before approval.

Initially overrideable conditions include:

- incomplete but inspectable build-input capture;
- a failed or timed-out verification when exact candidate bytes exist;
- selected policy/evidence failures whose risk a maintainer can evaluate; and
- an exhausted transient retry policy.

Never overrideable conditions include:

- malformed or unauthorized request;
- source, ABI, architecture, or Formula identity mismatch;
- bottle or manifest hash/size mismatch;
- unsafe path, symlink, or archive inventory;
- candidate identity collision or mutable digest conflict;
- missing bottle bytes;
- missing or mismatched source custody required by the active policy;
- failed canonical or anonymous readback; and
- a write-capable job executing candidate-controlled code.

A missing dependency is not directly overridden. Its own candidate must exist
and either pass policy or receive an allowed exact-artifact override. Pages
atomicity is likewise not bypassed by deploying a partial site.

Security rebuilds of retired ABIs are authorized maintenance actions, not
identity overrides: they create new attempts, candidates, verification, and
admissions under the historical ABI.

## Initial Guard-code Registry

The first-party implementation has one versioned, append-only registry in
Kandelo. Meanings cannot change in place. Unknown codes fail closed.

| Code | Normal effect | Override |
|---|---|---|
| request_invalid | Reject request | Never |
| request_unauthorized | Reject issuance or claim | Never |
| abi_structure_changed_without_bump | Fail Kandelo Check | Never |
| source_identity_mismatch | Reject build/publication | Never |
| source_custody_mismatch | Reject candidate/admission | Never |
| build_input_capture_incomplete | Fail before ordinary build; attach capture diagnostics | Exact-subject build and risk acceptance |
| build_failed | Record attempt; no candidate | No; rebuild/retry instead |
| build_timeout | Record timed-out attempt | Retry policy; no promotion without bytes |
| transient_infrastructure_failure | Retry three times automatically with deterministic full jitter | Manual retry after exhaustion |
| candidate_integrity_mismatch | Reject candidate | Never |
| candidate_public_readback_failed | Ineligible | Never |
| verification_failed | Ineligible | Exact-artifact override |
| verification_timeout | Ineligible | Exact-artifact override or retry |
| dependency_unavailable | Block only dependants/products | Resolve dependency's underlying state |
| tap_source_drift | Replan/rebuild affected Formula | Never |
| namespace_bootstrap_failed | Block affected Formula publication | Repair package configuration |
| policy_version_unknown | Reject interpretation | Never |
| pages_product_incomplete | Keep last complete site | Never deploy partial site |

Implementation may split a code when materially distinct remediation or
override semantics require it. It may not encode unbounded runtime details into
new code strings; details and logs remain separate factual fields.

## Status and Reporting

Canonical records use orthogonal fields rather than one giant state enum:

- work_state: pending, blocked, queued, running, complete;
- outcome: success, failure, timeout, canceled, skipped when terminal;
- artifact_class: none, diagnostic, candidate, canonical;
- promotion_state: unknown, eligible, ineligible,
  accepted_with_override, rebuild_required, promoted;
- retry_state: attempts, eligibility, next action, exhaustion; and
- structured blockers with guard codes and subject identities.

Schema invariants reject contradictions. Human labels such as candidate_ready
or blocked_on_bottles are derived views only.

One combined Check or status report contains all Formula, VFS, Pages, retry,
and promotion details for convenience. It is not a transaction, lock,
datastore, or all-or-nothing gate. Each immutable record remains the authority
for its own fact.

The first MVP Check may render only the first deterministic causal blocker in
its prominent summary, with the affected products, next action, and links to
the detailed record. The record model must not discard sibling outcomes merely
because the initial UI is concise. A later presentation can progressively show
additional failures as they arrive without changing record identity or gate
semantics.

## Cleanup and Retention

Raw logs and large diagnostic artifacts use normal GitHub retention. Any fact
needed for identity, reuse, trust, or promotion must be extracted into a compact
durable record before logs may expire.

Candidate and source objects remain while an open request or an active
promotion, verification, product, repair, or admission record pins them. A
historical request or attempt may name a digest without pinning the large bytes
forever; retention references are explicit record fields. Promoted bottle
layers and the source required by their admissions remain pinned. After an
unmerged close:

- active bottle jobs may finish and publish valid nonendorsed candidates;
- no new batch, retry, product evidence, or promotion begins;
- unreferenced candidates enter a 30-day grace period; and
- a protected maintenance job may delete bytes after rechecking references and
  publishing a deletion record.

Maintainers may immediately purge malicious, legally problematic, or
pathologically large unendorsed content. Shared canonical layers and referenced
source capsules remain.

## Security and Capability Model

Workflows default to no permissions and grant capabilities by job:

| Job class | Maximum MVP permission |
|---|---|
| Candidate source/build/test | contents: read |
| Tap discovery/planning | contents: read |
| Candidate/source publisher | contents: read, actions: read, packages: write |
| Verification/product-evidence publisher | contents: read, actions: read, packages: write |
| Canonical promoter | contents: read, actions: read, packages: write |
| Kandelo request writer | contents: write |
| Kandelo Check updater | contents: read, checks: write |
| Tap metadata and abi/N writer | contents: write |
| Pages deployer | contents: read, pages: write, id-token: write |

No job combines candidate execution with write permission. Write-capable jobs
run only protected code and consume bounded inert inputs. Package publication,
tap Git writes, Kandelo Release writes, Check updates, and Pages deployment
remain separate capabilities.

Composite actions cannot establish job permission boundaries. Reusable
workflows own permissions, matrices, concurrency, artifact transfer, and
cross-job separation. Structural and mutation tests reject workflow-level
write grants, credential flow into candidate jobs, mutable action references,
and unsafe job combinations.

## Component Factoring

Substantial behavior belongs in normal libraries and command-line tools.
Composite actions are thin adapters for validated inputs, runner setup, command
invocation, bounded outputs, and failure propagation.

Useful component boundaries are:

1. canonical VFS product manifests, consumer registries, and ABI/applicability
   selection;
2. canonical request generation and validation;
3. request discovery and PR-lifecycle reconciliation;
4. tap planning, fingerprinting, and dependency scheduling;
5. uncredentialed bottle construction and source capture;
6. protected candidate/source publication;
7. candidate verification and receipt generation;
8. required-product VFS composition and evidence;
9. canonical promotion and Formula metadata update;
10. protected ABI history and maintenance; and
11. Pages readiness and atomic deployment.

These are not automatically eleven actions. Closely related calculations with
the same inputs, authority, and failure lifecycle remain modules or functions
inside one tool. A separate action is warranted only for a meaningful reusable
contract, durable artifact boundary, or different security authority.

## Testing Strategy

Testing proceeds from cheap and deterministic to hosted:

### Unit and canonical-fixture tests

- request and record schema validation;
- canonical VFS product/consumer-registry TOML plus generated JSON
  normalization and digest stability;
- derivation of Formula roots from selected product IDs with no duplicated
  staging Formula list;
- preservation of embedded versus lazy materialization and rejection of
  undeclared builder software inputs;
- exact request filename/head/content/policy matching, including same-head
  policy reissuance and older-head historical work;
- exact command parsing with broad quoted/code/block/list negative cases;
- bottle-contract component inclusion and provenance exclusion;
- dependency scheduling, reverse-dependant invalidation, and graph failures;
- lifecycle transitions for open, new head, merge, close, and reopen;
- three-retry deterministic-jitter vectors, timeout, override, cleanup, and
  status invariants;
- OCI name and public URL derivation; and
- guard-code registry behavior.

### Thin action contract tests

Each action wrapper is tested with fixture inputs for exact environment,
arguments, bounded outputs, and failure propagation. Business logic remains
covered in the underlying libraries.

### Workflow structural and mutation tests

Tests freeze:

- exact job permission maps;
- protected versus candidate checkout identity;
- no secrets or persisted credentials in candidate jobs;
- artifact inventories and digest bridges;
- action SHA pins;
- request writer and fork-comment authority;
- publisher/verifier separation;
- exact promotion/readback ordering; and
- Pages-owned registry completeness before deployment, including rejection of
  a VFS product attempting to grant itself Pages placement.

### Local miniature lifecycle

A local harness performs a generic N to N+1 transition with tiny Formula and
OCI fixtures:

- generate and validate a request;
- plan required and background Formulae;
- build or reuse candidates;
- capture source;
- publish to a local/fake content-addressed transport;
- verify candidates;
- build and test a miniature VFS;
- simulate merge and independent promotion;
- preserve abi/N state; and
- hold or deploy a miniature Pages inventory atomically.

This harness is the primary integration-debugging environment.

### Hosted acceptance

A small number of GitHub-hosted runs prove behavior that local tests cannot:

- actual GitHub permissions and protected event context;
- Actions artifact identities;
- concurrency/coalescing;
- GHCR lazy package creation and repository association;
- anonymous GHCR readback;
- public Release-asset discovery;
- exact Check reporting; and
- Pages deployment.

The complete successor-ABI batch is the first end-to-end acceptance transition.
Its specific ABI number and branch name are fixtures only.

## Rollout Plan

Implementation proceeds in this order:

1. Canonical VFS product manifests, Pages/test consumer registries, data
   models, guard registry, core libraries, fixtures, and local miniature
   lifecycle. Transitional builders consume the new product authority rather
   than teaching staging to depend on legacy package metadata.
2. Exact-head request generation, public prerelease assets, manual URL
   reconciliation, and tap scheduled reconciliation.
3. Uncredentialed bottle builds, MVP source custody, candidate publication,
   anonymous readback, and separate verification.
4. Required-product VFS composition, Node/browser E2Es, and the exact-head
   Kandelo Check.
5. Merge-triggered independent promotion, eventual background convergence,
   tap-main ABI activation, and protected abi/N preservation.
6. Atomic Pages publication.
7. One complete generic acceptance transition using the successor-ABI batch
   pull request.
8. Removal of marked legacy infrastructure after acceptance evidence, consumer
   audit, and complete source-custody replacement are retained.

Earlier foundations may land inert and independently tested. They must not be
documented as operational behavior until the corresponding integration and
hosted acceptance evidence exists.

## Legacy Retirement

The new lane is added beside the existing publisher and migration
infrastructure. Existing working paths remain a fallback during rollout.

Implementation must add a checked-in retirement inventory for every
Homebrew-relevant legacy component. Each entry names:

- the old workflow, script, schema, or metadata path;
- its current consumers;
- the replacement component;
- the acceptance evidence that proves replacement; and
- the exact removal condition.

Legacy files should carry concise deprecation comments pointing at this design
and the replacement, without disabling them prematurely.

Removal requires:

- one complete real ABI N to N+1 transition;
- required product and Pages evidence;
- independent promotion and historical abi/N repair evidence;
- a consumer audit showing no remaining Homebrew dependency;
- complete source-custody replacement for any retained-source role; and
- preserved failure/recovery evidence.

Non-Homebrew package archive and staging infrastructure is out of scope and
must not be removed merely because an old Homebrew workflow shared it.

## Explicit Limitations and Deferred Work

The initial implementation intentionally carries these limitations:

- semantic ABI compatibility is not automatically proven beyond the structural
  model and observable tests;
- fork exact-SHA authorization may follow the same-repository MVP;
- a GitHub App and generic third-party trigger adapters are deferred;
- complete custody of every external source role may follow the MVP, while
  Kandelo/tap/submodule custody is required immediately;
- a separate bottle build used only for incomplete-capture diagnostics is
  deferred; the MVP fails promptly unless an exact maintainer override permits
  the normal uncredentialed build;
- the full stock in-guest Homebrew lifecycle remains an informational or manual
  diagnostic until successor-ABI vfork behavior is measured;
- no global consistency transaction spans Kandelo, the tap, GHCR, and Pages;
  convergence relies on immutable records and idempotent reconciliation;
- a complete background tap may take an unbounded number of reconciliation
  cycles when Formulae fail;
- Pages deploys atomically in the MVP, while future kernel-per-product delivery
  may permit gradual VFS activation; and
- deeper Rust semantic ABI modeling, man pages, broad upstream Homebrew CI
  convergence, and remaining campaign/trust archival cleanup are separate
  follow-ups.

These limitations are invitations to improve the design, not hidden claims of
completeness.

## Acceptance Criteria

The staging system is ready to replace the legacy Homebrew lane only when a
generic successor-ABI pull request demonstrates all of the following:

1. ordinary and protected CI reject an incompatible structural ABI change
   without a version bump;
2. protected Kandelo automation issues a canonical request for the exact head;
3. the tap discovers or manually reconciles the request idempotently;
4. requirements are generated from canonical VFS product manifests selected by
   test- and Pages-owned consumer registries, and the tap resolves their actual
   dependencies;
5. candidate code builds with no write credentials;
6. source custody, candidate publication, and anonymous readback succeed;
7. bottle-contract and layer identity stay stable across provenance-only
   request changes, and the prior candidate is referenced rather than
   republished with invented provenance;
8. changed complete inputs rebuild the affected Formulae and dependants;
9. incomplete capture fails staging immediately with actionable diagnostics,
   never silently reuses a bottle, and proceeds only through an exact recorded
   override;
10. verification is a separate immutable action on exact candidate bytes;
11. every required shipped VFS builds and passes its declared Node/browser
    evidence for the exact head;
12. the Kandelo Check blocks only on required products, not background Formulae;
13. the pull request merges only after its current-head required Check passes;
14. eligible bottles promote independently without changing bottle-layer bytes;
15. tap main never silently serves previous-ABI metadata as current;
16. protected abi/N history remains retrievable and supports a controlled
    failed-package or security rebuild;
17. background Formulae continue after merge without a global gate;
18. a failed product dependency prevents a new atomic-MVP Pages deployment
    while the last complete site stays live;
19. close/reopen/new-head behavior preserves exact immutable history and
    resumes only eligible work;
20. allowed overrides remain exact, public, and visibly distinguished, while
    integrity contradictions cannot be waived; and
21. the local miniature lifecycle and hosted security/publication acceptance
    suites pass.

Only after this evidence and the legacy-retirement prerequisites are retained
may the old Homebrew staging path be deleted.
