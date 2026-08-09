# Generic ABI Staging Product Authority Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish canonical Virtual File System (VFS) product authority,
consumer-owned Pages and test selection, fail-closed builder-input contracts,
shared staging records, and a complete local generic ABI transition without
enabling or changing the hosted staging, publishing, promotion, or deployment
paths.

**Architecture:** Human-authored TOML files own stable VFS product and consumer
intent. A Rust `xtask abi-staging` command validates those files, emits
canonical compact JSON, selects products by change applicability, and derives
Homebrew Formula roots solely from the selected product graph. Existing
package metadata and product-specific image builders remain transitional build
adapters: a
separate adapter inventory may describe mechanical package/output mappings,
but it cannot name software dependencies. A resolved-input envelope and exact
builder report form a fail-closed boundary for future candidate composition.
The first end-to-end proof uses only tiny local fixtures, a real miniature VFS,
and a fake content-addressed transport; no GitHub, tap, registry, Check, or
Pages write is introduced by this plan.

**Tech Stack:** Rust and Cargo for canonical models and selection, TOML and
canonical JSON for inert interchange, TypeScript and the existing
`MemoryFileSystem` for the miniature VFS, Node's test runner through `tsx`,
Bash for the local integration harness, and existing repository validation
through `scripts/dev-shell.sh`.

## Global Constraints

- Keep every new implementation generic in source ABI `N` and target ABI
  `N + 1`. Concrete acceptance-branch ABI values may appear only in hosted
  fixture inputs, never in reusable code, schemas, paths, names, or policy.
- Build and validate the exact pull-request head. A synthetic merge commit is
  never a staging build source.
- Product TOML is the lasting authority for product identity, composition,
  direct software roots, materialization, mounts, boot intent, and basic
  evidence. `package.toml`, `build.toml`, Brewfiles, locks, and custom builders
  may only project or implement that authority.
- Pages and test registries are consumer-owned. The product schema rejects a
  Pages, deployment, applicability, workflow, credential, retry, timeout,
  candidate-location, or ABI field as unknown.
- Preserve both lazy boundaries: a whole VFS may remain a lazy browser asset,
  and a VFS may retain lazy bottle or package-layer references internally.
- Candidate inputs and lazy references use a visibly nonendorsed candidate
  reference class. Canonical composition after admission reuses the exact
  bottle-layer digest but produces a new VFS around canonical references.
- Ordinary builder validation fails on incomplete capture, an undeclared
  input, a missing declared input, a digest/size mismatch, or a materialization
  mismatch. This plan models exact overrides but does not let an ordinary
  builder apply one.
- Candidate execution remains uncredentialed. This plan adds no credentialed
  candidate job and no remote writer. Future protected writers treat every
  downloaded artifact as bounded inert data.
- Keep all current Homebrew, package, Pages, and browser paths present and
  operational during this foundation. Mark them for retirement; do not remove,
  disable, or claim replacement before hosted acceptance and the checked-in
  retirement conditions are satisfied.
- Treat obsolete VFS-wrapper package entries and
  `homebrew/main-shell.Brewfile` as explicit retirement targets. Do not treat
  ordinary software recipe entries as legacy: they continue to own portable
  source, license, dependency, output, and build facts.
- Do not update user-facing reference documentation to call ABI staging
  operational. Foundation documentation must say that remote request,
  candidate, Check, promotion, and Pages integration remain unimplemented.
- Preserve the existing unrelated dirty state in `tests/sortix/os-test` and
  `.serena/`. Do not clean, reset, stage, or edit either path.
- Run every build or validation command through `scripts/dev-shell.sh`.

---

## Approved Design Basis

This plan implements the design recorded by these immutable documentation
commits:

- Initial specification: `580dd078b4ae55997416aa125f126da9eaa6fa12`
- Final revisions: `6e1b7ff24e544463d6f9c5f6b7fb67a873e1337a`

The final specification is authoritative even though its commit is on a
disconnected documentation history and the file is not present at current
`main`. Implementation must read it with `git show`, not recreate policy from
memory. The current `docs/future-improvements.md` has newer unrelated content;
only the approved staging-specific deferred items may be merged into it.

## Five-Plan Roadmap

1. **Product-authority foundation — detailed in this document.** Land the
   canonical product and consumer interfaces, checked-in product inventory,
   generic selection and applicability logic, guard and record foundations,
   builder-input enforcement boundary, retirement inventory, and complete
   local miniature lifecycle. Exit criterion: all local tests pass while all
   hosted production paths remain unchanged.
2. **Exact-head request feed and reconciliation.** Add protected same-repository
   request issuance, canonical request assets, exact-current-head and current
   policy/requirements matching, historical-head preservation, public manual
   URL reconciliation, and scheduled tap reconciliation. Exit criterion: local
   and hosted tests prove append-only requests and exact-head checkout without
   executing candidate code in a write-capable job.
3. **Tap planning, candidate bottles, source custody, verification, retries,
   and overrides.** Implement tap-owned dependency planning and background
   scheduling, uncredentialed builds, MVP source capsules, protected candidate
   publication, anonymous readback, independent verification, deterministic
   full-jitter retry scheduling, and exact-subject override receipts. Exit
   criterion: candidate identity and custody are public and immutable, and no
   candidate-executing job has a write credential.
4. **Candidate VFS evidence and the required Kandelo PR Check.** Adapt every
   required product builder to the resolved-input/report boundary, compose
   candidate VFS images with visibly nonendorsed references, run declared Node
   and browser evidence, and publish the exact-head required Check. Exit
   criterion: required selected products gate the pull request while unrelated
   background Formulae do not.
5. **Promotion, protected ABI history, Pages readiness, retirement, and legacy
   cleanup.** Promote unchanged bottle layers independently, recompose final
   VFS images with canonical references, create and verify protected `abi/N`
   history before activation, converge background Formulae, retain the last
   complete Pages deployment on failure, run the approved successor-batch
   hosted fixture, and remove legacy components only after every checked-in
   retirement condition has evidence.

Plans 2–5 consume the interfaces fixed here. They must not add a parallel
Formula requirements list, a mutable latest pointer, or a product-owned Pages
flag.

The complete roadmap and the independently executable follow-on plans are:

- [roadmap](2026-08-08-abi-staging-roadmap.md);
- [Plan 2: exact-head request feed and reconciliation](2026-08-08-abi-staging-exact-head-request-feed-and-reconciliation.md);
- [Plan 3: tap candidates and verification](2026-08-08-abi-staging-tap-candidates-and-verification.md);
- [Plan 4: candidate VFS evidence and PR Check](2026-08-08-abi-staging-candidate-vfs-evidence-and-pr-check.md); and
- [Plan 5: promotion, Pages, and retirement](2026-08-08-abi-staging-promotion-pages-and-retirement.md).

## Canonical Interfaces

### VFS product manifest version 1

Each file under `images/vfs/products/` contains exactly one
`VfsProductManifestV1`. Unknown fields fail validation. The normalized
interface is:

```toml
schema = 1
id = "browser-main-shell"
architecture = "wasm32"
output = "shell.vfs.zst"
builder = "scripts/build-homebrew-main-shell-product.sh"

[[composition.product]]
id = "platform-rootfs"
materialization = "embedded"

[[composition.repository]]
id = "main-shell-config"
paths = [
  "homebrew/main-shell-default.json",
  "homebrew/main-shell-demo.json",
  "homebrew/main-shell-brew-package-tree.json",
]
role = "runtime"
materialization = "embedded"

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
readonly = false

[[mounts]]
path = "/tmp"
source = "scratch"
mode = "1777"
uid = 0
gid = 0
ephemeral = true

[boot]
argv = ["bash", "-l", "-i"]
cwd = "/home/user"
uid = 1000
gid = 1000

[boot.env]
HOME = "/home/user"
TMPDIR = "/tmp"
TERM = "xterm-256color"
LANG = "en_US.UTF-8"
PATH = "/usr/local/bin:/usr/bin:/bin:/sbin:/usr/sbin"
USER = "user"
LOGNAME = "user"
PS1 = "kandelo$ "
HISTFILE = "/home/user/.bash_history"
SSL_CERT_FILE = "/etc/ssl/certs/ca-certificates.crt"
SSL_CERT_DIR = "/etc/ssl/certs"

[evidence.node]
test = "main-shell-startup"

[evidence.browser]
test = "main-shell-basic-e2e"
```

Products that consume package outputs, package-owned source roles, or direct
archives use these exact additional table shapes:

```toml
[[software.package]]
name = "php"
outputs = ["php-fpm", "opcache"]
source_roles = []
role = "runtime"
materialization = "embedded"

[[software.package]]
name = "kernel"
outputs = ["kernel"]
source_roles = []
role = "build"

[[software.archive]]
id = "wordpress-sqlite-integration"
url = "https://downloads.wordpress.org/plugin/sqlite-database-integration.2.1.16.zip"
sha256 = "ccc69cada05983e6c2dac8c0962b548c437b4c96c00ea41b0e130fc128671391"
role = "runtime"
materialization = "embedded"

[[software.toolchain]]
id = "clang-resource-headers"
provider = "repository-dev-shell"
component = "clang-resource-headers"
role = "runtime"
materialization = "embedded"
```

Validation rules are part of the interface:

- `schema` is exactly `1`.
- One TOML document is at most 1 MiB. A catalog has at most 256 products; one
  product has at most 64 composed products, 64 mounts, 32 Homebrew groups,
  256 total Formula roots, 256 package entries, 128 archive entries, 64
  toolchain entries, and 128 repository entries with at most 256 paths each.
- `id`, repository-input IDs, Formula names, package names, output names, and
  evidence IDs use lower-case ASCII letters, digits, dots, underscores, and
  hyphens; the first character is alphanumeric and each value is at most 128
  UTF-8 bytes. Tap/repository identities are at most 256 UTF-8 bytes.
- `architecture` is exactly `wasm32` or `wasm64`.
- `output` is one ABI-neutral portable filename ending in `.vfs` or
  `.vfs.zst`; it has no slash, backslash, NUL, or dot component. ABI selection
  belongs only in the resolved-input envelope, never in a product output
  template or target-specific manifest field.
- `builder` and every repository `path` are normalized repository-relative
  paths. They cannot be absolute, escape with `..`, contain a backslash or
  NUL, exceed 4,096 UTF-8 bytes, or name a symlink at validation time.
- Product composition forms an acyclic graph. A referenced product has the
  same architecture. Each product input appears once and declares exactly one
  `embedded` or `lazy` materialization.
- `software.homebrew` contains an immutable tap repository identity and one or
  more unique ordinary Formula names. Formula entries never contain versions,
  ABI-qualified names, candidate locations, resolved dependencies, or a build
  order.
- `software.package` names an in-tree package recipe, the exact logical
  outputs consumed, and any exact package-owned `source_roles` consumed. At
  least one output or source role is required; both arrays are duplicate-free.
  `role = "runtime"` requires `materialization`; a `role = "build"` entry
  forbids it. Package dependencies remain recipe facts, but the legacy adapter
  check rejects a VFS package dependency that is not reachable from the
  product manifest.
- `software.archive` names an exact URL and SHA-256. It follows the same role
  and materialization rule as a package input. URLs are credential-free HTTPS,
  contain no fragment, and are at most 8,192 characters. Complete custody for
  all external source roles remains deferred, but an undeclared archive is
  never allowed.
- `software.toolchain` names an exact logical component supplied by
  `repository-dev-shell`. It has only `id`, `provider`, `component`, `role`,
  and role-appropriate materialization; it contains no command, host path, or
  version probe. The resolved envelope binds the component's exact tree digest
  and toolchain-policy identity. Version 1 rejects any other provider. This is
  required for output bytes such as the SDK image's Clang resource headers;
  invoking the builder through the dev shell alone is not input capture.
- `composition.repository` identifies checked-in runtime or build inputs by an
  ID and exact path set. The resolved envelope later binds each file or tree to
  the exact build-source tree and content digest. A runtime repository input
  requires `materialization`; a build input forbids it, matching the package
  and archive role rule.
- Runtime materialization is effective per resolved object. If a lazy root is
  also in an embedded root's dependency closure, the resolved object is
  embedded and its report records every requesting root; it is not duplicated
  as a lazy layer. Otherwise `embedded` produces bytes in the image and `lazy`
  produces only a content-addressed reference.
- Mounts use `built-image` or `scratch`. The one `built-image` mount is `/` and
  has exactly `path`, `source`, and a required Boolean `readonly`. Every
  non-root mount is `scratch` and has exactly `path`, `source`, a three- or
  four-digit octal `mode` string, nonnegative `uid` and `gid`, and required
  Boolean `ephemeral`. Paths use normalized absolute POSIX syntax; duplicate
  paths and parent/child overlap between two non-root mounts fail.
- `boot` has exactly `argv`, `cwd`, `uid`, `gid`, and `env`. `argv` has 1–64
  strings of at most 4,096 UTF-8 bytes each, `cwd` is a normalized absolute
  path of at most 4,096 UTF-8 bytes, `uid` and `gid` are nonnegative integers,
  and `env` has at most 128 ASCII environment keys with values of at most 8,192
  UTF-8 bytes. Boot may be omitted only for a non-selected intermediate layer.
  Every Pages or required-test product must have boot intent and at least one
  basic evidence ID.
- `evidence.node.test` and `evidence.browser.test` are stable IDs, not commands
  or runner definitions. Either host section may be omitted.
- The manifest has no ABI, dependency closure, Pages placement, change
  applicability, candidate/canonical URL, runner, command, credential, retry,
  timeout, matrix, workflow, or status field.

`VfsProductCatalogV1` is generated as compact JSON. Its exact top-level keys
are `schema`, `kind`, and `products`; their values are `1`,
`kandelo-vfs-product-catalog`, and an ID-sorted array. Each product entry has
exactly `path`, `sha256`, and `manifest`. `path` is the normalized
repository-relative TOML path, `sha256` is the computed canonical manifest
digest, and `manifest` is the complete normalized `VfsProductManifestV1`.
The generator reads every regular, nonsymlink direct child matching
`images/vfs/products/*.toml`, reads no nested or hidden file, and rejects an
empty directory; there is no allowlist or excluded manifest filename.

Canonicalization recursively sorts object keys by Unicode code point, retains
array order, uses JSON integers only, emits no insignificant whitespace, and
appends exactly one line feed. A manifest digest is SHA-256 over its normalized
manifest object including that line feed. The catalog sorts products by ID and
includes the normalized repository-relative TOML path, digest, and manifest.
Duplicate IDs, duplicate outputs for an architecture, noncanonical generated
bytes, and stale generated files fail.

The compact form minimizes byte-level choices so independent implementations
hash the same logical value. It is generated interchange, not the human
editing surface: TOML remains the readable authority, and generated JSON may
be inspected through a formatter such as `jq` without changing its stored
canonical bytes.

### Consumer registries

The Pages-owned file is
`apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.toml`:

```toml
schema = 1
kind = "kandelo-pages-vfs-products"

[[products]]
id = "platform-rootfs"
load = "eager"

[[products]]
id = "browser-main-shell"
load = "eager"

[[products]]
id = "browser-node"
load = "lazy"
```

Only `schema`, `kind`, and `products` are accepted. Each product entry has
exactly `id` and `load`; `load` is `eager` or `lazy`. The registry owns Pages
placement and browser delivery mode. It contains no Formula, package, ABI,
evidence, URL, or workflow field. It has at most 256 unique entries.

The test-owned file is `tests/vfs-products.toml`:

```toml
schema = 1
kind = "kandelo-test-vfs-products"

[[registrations]]
product = "browser-main-shell"
node = ["main-shell-startup"]
browser = [
  "main-shell-basic-e2e",
  "main-shell-fbdoom-e2e",
  "main-shell-modeset-e2e",
]

[registrations.applicability]
abi = "required"
kernel = "required"
host = "required"
```

Only `schema`, `kind`, and `registrations` are accepted. Each registration has
exactly one product ID, unique bounded Node/browser evidence-ID arrays, and one
applicability value for each of `abi`, `kernel`, and `host`. Values are
`required`, `informational`, or `not-applicable`. A registration may omit one
host array but not both. It contains no Formula, package, URL, command, runner,
credential, or workflow field. It has at most 256 registrations and each host
array has at most 32 unique evidence IDs.

Both registries receive canonical generated JSON siblings. The Pages JSON has
exactly `schema`, `kind`, and an ID-sorted `products` array whose entries have
only `id` and `load`. The test JSON has exactly `schema`, `kind`, and a
product-ID-sorted `registrations` array; each registration has only `product`,
sorted unique `node` and `browser` arrays when present, and an `applicability`
object with exactly `abi`, `kernel`, and `host`. Each digest is SHA-256 over
its normalized object plus the canonical trailing line feed.

Pages products are always `required` for ABI, kernel, and host changes. Test
applicability may be narrower. When both registries select the same product,
selection retains all consumer/evidence reasons and uses the strongest
applicability in this order: `required`, `informational`, `not-applicable`.

### Selection and Formula-root derivation

`select_vfs_products(catalog, pages, tests, change_class)` returns ordered
`SelectedVfsProductV1` values. Each value records product ID, manifest path and
digest, effective applicability, selected evidence IDs, its exact direct
`product_inputs` edges with `embedded` or `lazy` materialization, and sorted
consumer reasons. A Pages reason includes registry path/digest and its exact
`eager` or `lazy` load; a test reason includes registry path/digest and selected
evidence. Recursion includes every required product input without flattening
or changing an edge's materialization. Product order is topological with ID as
the deterministic tie-breaker.

`derive_formula_requirements(catalog, selection)` walks only selected product
manifests and their composition graph. It returns one `FormulaRequirementV1`
per `(tap, formula, architecture)` with an ordered `uses` array of
`{ product_id, materialization }`. It does not read a Brewfile, package
manifest, build manifest, builder source, workflow matrix, shell array, or
staging-only list. Tap planning in Plan 3 owns transitive dependency resolution
and computes effective object materialization; the resolved-input envelope
then records both declared uses and the effective result.

### Resolved builder inputs and reports

`ResolvedVfsProductInputsV1` is canonical JSON containing:

- `schema = 1` and `kind = "kandelo-resolved-vfs-product-inputs"`;
- product ID, manifest path/digest, architecture, and output;
- target ABI and structural snapshot SHA-256;
- `build_environment = { policy_sha256, dev_shell_lock_sha256 }`, binding the
  protected build policy and repository-declared tool environment;
- `reference_class = "candidate"` or `"canonical"`;
- exact source repository, commit, and tree;
- a sorted input array whose tagged kinds are `product-image`,
  `homebrew-bottle`, `package-output`, `source-archive`,
  `toolchain-output`, or `repository-path`; and
- for each input, a stable input ID, role, declared/effective materialization,
  exact digest and byte count, plus an immutable reference, an explicitly
  supplied local path, or both as constrained below.

Candidate envelopes reject canonical references and canonical envelopes reject
candidate references. A local fixture reference has its own `local-fixture`
class and is accepted only by the miniature command.
An effective lazy input requires an immutable reference and forbids a local
path. An embedded or build-only input requires a regular nonsymlink local path
strictly below the caller-owned input root and may also retain its immutable
source reference. Paths outside that root, duplicate underlying files, and a
digest or byte-count mismatch fail before the builder starts. Each canonical
input or report document is at most 4 MiB and contains at most 4,096 inputs.

`VfsBuilderReportV1` is canonical JSON containing product and manifest
identity, the resolved-input document digest, exact output digest and byte
count, extracted output ABI metadata `{ version, snapshot_sha256 }`, and one
consumption entry for every resolved input. Consumption placement is
`embedded`, `lazy-reference`, or `build-only` and must match the resolved
effective materialization and role. The report also contains
`capture.complete` and a bounded
`capture.unreported_reads` array.

The validator accepts an ordinary build only when capture is complete,
`unreported_reads` is empty, and the consumed-input set is an exact one-to-one
match by ID, kind, digest, bytes, role, and placement. Missing or additional
inputs and materialization drift produce
`build_input_capture_incomplete`; identity mismatches produce
`source_identity_mismatch`. The ordinary CLI never accepts an override flag.
An exact override record is interpreted only by the protected policy layer
planned in Plan 3.

### Shared request and record models

`AbiStagingRequestV1` has exactly seven top-level logical sections and no
mutable status:

- `schema = 1` and `kind = "kandelo-abi-staging-request"`;
- `pull_request = { repository, number }`, naming the base repository and
  positive pull-request number;
- `build_source = { repository, commit, tree }`, naming the exact source
  repository, full lowercase commit SHA, and full lowercase tree SHA;
- `target_abi = { version, snapshot_sha256 }`, naming a nonnegative ABI and
  the canonical structural snapshot digest;
- `requirements = { digest, change_classes, products, registries, evidence }`,
  where product bindings contain ID/path/manifest digest, registry bindings
  contain kind/path/canonical digest, evidence contains selected product plus
  Node/browser IDs and applicability, and `digest` covers the normalized
  section without its own digest field;
- `issuance = { issuer_repository, issuer_workflow_ref, policy_version,
  policy_sha256, guard_registry_version, guard_registry_sha256,
  authorization }`, where authorization is exactly
  `{ mode = "same-repository", head }` or
  `{ mode = "fork-exact-sha", head, authorizing_comment_id }`; and
- `informational_context = { base_commit, base_tree, previous_abi,
  ref_hint }`, whose nullable values are retained for diagnostics and rejected
  as inputs to checkout, applicability, reuse, or promotion decisions.

The request excludes tap revision, resolved transitive dependencies,
background inventory, build graph, matrix, runner, retry, timeout,
concurrency, candidate state, custody objects, and timestamps. Current
applicability is the conjunction of exact `build_source.commit`, current
requirements digest, current policy digest/version, and current guard-registry
digest/version. Upload order, timestamp, ref hint, base commit, and lexical Git
SHA order are never consulted. The request asset name is exactly
`candidate-request-<full-head-sha>-sha256-<request-digest>.json`.

Every durable record has `schema`, a fixed `kind`, request digest, exact
subject, source and run provenance, guard-code array, and the orthogonal state
fields applicable to that record. Canonical bytes are hashed after validation;
the transport returns that record digest and referencing records bind it. A
record never embeds its own digest in the bytes being hashed. Record-specific
payloads are fixed as follows:

- `AttemptRecordV1`: Formula, architecture, bottle-contract digest, source
  capsule identity, runner/build facts, terminal outcome, retry ordinal,
  diagnostic references, and no candidate identity unless valid bytes exist.
- `CandidateRecordV1`: exact bottle-layer digest/bytes, Formula versioning,
  ABI, architecture, bottle contract, normalized component identities, direct
  dependency layer identities, custody digest, producer request/head/run, and
  `nonendorsed = true`. After the canonical record bytes are hashed and
  published, the transport returns a `PublishedRecordLocatorV1` containing the
  candidate record digest and immutable OCI reference. That locator is not a
  field of the record whose digest it names.
- `VerificationReceiptV1`: exact candidate digest, test-definition digest,
  kernel/host/VFS identities when applicable, outcome, attempt ordinal, and
  run provenance. A retry always creates another receipt.
- `ProductEvidenceRecordV1`: exact product manifest, selecting registry
  bindings, resolved Formula layers, VFS image/report, kernel and host
  identities, evidence definitions, and verification-receipt digests.
- `OverrideReceiptV1`: exact request and subject, accepted guard codes,
  maintainer identity and authorization, bounded justification, policy and
  guard-registry versions, exact candidate and bottle-layer identities, and an
  optional `CaptureOverrideAuthorizationV1` digest. The authorization is a
  separate immutable record naming the exact request, Formula, architecture,
  bottle contract, `build_input_capture_incomplete` guard, maintainer, and
  bounded justification; it contains no guessed artifact identity. After a
  successful authorized build, protected code emits a new immutable override
  receipt that binds the authorization to the actual candidate. Neither
  record is filled in or rewritten later.
- `AdmissionRecordV1`: promoted candidate layer, qualifying verification or
  override receipts, merged pull request and merge commit, tap source state,
  canonical reference/readback, Formula metadata update, and original producer
  identity.
- `DeletionRecordV1`: deleted candidate identity, reason, deletion time, and
  prior record references; it cannot name a canonical or admission-pinned
  layer.

Unknown record fields and unknown guard codes fail closed. Timestamps are audit
facts only. Identity, verification, override, admission, and deletion remain
separate records and cannot be collapsed into a single status document.
The shared orthogonal enums are exact: `work_state` is `pending`, `blocked`,
`queued`, `running`, or `complete`; a terminal `outcome` is `success`,
`failure`, `timeout`, `canceled`, or `skipped`; `artifact_class` is `none`,
`diagnostic`, `candidate`, or `canonical`; and `promotion_state` is `unknown`,
`eligible`, `ineligible`, `accepted_with_override`, `rebuild_required`, or
`promoted`. `retry_state` contains nonnegative `attempts`, Boolean `eligible`
and `exhausted`, `next_action` (`none`, `wait`, `retry`, or
`maintainer-action`), and a nullable audit-only `next_eligible_at`. Invariants
reject a terminal outcome before `complete`, success with blockers, an artifact
class without the corresponding identity, or promotion without admission.

## File Map

### Core commands and models

- Modify: `tools/xtask/src/main.rs`
- Create: `tools/xtask/src/abi_staging/mod.rs`
- Create: `tools/xtask/src/abi_staging/canonical_json.rs`
- Create: `tools/xtask/src/abi_staging/product_manifest.rs`
- Create: `tools/xtask/src/abi_staging/consumer_registry.rs`
- Create: `tools/xtask/src/abi_staging/selection.rs`
- Create: `tools/xtask/src/abi_staging/builder_contract.rs`
- Create: `tools/xtask/src/abi_staging/guard_registry.rs`
- Create: `tools/xtask/src/abi_staging/records.rs`
- Create: `tools/xtask/src/abi_staging/local_transport.rs`
- Create: `tools/xtask/src/abi_staging/mini_lifecycle.rs`

### Canonical products and generated interchange

- Create: `images/vfs/products/platform-rootfs.toml`
- Create: `images/vfs/products/browser-main-shell.toml`
- Create: `images/vfs/products/browser-node.toml`
- Create: `images/vfs/products/browser-nginx.toml`
- Create: `images/vfs/products/browser-nginx-php.toml`
- Create: `images/vfs/products/browser-wordpress.toml`
- Create: `images/vfs/products/browser-lamp.toml`
- Create: `images/vfs/products/browser-mariadb-wasm32.toml`
- Create: `images/vfs/products/browser-mariadb-wasm64.toml`
- Create: `images/vfs/products/browser-python.toml`
- Create: `images/vfs/products/browser-perl.toml`
- Create: `images/vfs/products/browser-redis.toml`
- Create: `images/vfs/products/browser-erlang.toml`
- Create: `images/vfs/products/developer-kandelo-sdk.toml`
- Create: `images/vfs/products/test-mariadb.toml`
- Create: `images/vfs/products/test-php.toml`
- Create: `images/vfs/products/test-sqlite.toml`
- Create: `images/vfs/products/generated/catalog.json`

### Consumer and policy registries

- Create: `apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.toml`
- Create: `apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.generated.json`
- Create: `tests/vfs-products.toml`
- Create: `tests/vfs-products.generated.json`
- Create: `abi/staging/guard-codes.toml`
- Create: `abi/staging/guard-codes.generated.json`
- Create: `abi/staging/legacy-vfs-adapters.toml`
- Create: `abi/staging/legacy-retirement.toml`

### Transitional consumers and builder boundary

- Modify: `scripts/check-homebrew-main-shell-brewfile.mjs`
- Modify: `scripts/test-homebrew-main-shell-closure.sh`
- Create: `scripts/vfs-product-catalog.mjs`
- Create: `scripts/vfs-product-catalog.test.mjs`
- Create: `scripts/check-pages-vfs-product-registry.mjs`
- Create: `scripts/check-pages-vfs-product-registry.test.mjs`
- Create: `images/vfs/scripts/vfs-product-builder-contract.ts`
- Create: `host/test/vfs-product-builder-contract.test.ts`
- Create: `scripts/run-vfs-product-builder.ts`
- Create: `scripts/run-vfs-product-builder.test.ts`

### Canonical and miniature fixtures

- Create: `tools/xtask/tests/fixtures/abi-staging/canonical/product.toml`
- Create: `tools/xtask/tests/fixtures/abi-staging/canonical/product.json`
- Create: `tools/xtask/tests/fixtures/abi-staging/canonical/pages.toml`
- Create: `tools/xtask/tests/fixtures/abi-staging/canonical/pages.json`
- Create: `tools/xtask/tests/fixtures/abi-staging/canonical/tests.toml`
- Create: `tools/xtask/tests/fixtures/abi-staging/canonical/tests.json`
- Create: `tools/xtask/tests/fixtures/abi-staging/mini-transition/transition.toml`
- Create: `tools/xtask/tests/fixtures/abi-staging/mini-transition/tap.toml`
- Create: `tools/xtask/tests/fixtures/abi-staging/mini-transition/products/mini-shell.toml`
- Create: `tools/xtask/tests/fixtures/abi-staging/mini-transition/products/mini-tools.toml`
- Create: `tools/xtask/tests/fixtures/abi-staging/mini-transition/pages.toml`
- Create: `tools/xtask/tests/fixtures/abi-staging/mini-transition/tests.toml`
- Create: `tools/xtask/tests/fixtures/abi-staging/mini-transition/sources/base.txt`
- Create: `tools/xtask/tests/fixtures/abi-staging/mini-transition/sources/tool.txt`
- Create: `images/vfs/scripts/build-abi-staging-mini-vfs.ts`
- Create: `host/test/abi-staging-mini-vfs.test.ts`
- Create: `scripts/test-abi-staging-mini-lifecycle.sh`

### CI routing and truthful documentation

- Modify: `.github/actions/detect-change-scope/ci-scope-paths.sh`
- Modify: `.github/actions/detect-change-scope/test-ci-scope-paths.sh`
- Create: `scripts/test-abi-staging-product-authority.sh`
- Modify: `docs/abi-versioning.md`
- Modify: `docs/package-management.md`
- Modify: `docs/browser-support.md`
- Modify: `docs/repository-organization.md`
- Modify: `docs/future-improvements.md`
- Create: `docs/superpowers/specs/2026-08-08-abi-bottle-staging-design.md`

---

### Task 1: Canonical JSON and the `abi-staging` command boundary

**Files:**

- Modify: `tools/xtask/src/main.rs`
- Create: `tools/xtask/src/abi_staging/mod.rs`
- Create: `tools/xtask/src/abi_staging/canonical_json.rs`

**Interfaces:**

- Consumes: existing `xtask` argument dispatch plus workspace `serde`,
  `serde_json`, and `sha2` dependencies.
- Produces: the canonical byte/digest functions and the nested
  `abi-staging` command boundary consumed by every later task.
- Add `xtask abi-staging <subcommand>` dispatch without changing existing
  subcommands.
- Add `canonical_json_bytes<T: Serialize>(&T) -> Result<Vec<u8>, String>` and
  `canonical_sha256<T: Serialize>(&T) -> Result<String, String>`.
- Add strict reusable validators for SHA-256, Git SHA, product/evidence IDs,
  repository-relative paths, absolute POSIX paths, and bounded strings.

  ```rust
  pub fn canonical_json_bytes<T: serde::Serialize>(value: &T)
      -> Result<Vec<u8>, String>;
  pub fn canonical_sha256<T: serde::Serialize>(value: &T)
      -> Result<String, String>;
  pub fn validate_sha256(value: &str) -> Result<(), String>;
  pub fn validate_git_sha(value: &str) -> Result<(), String>;
  pub fn validate_stable_id(value: &str, field: &str) -> Result<(), String>;
  pub fn validate_repo_path(root: &Path, value: &str) -> Result<PathBuf, String>;
  pub fn validate_absolute_posix_path(value: &str) -> Result<(), String>;
  ```

- [ ] **Step 1: Write failing canonicalization tests**

  Add unit tests beside `canonical_json.rs` for recursive key sorting, retained
  array order, UTF-8 strings, integer-only values, one trailing line feed, and
  stable SHA-256. Add rejection tests for floating-point JSON, noncanonical
  paths, uppercase IDs, unsafe path components, and over-limit strings.

- [ ] **Step 2: Run the focused tests and verify red**

  ```bash
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo test -p xtask --target "$host_target" abi_staging::canonical_json
  '
  ```

  Expected: FAIL because the module and functions do not exist.

- [ ] **Step 3: Implement canonical JSON and CLI dispatch**

  Normalize through `serde_json::Value`, reject numbers that are not signed or
  unsigned integers, recursively rebuild objects as `BTreeMap`, serialize with
  `serde_json::to_vec`, and append one line feed. Add `abi-staging` usage and
  subcommand routing in `main.rs`; an unknown nested subcommand exits with code
  2 and does not fall through to another `xtask` command.

- [ ] **Step 4: Run the focused tests and verify green**

  ```bash
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo test -p xtask --target "$host_target" abi_staging::canonical_json
    cargo run -p xtask --target "$host_target" --quiet -- abi-staging help
  '
  ```

  Expected: PASS; help lists only foundation subcommands.

- [ ] **Step 5: Commit**

  ```bash
  git add tools/xtask/src/main.rs \
    tools/xtask/src/abi_staging/mod.rs \
    tools/xtask/src/abi_staging/canonical_json.rs
  git commit -m "[ABI] Add canonical staging data boundary"
  ```

---

### Task 2: Parse, validate, and generate canonical product manifests

**Files:**

- Modify: `tools/xtask/src/abi_staging/mod.rs`
- Create: `tools/xtask/src/abi_staging/product_manifest.rs`
- Create: `tools/xtask/tests/fixtures/abi-staging/canonical/product.toml`
- Create: `tools/xtask/tests/fixtures/abi-staging/canonical/product.json`

**Interfaces:**

- Consumes: Task 1 canonical JSON, digest, path, and bounded-string helpers.
- Produces: strict product-manifest types, catalog loading, canonical catalog
  generation/checking, and the immutable manifest digest used downstream.
- Add the exact `VfsProductManifestV1`, `ProductCompositionV1`,
  `HomebrewSoftwareV1`, `PackageSoftwareV1`, `ArchiveSoftwareV1`,
  `ToolchainSoftwareV1`, `RepositoryInputV1`, `VfsMountIntentV1`,
  `VfsBootContractV1`, and `VfsEvidenceV1` types described above. Every
  deserialized struct uses `deny_unknown_fields`.
- Add `load_product_catalog(root, product_dir)` and
  `write_or_check_product_catalog(mode, source, output)`.
- Add CLI commands:
  `abi-staging products generate --source <dir> --out <file>` and
  `abi-staging products check --source <dir> --generated <file>`.

  ```rust
  pub fn load_product_catalog(
      repository_root: &Path,
      product_dir: &Path,
  ) -> Result<VfsProductCatalogV1, String>;

  pub enum CatalogWriteMode { Generate, Check }

  pub fn write_or_check_product_catalog(
      mode: CatalogWriteMode,
      repository_root: &Path,
      product_dir: &Path,
      output: &Path,
  ) -> Result<(), String>;
  ```

- [ ] **Step 1: Write the failing parser and catalog tests**

  The positive fixture must round-trip to the exact checked-in canonical JSON.
  Table-driven negative cases must reject an ABI field, Pages flag, candidate
  URL, command, retry, timeout, unknown field, duplicate Formula, duplicate
  product ID, duplicate architecture/output pair, missing root mount, unsafe
  path, invalid role/materialization combination, a toolchain command or
  unknown provider, missing builder, cyclic product graph, and
  cross-architecture product composition.

- [ ] **Step 2: Run the focused tests and verify red**

  ```bash
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo test -p xtask --target "$host_target" abi_staging::product_manifest
  '
  ```

  Expected: FAIL because the product model and generator are absent.

- [ ] **Step 3: Implement the strict product model**

  Implement syntax checks first, then whole-catalog checks for IDs, outputs,
  references, graph cycles, and architecture. Report every error with the
  normalized source path and field. Do not execute `builder`, inspect a package
  recipe for dependencies, or resolve a Formula while parsing inert data.

- [ ] **Step 4: Implement canonical generation and freshness checking**

  `generate` writes through a new sibling temporary file and renames only
  after complete serialization. `check` compares exact bytes and prints a
  regeneration command on drift. Refuse to replace a symlink or non-regular
  output. Unit tests use a temporary directory and verify that a failed
  generation leaves the prior complete file unchanged.

- [ ] **Step 5: Run focused tests and verify green**

  ```bash
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo test -p xtask --target "$host_target" abi_staging::product_manifest
  '
  ```

  Expected: PASS, including every negative case.

- [ ] **Step 6: Commit**

  ```bash
  git add tools/xtask/src/abi_staging/mod.rs \
    tools/xtask/src/abi_staging/product_manifest.rs \
    tools/xtask/tests/fixtures/abi-staging/canonical/product.toml \
    tools/xtask/tests/fixtures/abi-staging/canonical/product.json
  git commit -m "[VFS] Define canonical product manifests"
  ```

---

### Task 3: Define consumer registries and derive selected Formula roots

**Files:**

- Modify: `tools/xtask/src/abi_staging/mod.rs`
- Modify: `tools/xtask/src/abi_staging/product_manifest.rs` (share bounded
  regular-file and atomic-output helpers; give materialization values a stable
  ordering for canonical requirement uses)
- Create: `tools/xtask/src/abi_staging/consumer_registry.rs`
- Create: `tools/xtask/src/abi_staging/selection.rs`
- Create: `tools/xtask/tests/fixtures/abi-staging/canonical/pages.toml`
- Create: `tools/xtask/tests/fixtures/abi-staging/canonical/pages.json`
- Create: `tools/xtask/tests/fixtures/abi-staging/canonical/tests.toml`
- Create: `tools/xtask/tests/fixtures/abi-staging/canonical/tests.json`

**Interfaces:**

- Consumes: Task 2's validated `VfsProductCatalogV1` and canonical helpers.
- Produces: strict Pages/test registry models, selected products, and direct
  Formula requirements for tap planning without a second root list.
- Add exact `PagesProductRegistryV1`, `PagesProductV1`,
  `TestProductRegistryV1`, `TestProductRegistrationV1`, `ApplicabilityV1`,
  `ChangeClass`, `SelectedVfsProductV1`, `FormulaRequirementV1`, and
  `FormulaUseV1` types.
- Add CLI commands:
  `abi-staging registries generate`, `abi-staging registries check`, and
  `abi-staging requirements --change-class <abi|kernel|host>`.
- `requirements` accepts only catalog and registry paths and writes canonical
  selected-products and Formula-requirements JSON to caller-owned paths.

  ```rust
  pub fn select_vfs_products(
      catalog: &VfsProductCatalogV1,
      pages: &PagesProductRegistryV1,
      tests: &TestProductRegistryV1,
      change_class: ChangeClass,
  ) -> Result<Vec<SelectedVfsProductV1>, String>;

  pub fn derive_formula_requirements(
      catalog: &VfsProductCatalogV1,
      selection: &[SelectedVfsProductV1],
  ) -> Result<Vec<FormulaRequirementV1>, String>;
  ```

- [ ] **Step 1: Write failing registry tests**

  Cover exact TOML-to-JSON fixtures, duplicate entries, missing products,
  unknown products, empty evidence, invalid applicability, and unknown fields.
  Prove that adding `pages = true` to a product manifest fails while adding the
  product ID to the Pages registry succeeds.

- [ ] **Step 2: Write failing selection tests**

  Build an in-memory graph with an embedded base, a lazy whole-product input,
  an embedded Formula root, a lazy Formula root, and one Formula shared by an
  embedded dependency closure and a lazy root. Assert:

  - Pages selection is required for all three change classes;
  - test applicability is retained and strongest applicability wins;
  - composition dependencies are topologically included;
  - whole-product lazy intent remains lazy;
  - Formula uses retain every declared materialization without pretending the
    Kandelo-side selector knows the tap dependency closure;
  - Formula requirements are keyed only by tap, Formula, and architecture; and
  - changing a Brewfile-shaped string, package manifest, or builder string
    outside the catalog cannot change requirements.

- [ ] **Step 3: Run the focused tests and verify red**

  ```bash
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo test -p xtask --target "$host_target" \
      abi_staging::consumer_registry
    cargo test -p xtask --target "$host_target" abi_staging::selection
  '
  ```

  Expected: FAIL because registries and selection do not exist.

- [ ] **Step 4: Implement registries, selection, and Formula derivation**

  Keep selection pure and filesystem-independent after parsing. Sort consumer
  reasons and evidence IDs, topologically sort products, and retain every
  materialization use rather than flattening it to one Boolean. Do not derive
  or accept transitive Formula dependencies; Plan 3 obtains them from the tap.

- [ ] **Step 5: Run the focused tests and verify green**

  ```bash
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo test -p xtask --target "$host_target" \
      abi_staging::consumer_registry
    cargo test -p xtask --target "$host_target" abi_staging::selection
  '
  ```

  Expected: PASS with no staging Formula list accepted by any interface.

- [ ] **Step 6: Commit**

  ```bash
  git add tools/xtask/src/abi_staging/mod.rs \
    tools/xtask/src/abi_staging/product_manifest.rs \
    tools/xtask/src/abi_staging/consumer_registry.rs \
    tools/xtask/src/abi_staging/selection.rs \
    tools/xtask/tests/fixtures/abi-staging/canonical/pages.toml \
    tools/xtask/tests/fixtures/abi-staging/canonical/pages.json \
    tools/xtask/tests/fixtures/abi-staging/canonical/tests.toml \
    tools/xtask/tests/fixtures/abi-staging/canonical/tests.json
  git commit -m "[VFS] Select products through consumer registries"
  ```

---

### Task 4: Check in the complete current VFS product inventory

**Files:**

- Modify: `tools/xtask/src/abi_staging/product_manifest.rs`
- Create every file listed under **Canonical products and generated
  interchange** in the File Map.
- Create the Pages/test TOML and generated JSON files listed under **Consumer
  and policy registries**, plus `abi/staging/legacy-vfs-adapters.toml`. The
  guard and retirement files are handled in Task 7.

**Interfaces:**

- Consumes: Tasks 2–3 catalog/registry generators and the audited current
  builder, package, browser-import, and runtime-mount inputs listed below.
- Produces: the complete version-1 product inventory, mechanical legacy
  adapter map, consumer registries, and checked-in canonical JSON projections.

The manifest inventory is exact and contains these stable identities:

| Product ID | Architecture | Output | Transitional builder | Direct product/software roots |
|---|---|---|---|---|
| `platform-rootfs` | `wasm32` | `rootfs.vfs` | `packages/registry/rootfs/build-rootfs-package.sh` | repository rootfs tree plus `dash`, `bash`, `ncurses`, `coreutils`, `gawk`, `grep`, `sed`, `bc`, `file`, `m4`, `make`, `findutils`, `diffutils`, `posix-utils-lite` |
| `browser-main-shell` | `wasm32` | `shell.vfs.zst` | `scripts/build-homebrew-main-shell-product.sh` | embedded `bash`; lazy `dash`, `ncurses`, `coreutils`, `gawk`, `grep`, `sed`, `bc`, `file-formula`, `m4`, `make`, `findutils`, `diffutils`, `posix-utils-lite`, `fbdoom`, `modeset`, `less`, `tar`, `curl`, `netcat`, `wget`, `git`, `gzip`, `bzip2`, `xz`, `zstd`, `zip`, `unzip`, `lsof`, `nano`, `vim`, `nethack`, `ruby`; embedded `platform-rootfs` |
| `browser-node` | `wasm32` | `node-vfs.vfs.zst` | `images/vfs/scripts/build-node-vfs-image.sh` | embedded `browser-main-shell`, `node` output, and exact npm archive |
| `browser-nginx` | `wasm32` | `nginx.vfs.zst` | `images/vfs/scripts/build-nginx-vfs-image.sh` | embedded `browser-main-shell`, `nginx`, and `dinit` |
| `browser-nginx-php` | `wasm32` | `nginx-php.vfs.zst` | `images/vfs/scripts/build-nginx-php-vfs-image.sh` | embedded `browser-main-shell`, `nginx`, `php-fpm`, `opcache`, and `dinit`; build-only `kernel` |
| `browser-wordpress` | `wasm32` | `wordpress.vfs.zst` | `images/vfs/scripts/build-wp-vfs-image.sh` | embedded `browser-main-shell`, `nginx`, `php-fpm`, `opcache`, `dinit`, `msmtpd`, WordPress core archive, and SQLite integration archive; build-only `kernel` |
| `browser-lamp` | `wasm32` | `lamp.vfs.zst` | `images/vfs/scripts/build-lamp-vfs-image.sh` | embedded `browser-main-shell`, `mariadbd`, MariaDB system-table source role, `nginx`, `php-fpm`, `opcache`, `dinit`, `msmtpd`, and WordPress core archive; build-only `kernel` |
| `browser-mariadb-wasm32` | `wasm32` | `mariadb.vfs.zst` | `images/vfs/scripts/build-mariadb-vfs-image.sh` | embedded `mariadbd`, MariaDB system-table source role, `dash`, `coreutils`, and `dinit` |
| `browser-mariadb-wasm64` | `wasm64` | `mariadb-64.vfs.zst` | `images/vfs/scripts/build-mariadb-vfs-image.sh` | architecture-matched forms of the same MariaDB roots |
| `browser-python` | `wasm32` | `python.vfs.zst` | `images/vfs/scripts/build-python-vfs-image.sh` | embedded `cpython` executable and runtime output |
| `browser-perl` | `wasm32` | `perl.vfs.zst` | `images/vfs/scripts/build-perl-vfs-image.sh` | lazy `perl` executable plus embedded Perl standard-library source role |
| `browser-redis` | `wasm32` | `redis.vfs.zst` | `images/vfs/scripts/build-redis-vfs-image.sh` | embedded `redis-server` and `dinit` |
| `browser-erlang` | `wasm32` | `erlang.vfs.zst` | `images/vfs/scripts/build-erlang-vfs-image.sh` | embedded Erlang executable and OTP runtime output |
| `developer-kandelo-sdk` | `wasm32` | `kandelo-sdk.vfs.zst` | `images/vfs/scripts/build-kandelo-sdk-vfs-image.sh` | SDK/sysroot/glue repository inputs, compiler resource input, licenses, and `libcxx` |
| `test-mariadb` | `wasm32` | `mariadb-test.vfs.zst` | `images/vfs/scripts/build-mariadb-test-vfs-image.sh` | `mariadbd`, MariaDB test/source roles, `dash`, `coreutils`, and `dinit` |
| `test-php` | `wasm32` | `php-test.vfs.zst` | `images/vfs/scripts/build-php-test-vfs-image.sh` | embedded `platform-rootfs`, PHP executable/runtime outputs, PHP source role, and repository test fixtures |
| `test-sqlite` | `wasm32` | `sqlite-test.vfs.zst` | `images/vfs/scripts/build-sqlite-test-vfs-image.sh` | SQLite/Tcl source roles, generated test executables, `dash`, and `coreutils` |

Repository evidence found during execution requires these explicit, bounded
corrections to the table rather than an unsupported behavior change:

- `homebrew/main-shell.Brewfile` currently selects 32 roots and does not
  select `ruby`. The checked-in `browser-main-shell` manifest therefore
  captures those exact 32 roots. Adding Ruby remains follow-up work that must
  first update and prove the real shell selection and hosted product evidence.
- A clean checkout has no `sysroot/` directory, although the SDK builder
  consumes the generated sysroot. The SDK manifest records it as the explicit
  `repository-dev-shell` toolchain output `wasm32-sysroot`; checked-in SDK,
  glue, and license paths remain repository inputs. Validation continues to
  reject missing repository paths.
- Perl's executable is lazy while its standard-library source role is
  embedded. Multiple `software.package` entries for the same package are
  accepted only when their output and source-role claims are disjoint, so
  those two materialization decisions remain independently visible.

Use exact URLs and digests already owned by the corresponding package or
source helper. Moving those facts into the product manifest must not silently
change bytes or versions. Before authoring a manifest, freeze the builder's
observed input inventory as a failing fixture; any input outside the table is a
concrete plan/design discrepancy to report before changing this inventory,
not an invitation to leave it implicit or silently expand scope.

`abi/staging/legacy-vfs-adapters.toml` contains only `schema`, `kind`, and
mechanical adapter entries. Keeping it outside the product directory lets the
catalog generator consume every direct `images/vfs/products/*.toml` file with
no filename exception. A package adapter entry has exactly `product`,
`package`, `output`, `build_target`, and `mirror_filename`; a script-only
adapter entry has exactly `product` and `build_target`. It cannot contain a
dependency, Formula, source, ABI, materialization, Pages, test, or workflow
field. Product manifests remain the source of software roots; these adapter
fields only identify how an unchanged legacy caller reaches the declared
product output.

The initial Pages registry selects `platform-rootfs` and
`browser-main-shell` eagerly, and `browser-node`, `browser-nginx`,
`browser-nginx-php`, `browser-wordpress`, and `browser-lamp` lazily. The initial
test registry uses these exact stable evidence IDs:

| Product ID | Node evidence | Browser evidence |
|---|---|---|
| `platform-rootfs` | `rootfs-node-startup` | `rootfs-browser-startup` |
| `browser-main-shell` | `main-shell-startup` | `main-shell-basic-e2e`, `main-shell-fbdoom-e2e`, `main-shell-modeset-e2e` |
| `browser-node` | `node-vfs-node-startup` | `node-vfs-browser-startup` |
| `browser-nginx` | `nginx-vfs-node-startup` | `nginx-vfs-browser-startup` |
| `browser-nginx-php` | `nginx-php-vfs-node-startup` | `nginx-php-vfs-browser-startup` |
| `browser-wordpress` | `wordpress-sqlite-node-startup` | `wordpress-sqlite-browser-e2e` |
| `browser-lamp` | `wordpress-mariadb-node-startup` | `wordpress-mariadb-browser-e2e` |
| `browser-mariadb-wasm32` | `mariadb-wasm32-node-startup` | `mariadb-wasm32-browser-startup` |
| `browser-mariadb-wasm64` | `mariadb-wasm64-node-startup` | `mariadb-wasm64-browser-startup` |
| `browser-python` | `python-vfs-node-smoke` | `python-vfs-browser-smoke` |
| `browser-perl` | `perl-vfs-node-smoke` | `perl-vfs-browser-smoke` |
| `browser-redis` | `redis-vfs-node-startup` | `redis-vfs-browser-startup` |
| `browser-erlang` | `erlang-vfs-node-smoke` | `erlang-vfs-browser-smoke` |
| `developer-kandelo-sdk` | `kandelo-sdk-node-compile` | — |
| `test-mariadb` | `mariadb-suite-node` | `mariadb-suite-browser` |
| `test-php` | `php-suite-node` | `php-suite-browser` |
| `test-sqlite` | `sqlite-suite-node` | `sqlite-suite-browser` |

The em dash means the host array is omitted, not a placeholder. Pages
selection independently makes all Pages products required for ABI, kernel,
and host changes. The three test-suite products are required for all three
change classes. `developer-kandelo-sdk` is required for ABI changes and
informational for kernel and host changes. Non-Pages gallery/benchmark products
are informational until Plan 4 binds and proves their named test definitions;
the registry must not claim those tests already run in hosted staging.

- [ ] **Step 1: Add a failing inventory test**

  In `product_manifest.rs`, assert the exact product-ID set above, one manifest
  per ID, unique architecture/output pairs, and complete adapter coverage.
  For each mapped legacy VFS package, assert that its package/output pair is
  the adapter named by the corresponding product and that every VFS software
  input it consumes is represented by that product's composition or software
  entries. Treat dependencies internal to a declared package output as recipe
  implementation facts, never as extra VFS roots. Assert that the adapter file
  itself contains no dependency-bearing key.

- [ ] **Step 2: Run the inventory check and verify red**

  ```bash
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo test -p xtask --target "$host_target" \
      abi_staging::product_manifest::tests::repository_inventory
  '
  ```

  Expected: FAIL because no canonical product inventory exists.

- [ ] **Step 3: Author product and consumer TOML**

  Audit each named builder before writing its manifest. Preserve its current
  output name, architecture, VFS mount intent, boot intent, and effective lazy
  or embedded behavior. Record build-only inputs separately. Do not copy ABI
  values or resolved dependency closures from legacy package metadata.

- [ ] **Step 4: Generate canonical JSON**

  ```bash
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo run -p xtask --target "$host_target" --quiet -- \
      abi-staging products generate \
      --source images/vfs/products \
      --out images/vfs/products/generated/catalog.json
    cargo run -p xtask --target "$host_target" --quiet -- \
      abi-staging registries generate \
      --pages apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.toml \
      --pages-out apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.generated.json \
      --tests tests/vfs-products.toml \
      --tests-out tests/vfs-products.generated.json
  '
  ```

- [ ] **Step 5: Run inventory, freshness, and selection checks**

  ```bash
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo test -p xtask --target "$host_target" \
      abi_staging::product_manifest::tests::repository_inventory
    cargo run -p xtask --target "$host_target" --quiet -- \
      abi-staging products check \
      --source images/vfs/products \
      --generated images/vfs/products/generated/catalog.json
    cargo run -p xtask --target "$host_target" --quiet -- \
      abi-staging registries check \
      --catalog images/vfs/products/generated/catalog.json \
      --pages apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.toml \
      --pages-generated apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.generated.json \
      --tests tests/vfs-products.toml \
      --tests-generated tests/vfs-products.generated.json
  '
  ```

  Expected: PASS. The generated catalog contains no ABI number or remote
  candidate/canonical reference.

- [ ] **Step 6: Commit**

  ```bash
  git add tools/xtask/src/abi_staging/product_manifest.rs \
    images/vfs/products \
    abi/staging/legacy-vfs-adapters.toml \
    apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.toml \
    apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.generated.json \
    tests/vfs-products.toml tests/vfs-products.generated.json
  git commit -m "[VFS] Establish canonical product authority"
  ```

---

### Task 5: Make legacy selectors verifiable projections of product authority

**Files:**

- Modify: `scripts/check-homebrew-main-shell-brewfile.mjs`
- Modify: `scripts/test-homebrew-main-shell-closure.sh`
- Create: `scripts/vfs-product-catalog.mjs`
- Create: `scripts/vfs-product-catalog.test.mjs`
- Create: `scripts/check-pages-vfs-product-registry.mjs`
- Create: `scripts/check-pages-vfs-product-registry.test.mjs`

**Interfaces:**

- Consumes: Task 4's checked generated catalog, consumer registries, and
  mechanical adapter map plus the unchanged legacy source files named below.
- Produces: read-only JavaScript loaders and projection validators; no legacy
  selector or browser source is rewritten.
- `loadVfsProductCatalog(path)` strictly loads the checked-in generated
  catalog and exposes `productById(id)` plus `homebrewRoots(id)`.
- The main-shell checker compares the union of Brewfile `brew` declarations
  and `homebrew/main-shell-homebrew-runtime-support.json`'s
  `formula_roots[].package` with `browser-main-shell` Homebrew roots, then
  compares `embedded_roots` from the legacy materialization policy with the
  manifest. It explicitly ignores the runtime-support `base_formula_order`,
  `formula_order`, and other resolved-closure arrays: those are derived tap
  output, not roots to copy into the product. The checker contains no root
  array of its own. For this first-party MVP, the checker normalizes the
  existing Homebrew tap name `kandelo-dev/tap-core` to the manifest repository
  identity `kandelo-dev/homebrew-tap-core` with one constant assertion; it does
  not introduce a tap-mapping registry.
- The Pages checker compares registry IDs and load modes with the existing
  browser VFS source/import code. Eager products require a static import;
  lazy products require only `import.meta.glob` loaders. It derives artifact
  paths from architecture and product output. The single existing
  `@rootfs-vfs` alias is a checked mechanical projection of
  `platform-rootfs`; it cannot name another product or add one to Pages.
  The exact checked sources are
  `host/src/browser-kernel-default-artifacts.ts`,
  `apps/browser-demos/vite.config.ts`,
  `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts`, and
  `apps/browser-demos/pages/kandelo/kernel-host/optional-demo-vfs.ts`.
- The checker also compares every VFS-producing entry in `run.sh`'s legacy
  `BROWSER_DEPS` with the Pages registry and mechanical adapter registry. It
  permits non-VFS browser prerequisites but rejects an unregistered VFS target
  or a missing selected product. Thus `run.sh` remains unchanged behaviorally
  but cannot independently add or substitute a shipped VFS product.

  ```typescript
  export interface LoadedVfsProductCatalog {
    productById(id: string): Readonly<Record<string, unknown>>;
    homebrewRoots(id: string): readonly Readonly<{
      tap: string;
      formula: string;
      materialization: "embedded" | "lazy";
    }>[];
  }
  export interface MainShellProjectionPaths {
    catalogPath: string;
    brewfilePath: string;
    runtimeSupportPath: string;
    materializationPath: string;
  }
  export interface PagesProjectionPaths {
    catalogPath: string;
    registryPath: string;
    adapterPath: string;
    browserDepsPath: string;
    browserSources: readonly string[];
  }
  export declare function loadVfsProductCatalog(
    catalogPath: string,
  ): LoadedVfsProductCatalog;
  export declare function checkMainShellProjection(
    options: MainShellProjectionPaths,
  ): void;
  export declare function checkPagesVfsProductRegistry(
    options: PagesProjectionPaths,
  ): void;
  ```

- [ ] **Step 1: Write failing catalog-consumer tests**

  Test exact generated-catalog parsing, a missing product, unknown fields,
  duplicate IDs, and a tampered manifest digest. Add a source assertion that
  `scripts/check-homebrew-main-shell-brewfile.mjs` has no executable Formula
  root array.

- [ ] **Step 2: Add failing legacy-projection mutations**

  Extend `scripts/test-homebrew-main-shell-closure.sh` with mutations that add
  a Formula only to the Brewfile, add one only to runtime support, remove the
  embedded root, and change a manifest materialization. Each must fail with the
  product ID and mismatched root. Existing positive fixtures must remain
  valid.

- [ ] **Step 3: Add failing Pages-placement tests**

  Use temporary catalog, Pages registry, and TypeScript source fixtures. Prove
  rejection when a product attempts to add a Pages key to its own manifest,
  when an eager product is only globbed, when a lazy product is statically
  imported, when an output is absent, and when source code contains an
  unregistered VFS product. Mutate `BROWSER_DEPS` with one unregistered VFS
  target and remove one selected legacy build target; both must fail. Prove an
  unselected product cannot place itself on Pages.

- [ ] **Step 4: Run focused tests and verify red**

  ```bash
  scripts/dev-shell.sh npx tsx --test \
    scripts/vfs-product-catalog.test.mjs \
    scripts/check-pages-vfs-product-registry.test.mjs
  scripts/dev-shell.sh bash scripts/test-homebrew-main-shell-closure.sh
  ```

  Expected: FAIL because the catalog consumers and projection checks are not
  implemented.

- [ ] **Step 5: Implement read-only projection validation**

  Read only generated canonical JSON in JavaScript consumers. Keep the Rust
  freshness check as authority for its relationship to TOML. Do not rewrite
  legacy files during validation. Existing workflows may continue consuming
  the same Brewfile, locks, and browser imports, but a divergence from the new
  authority now fails CI.

- [ ] **Step 6: Run focused tests and existing regressions**

  ```bash
  scripts/dev-shell.sh npx tsx --test \
    scripts/vfs-product-catalog.test.mjs \
    scripts/check-pages-vfs-product-registry.test.mjs
  scripts/dev-shell.sh bash scripts/test-homebrew-main-shell-closure.sh
  scripts/dev-shell.sh bash -c '
    cd host
    npx vitest run \
      test/homebrew-vfs-materialization-policy.test.ts \
      test/optional-demo-vfs.test.ts \
      test/shell-lazy-archive-inputs.test.ts
  '
  ```

  Expected: PASS. Optional whole-VFS imports remain lazy and shell boot remains
  eager.

- [ ] **Step 7: Commit**

  ```bash
  git add scripts/check-homebrew-main-shell-brewfile.mjs \
    scripts/test-homebrew-main-shell-closure.sh \
    scripts/vfs-product-catalog.mjs \
    scripts/vfs-product-catalog.test.mjs \
    scripts/check-pages-vfs-product-registry.mjs \
    scripts/check-pages-vfs-product-registry.test.mjs
  git commit -m "[VFS] Verify legacy consumers against product authority"
  ```

---

### Task 6: Enforce exact resolved inputs at the builder boundary

**Files:**

- Modify: `tools/xtask/src/abi_staging/mod.rs`
- Create: `tools/xtask/src/abi_staging/builder_contract.rs`
- Create: `images/vfs/scripts/vfs-product-builder-contract.ts`
- Create: `host/test/vfs-product-builder-contract.test.ts`
- Create: `scripts/run-vfs-product-builder.ts`
- Create: `scripts/run-vfs-product-builder.test.ts`

**Interfaces:**

- Consumes: Tasks 1–4 canonical product identities and resolved selection
  output.
- Produces: strict resolved-input/report validators, an accessor-only builder
  API, and an uncredentialed fail-closed staging runner used by the miniature
  now and real builders in Plan 4.
- Add strict `ResolvedVfsProductInputsV1`, `ResolvedVfsInputV1`,
  `VfsBuilderReportV1`, `ConsumedVfsInputV1`, and `BuilderValidationV1` models.
- Add `abi-staging builder validate-inputs`,
  `abi-staging builder validate-report`, and
  `abi-staging builder compare-report` commands.
- Add TypeScript `openVfsProductBuild(inputsPath, reportPath)` returning
  `requireProductImage`, `requireHomebrewBottle`, `requirePackageOutput`,
  `requireSourceArchive`, `requireToolchainOutput`,
  `requireRepositoryPath`, and `finish(outputPath)`.
- Add `runVfsProductBuilder(options, dependencies)` as the only future staging
  entrypoint for a manifest's transitional builder.

  ```rust
  pub fn validate_resolved_inputs(
      canonical_bytes: &[u8],
      allowed_input_root: &Path,
  ) -> Result<ResolvedVfsProductInputsV1, String>;
  pub fn validate_builder_report(
      canonical_bytes: &[u8],
      allowed_report_root: &Path,
  ) -> Result<VfsBuilderReportV1, String>;
  pub fn compare_builder_report(
      inputs: &ResolvedVfsProductInputsV1,
      report: &VfsBuilderReportV1,
  ) -> Result<BuilderValidationV1, String>;
  ```

  ```typescript
  export type VfsProductInputHandle =
    | Readonly<{
        id: string;
        sha256: string;
        bytes: number;
        placement: "embedded" | "build-only";
        path: string;
      }>
    | Readonly<{
        id: string;
        sha256: string;
        bytes: number;
        placement: "lazy-reference";
        reference: string;
      }>;
  export interface VfsProductBuild {
    requireProductImage(id: string): VfsProductInputHandle;
    requireHomebrewBottle(id: string): VfsProductInputHandle;
    requirePackageOutput(id: string): VfsProductInputHandle;
    requireSourceArchive(id: string): VfsProductInputHandle;
    requireToolchainOutput(id: string): VfsProductInputHandle;
    requireRepositoryPath(id: string): VfsProductInputHandle;
    finish(outputPath: string): Promise<void>;
  }
  export declare function openVfsProductBuild(
    inputsPath: string,
    reportPath: string,
  ): Promise<VfsProductBuild>;
  export interface VfsProductBuilderOptions {
    manifestPath: string;
    inputsPath: string;
    reportPath: string;
    outputPath: string;
    workDir: string;
  }
  export interface VfsProductBuilderDependencies {
    launch(
      builderPath: string,
      args: readonly string[],
      env: Readonly<Record<string, string>>,
      cwd: string,
    ): Promise<Readonly<{ exitCode: number }>>;
    validateInputs(inputsPath: string): Promise<void>;
    compareReport(inputsPath: string, reportPath: string): Promise<void>;
  }
  export declare function runVfsProductBuilder(
    options: VfsProductBuilderOptions,
    dependencies: VfsProductBuilderDependencies,
  ): Promise<void>;
  ```

  Production construction supplies the real injected operations and tests
  supply fakes; neither interface exposes a resolver cache or override hook.

- [ ] **Step 1: Write failing Rust envelope/report tests**

  Cover exact positive canonical fixtures and rejection of unknown fields,
  duplicate input IDs, unsafe local paths, noncanonical references,
  candidate/canonical reference-class crossover, wrong target architecture,
  an undeclared toolchain output, missing/extra report input, digest or size
  mismatch, incomplete capture, nonempty unreported reads, wrong placement,
  wrong output name, wrong output ABI metadata, and a symlinked input or
  report.

- [ ] **Step 2: Write failing TypeScript contract tests**

  Construct a temporary envelope containing embedded, lazy-reference, and
  build-only inputs. Assert every accessor returns only its declared path,
  rejects another kind or ID, records exact consumption, never opens a lazy
  object's bytes, and refuses `finish` until every input has the required
  disposition. Assert `finish` writes no report after output validation fails.

- [ ] **Step 3: Write failing runner tests**

  Inject a fixture process launcher and assert the runner strips GitHub,
  package-registry, Homebrew, npm, and SSH credential variables; passes exact
  manifest/input/report/output paths; uses a new caller-owned work directory;
  rejects preexisting or symlinked outputs; and refuses success without a
  report accepted by the Rust validator. No test may depend on an ambient
  resolver cache.

- [ ] **Step 4: Run focused tests and verify red**

  ```bash
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo test -p xtask --target "$host_target" abi_staging::builder_contract
  '
  scripts/dev-shell.sh bash -c '
    cd host
    npx vitest run test/vfs-product-builder-contract.test.ts
  '
  scripts/dev-shell.sh npx tsx --test \
    scripts/run-vfs-product-builder.test.ts
  ```

  Expected: FAIL because the boundary does not exist.

- [ ] **Step 5: Implement the fail-closed contract**

  Validate canonical input bytes before exposing paths. Track accesses by
  stable input ID, not host path. `finish` hashes the exact output and writes
  the report atomically. The runner invokes the manifest's builder only after
  input validation and always runs report comparison afterward. It has no
  `--allow-incomplete`, `--ignore-extra`, or override option.

  Existing builders remain callable by legacy workflows in their current
  modes. Until a real builder is adapted in Plan 4, invoking it through the new
  staging runner fails because it does not emit the required report. This is a
  deliberate fail-closed boundary, not a fallback to legacy metadata.

- [ ] **Step 6: Run focused tests and verify green**

  ```bash
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo test -p xtask --target "$host_target" abi_staging::builder_contract
  '
  scripts/dev-shell.sh bash -c '
    cd host
    npx vitest run test/vfs-product-builder-contract.test.ts
  '
  scripts/dev-shell.sh npx tsx --test \
    scripts/run-vfs-product-builder.test.ts
  ```

  Expected: PASS. Tests prove undeclared software cannot be requested through
  the adapter and an incomplete or dishonest report cannot be admitted.

- [ ] **Step 7: Commit**

  ```bash
  git add tools/xtask/src/abi_staging/mod.rs \
    tools/xtask/src/abi_staging/builder_contract.rs \
    images/vfs/scripts/vfs-product-builder-contract.ts \
    host/test/vfs-product-builder-contract.test.ts \
    scripts/run-vfs-product-builder.ts \
    scripts/run-vfs-product-builder.test.ts
  git commit -m "[VFS] Fail closed on undeclared builder inputs"
  ```

---

### Task 7: Add the guard registry, durable record shapes, and retirement ledger

**Files:**

- Modify: `tools/xtask/src/abi_staging/mod.rs`
- Create: `tools/xtask/src/abi_staging/guard_registry.rs`
- Create: `tools/xtask/src/abi_staging/records.rs`
- Create: `abi/staging/guard-codes.toml`
- Create: `abi/staging/guard-codes.generated.json`
- Create: `abi/staging/legacy-retirement.toml`

**Interfaces:**

- Consumes: Task 1 canonical encoding/digests and Task 3 selected requirement
  identities.
- Produces: versioned guard policy, immutable request/record validators,
  exact request-asset naming, and a nonremovable legacy ledger for Plans 2–5.
- `GuardCodeRegistryV1` is versioned, append-only, rejects unknown codes, and
  contains the complete initial code set from the approved specification:
  `request_invalid`, `request_unauthorized`,
  `abi_structure_changed_without_bump`, `source_identity_mismatch`,
  `source_custody_mismatch`, `build_input_capture_incomplete`, `build_failed`,
  `build_timeout`, `transient_infrastructure_failure`,
  `candidate_integrity_mismatch`, `candidate_public_readback_failed`,
  `verification_failed`, `verification_timeout`, `dependency_unavailable`,
  `tap_source_drift`, `namespace_bootstrap_failed`, `policy_version_unknown`,
  and `pages_product_incomplete`.
- Each guard entry has exact `code`, `default_disposition`,
  `override_policy`, `recovery_policy`, and bounded `summary` fields.
  `override_policy` is `never`, `exact-subject-build-risk`, or
  `exact-artifact`; retry and repair are recovery paths, never mislabeled as
  identity overrides. `recovery_policy` is `none`, `rebuild`, `retry-policy`,
  `manual-retry-after-exhaustion`, `resolve-dependency`, `replan-rebuild`, or
  `repair-namespace`.

  | Guard code | Default disposition | Override policy | Recovery policy |
  |---|---|---|---|
  | `request_invalid` | `reject-request` | `never` | `none` |
  | `request_unauthorized` | `reject-request` | `never` | `none` |
  | `abi_structure_changed_without_bump` | `fail-check` | `never` | `none` |
  | `source_identity_mismatch` | `reject-build-or-publication` | `never` | `none` |
  | `source_custody_mismatch` | `reject-candidate-or-admission` | `never` | `none` |
  | `build_input_capture_incomplete` | `fail-before-build` | `exact-subject-build-risk` | `none` |
  | `build_failed` | `record-no-candidate` | `never` | `rebuild` |
  | `build_timeout` | `record-timeout` | `never` | `retry-policy` |
  | `transient_infrastructure_failure` | `schedule-retry` | `never` | `manual-retry-after-exhaustion` |
  | `candidate_integrity_mismatch` | `reject-candidate` | `never` | `none` |
  | `candidate_public_readback_failed` | `mark-ineligible` | `never` | `none` |
  | `verification_failed` | `mark-ineligible` | `exact-artifact` | `none` |
  | `verification_timeout` | `mark-ineligible` | `exact-artifact` | `retry-policy` |
  | `dependency_unavailable` | `block-dependants` | `never` | `resolve-dependency` |
  | `tap_source_drift` | `replan-affected-formula` | `never` | `replan-rebuild` |
  | `namespace_bootstrap_failed` | `block-publication` | `never` | `repair-namespace` |
  | `policy_version_unknown` | `reject-interpretation` | `never` | `none` |
  | `pages_product_incomplete` | `hold-last-complete-site` | `never` | `none` |

- Add strict types for `AbiStagingRequestV1`, `AttemptRecordV1`,
  `CandidateRecordV1`, `VerificationReceiptV1`, `ProductEvidenceRecordV1`,
  `CaptureOverrideAuthorizationV1`, `OverrideReceiptV1`, `AdmissionRecordV1`,
  and `DeletionRecordV1`. Each type carries the exact identities listed in the
  approved design and uses the shared orthogonal `work_state`, `outcome`,
  `artifact_class`, `promotion_state`, `retry_state`, and structured blocker
  fields.
- `candidate_request_asset_name(head, request_digest)` returns exactly
  `candidate-request-<full-head-sha>-sha256-<request-digest>.json` and its
  parser requires filename, canonical bytes, build-source commit, and request
  digest to agree.
- `legacy-retirement.toml` entries contain exact legacy path, current
  consumers, replacement component, required evidence IDs, and removal
  conditions. No entry may be marked removable in this plan.

  ```rust
  pub fn request_is_current(
      request: &AbiStagingRequestV1,
      exact_head: &str,
      requirements_sha256: &str,
      policy_version: u64,
      policy_sha256: &str,
      guard_registry_version: u64,
      guard_registry_sha256: &str,
  ) -> bool;
  pub fn candidate_request_asset_name(
      head: &str,
      request_digest: &str,
  ) -> Result<String, String>;
  pub fn parse_candidate_request_asset(
      filename: &str,
      canonical_request_bytes: &[u8],
  ) -> Result<AbiStagingRequestV1, String>;
  pub fn validate_record(record: &AbiStagingRecordV1) -> Result<(), String>;
  ```

  `AbiStagingRecordV1` is the closed tagged enum containing the eight durable
  record variants named above, including the separate capture authorization;
  no open `serde_json::Value` payload is accepted.

  Its initial Kandelo entries cover
  `.github/workflows/reusable-homebrew-bottle-publish.yml`,
  `.github/workflows/reusable-homebrew-bottle-maintenance.yml`,
  `.github/workflows/reusable-homebrew-closed-selection-publish.yml`,
  `.github/workflows/homebrew-main-shell-ci.yml`,
  `.github/workflows/homebrew-experimental-vfs-publish.yml`,
  `.github/workflows/reusable-homebrew-main-shell-mirror-publish.yml`,
  `.github/workflows/homebrew-native-publisher-compatibility.yml`,
  `.github/workflows/browser-demos-pages.yml`,
  `scripts/deploy-gh-pages.sh`, `homebrew/main-shell.Brewfile`, all
  of `homebrew/main-shell-migration-lock.json`,
  `homebrew/main-shell-selection-lock.json`,
  `homebrew/main-shell-lazy-artifact-lock.json`,
  `homebrew/main-shell-brew-package-tree.json`,
  `homebrew/main-shell-homebrew-runtime-support.json`, and
  `homebrew/main-shell-materialization-policy.json`, the Homebrew root arrays
  in current scripts, the `run.sh` browser dependency array,
  `images/vfs/scripts/build-shell-vfs-image.sh`,
  `images/vfs/scripts/build-shell-vfs-image.ts`,
  `images/vfs/scripts/build-source-rootfs-shell-image.ts`, and
  `homebrew/source-rootfs-shell-package/`. Its read-only tap entries cover
  `.github/workflows/selection-checks.yml`,
  `.github/workflows/dry-run-bottles.yml`,
  `.github/workflows/maintain-bottles.yml`,
  `.github/workflows/publish-bottles.yml`, and
  `.github/workflows/publish-main-shell-mirror.yml` in
  `kandelo-dev/homebrew-tap-core`.

  The ledger also inventories every package-registry entry whose primary
  product is a VFS image, including the current rootfs, shell, service,
  language-runtime, SDK, and VFS test wrappers. Each wrapper remains present
  and usable during rollout, but its removal condition requires all consumers
  to use the canonical product manifest and product-specific build adapter
  directly. Ordinary software recipes consumed by those products are not
  retirement entries.

- [ ] **Step 1: Write failing guard-registry tests**

  Assert the exact initial code set, unknown-code rejection, unique meanings,
  valid override policy, generated freshness, and append-only comparison.
  Mutating an existing meaning or deleting a code must fail; appending a new
  well-formed code may pass only with a registry-version increment.

- [ ] **Step 2: Write failing record-invariant tests**

  Cover every contradictory state pair, candidate-without-bytes,
  success-with-blockers, promotion-without-admission, malformed exact subject,
  override of a never-overrideable guard, pre-build capture authorization
  without exact request/Formula/architecture/contract, mutation of that
  authorization after publication, and post-build override receipt without an
  exact candidate digest or authorization reference. Prove timestamps and
  lexical commit ordering cannot decide current applicability.

- [ ] **Step 3: Write failing request-name tests**

  Cover a valid full head, same-head policy reissuance with a different request
  digest, an older exact head that remains valid historical work, short SHA,
  wrong filename head, wrong filename digest, uppercase hex, mutable latest
  aliases, and timestamp-based selection.

- [ ] **Step 4: Write the failing retirement inventory test**

  Require entries for the existing Homebrew publish/maintenance workflows,
  experimental VFS workflow, main-shell workflow, package staging exclusions,
  Brewfile and lock selectors, `run.sh` browser dependency array, Pages
  workflow, local Pages deploy script, and tap-side selection/publish callers.
  Every entry must have nonempty consumers, replacement, evidence, and removal
  conditions and `removable = false`.

- [ ] **Step 5: Run focused tests and verify red**

  ```bash
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo test -p xtask --target "$host_target" \
      abi_staging::guard_registry
    cargo test -p xtask --target "$host_target" abi_staging::records
  '
  ```

  Expected: FAIL because registries and record types are absent.

- [ ] **Step 6: Implement strict records and canonical guard generation**

  Make factual identity fields mandatory even when an outcome is failure.
  Represent absent artifacts explicitly as `artifact_class = "none"`; do not
  invent zero digests. Keep source identity, verification, and admission as
  separate records. Implement request-name parsing without any current-head
  lookup; Plan 2 supplies protected current policy and head inputs.

- [ ] **Step 7: Populate the retirement ledger**

  Name the observed Kandelo paths and the read-only tap paths from the audit.
  For cross-repository entries, record repository plus path. State that a
  complete real transition, required product/Pages evidence, independent
  promotion, protected prior-ABI repair, consumer audit, complete retained
  source custody, and failure/recovery evidence are all required before
  removal.

- [ ] **Step 8: Run focused tests and verify green**

  ```bash
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo test -p xtask --target "$host_target" \
      abi_staging::guard_registry
    cargo test -p xtask --target "$host_target" abi_staging::records
    cargo run -p xtask --target "$host_target" --quiet -- \
      abi-staging guard-codes check \
      --source abi/staging/guard-codes.toml \
      --generated abi/staging/guard-codes.generated.json
  '
  ```

  Expected: PASS, with every legacy entry still nonremovable.

- [ ] **Step 9: Commit**

  ```bash
  git add tools/xtask/src/abi_staging/mod.rs \
    tools/xtask/src/abi_staging/guard_registry.rs \
    tools/xtask/src/abi_staging/records.rs \
    abi/staging/guard-codes.toml \
    abi/staging/guard-codes.generated.json \
    abi/staging/legacy-retirement.toml
  git commit -m "[ABI] Define staging records and guard policy"
  ```

---

### Task 8: Build the complete local generic transition miniature

**Files:**

- Modify: `tools/xtask/src/abi_staging/mod.rs`
- Create: `tools/xtask/src/abi_staging/local_transport.rs`
- Create: `tools/xtask/src/abi_staging/mini_lifecycle.rs`
- Create all files listed under **Canonical and miniature fixtures** in the
  File Map that were not created by Tasks 1–3.
- Create: `images/vfs/scripts/build-abi-staging-mini-vfs.ts`
- Create: `host/test/abi-staging-mini-vfs.test.ts`
- Create: `scripts/test-abi-staging-mini-lifecycle.sh`

**Interfaces:**

- Consumes: Tasks 1–7 canonical models, product selection, builder boundary,
  guards, and immutable records plus the existing VFS implementation.
- Produces: a digest-addressed fake transport, real miniature VFS builder, and
  deterministic local `N` to `N + 1` lifecycle used as the foundation
  integration proof.
- `abi-staging mini run --fixture <dir> --work <new-dir>` consumes source and
  target ABI values from `transition.toml`; it validates that target equals
  source plus one. Reusable code has no built-in ABI value.
- `LocalContentAddressedTransport` has separate `candidate`, `canonical`, and
  `source` roots, writes by SHA-256 with no-clobber semantics, and supports a
  fresh anonymous read-only handle.
- `build-abi-staging-mini-vfs.ts` consumes only a canonical manifest and
  resolved-input envelope through the Task 6 API. It embeds the declared eager
  bytes, writes a content-addressed lazy reference without fetching its bytes,
  saves a real VFS image, restores it, verifies seals/metadata, and emits an
  exact builder report.
- The mini transition writes canonical request, attempt, candidate,
  verification, product-evidence, admission, and Pages-readiness records into
  its work directory. These are fixture outputs, not remote publication.

  ```rust
  pub fn deterministic_retry_delay_ms(
      request_digest: &str,
      exact_subject: &str,
      retry_number: u8,
      base_ms: u64,
      cap_ms: u64,
  ) -> Result<u64, String>;
  pub fn run_mini_lifecycle(
      fixture_dir: &Path,
      new_work_dir: &Path,
  ) -> Result<MiniLifecycleSummaryV1, String>;
  ```

  `MiniLifecycleSummaryV1` contains source/target ABI, request digest, required
  and background subjects, candidate/canonical layer and VFS digests, source
  history identity, Pages result, and ordered record digests. It contains no
  wall-clock-derived identity.

- [ ] **Step 1: Write failing local-transport tests**

  Assert digest-addressed write/read, candidate/canonical namespace
  separation, anonymous readback, identical-byte idempotence, collision
  rejection, no symlink traversal, and unchanged prior object after an
  interrupted temporary write.

- [ ] **Step 2: Write failing miniature-VFS tests**

  Build a tiny image with one embedded layer and one lazy layer. Restore it and
  assert embedded bytes exist, lazy bytes do not, the lazy reference contains
  exact digest/size/reference class, and the report accounts for both inputs.
  Recompose with canonical references and assert bottle-layer digests stay
  identical while candidate and canonical VFS image digests differ.

- [ ] **Step 3: Write the failing lifecycle harness**

  The shell harness must assert this ordered behavior:

  1. generate and validate an exact-head request from current fixture policy;
  2. derive required Formula roots only from selected products;
  3. let the fake tap derive dependencies and a separate background Formula;
  4. build one candidate and reuse one exact unchanged candidate;
  5. capture and publish exact source bytes into the fake source namespace;
  6. publish candidates through a protected inert-copy simulation;
  7. verify them through a fresh anonymous reader;
  8. build, restore, and test the candidate miniature VFS;
  9. mark the required product ready even when the unrelated background
     Formula is still pending, and keep the background item reconcilable;
  10. create, protect in the fixture policy, and verify the source `abi/N`
      history before allowing successor promotion;
  11. simulate merge and independent canonical promotion;
  12. preserve the source `abi/N` fixture tree byte-for-byte;
  13. recompose the final VFS with canonical references and unchanged bottle
      layer digests;
  14. hold a new Pages inventory when one required product is absent while
      retaining the prior complete site; and
  15. atomically replace the prior site only when the complete inventory is
      ready.

  Add negative runs for incomplete input capture, an override for the wrong
  exact subject, a deterministic application failure incorrectly labeled
  transient, stale current-policy digest, missing or unverified source
  `abi/N` history before promotion, and a synthetic merge commit used as build
  source. They fail respectively with `build_input_capture_incomplete`,
  `request_unauthorized`, `build_failed`, `policy_version_unknown`,
  `namespace_bootstrap_failed`, and `source_identity_mismatch`.

- [ ] **Step 4: Run focused tests and verify red**

  ```bash
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo test -p xtask --target "$host_target" \
      abi_staging::local_transport
    cargo test -p xtask --target "$host_target" \
      abi_staging::mini_lifecycle
  '
  scripts/dev-shell.sh bash -c '
    cd host
    npx vitest run test/abi-staging-mini-vfs.test.ts
  '
  scripts/dev-shell.sh bash scripts/test-abi-staging-mini-lifecycle.sh
  ```

  Expected: FAIL because the miniature does not exist.

- [ ] **Step 5: Implement local transport and fixture planning**

  The fake tap fixture declares two required Formulae in dependency order and
  one unrelated background Formula. It is inert TOML, not Ruby execution. The
  miniature may model future tap decisions, but the production tap parser and
  scheduler remain Plan 3 work.

- [ ] **Step 6: Implement the real miniature VFS and report**

  Use `MemoryFileSystem`, `saveImage`, and existing restore/seal validation.
  Do not emulate a VFS with an ordinary directory or JSON marker. Pass all
  bytes through declared input accessors. The test opens the candidate lazy
  reference through the fake candidate namespace and the final lazy reference
  through the fake canonical namespace.

- [ ] **Step 7: Implement lifecycle orchestration without runner sleeps**

  Retry scheduling numbers retries `1` through `3`, accepts caller-supplied
  base and cap windows, and computes deterministic full jitter from SHA-256 of
  request digest, NUL, exact subject identity, NUL, and retry number. Define
  `window_ms = min(cap_ms, base_ms * 2^(retry_number - 1))`; interpret the first
  eight digest bytes as an unsigned big-endian integer and set
  `delay_ms = integer mod (window_ms + 1)`, yielding the closed interval
  `[0, window_ms]`. Record `next_eligible_at` and return. The miniature
  simulates exactly three retries after the initial attempt by advancing its
  fixture clock; it never sleeps.

- [ ] **Step 8: Run the complete miniature twice**

  ```bash
  scripts/dev-shell.sh bash scripts/test-abi-staging-mini-lifecycle.sh
  scripts/dev-shell.sh bash scripts/test-abi-staging-mini-lifecycle.sh
  ```

  Expected: both runs PASS in fresh temporary directories and produce the same
  canonical identities. The second invocation does not rely on state from the
  first.

- [ ] **Step 9: Run focused regression tests**

  ```bash
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo test -p xtask --target "$host_target" abi_staging
  '
  scripts/dev-shell.sh bash -c '
    cd host
    npx vitest run \
      test/abi-staging-mini-vfs.test.ts \
      test/lazy-vfs.test.ts \
      test/homebrew-vfs-formula-layer.test.ts \
      test/vfs-image.test.ts
  '
  ```

  Expected: PASS. Existing lazy layer and VFS serialization behavior remains
  unchanged.

- [ ] **Step 10: Commit**

  ```bash
  git add tools/xtask/src/abi_staging/mod.rs \
    tools/xtask/src/abi_staging/local_transport.rs \
    tools/xtask/src/abi_staging/mini_lifecycle.rs \
    tools/xtask/tests/fixtures/abi-staging/mini-transition \
    images/vfs/scripts/build-abi-staging-mini-vfs.ts \
    host/test/abi-staging-mini-vfs.test.ts \
    scripts/test-abi-staging-mini-lifecycle.sh
  git commit -m "[ABI] Prove a local generic staging transition"
  ```

---

### Task 9: Route foundation checks and document only implemented status

**Files:**

- Modify: `.github/actions/detect-change-scope/ci-scope-paths.sh`
- Modify: `.github/actions/detect-change-scope/test-ci-scope-paths.sh`
- Create: `scripts/test-abi-staging-product-authority.sh`
- Modify: `docs/abi-versioning.md`
- Modify: `docs/package-management.md`
- Modify: `docs/browser-support.md`
- Modify: `docs/repository-organization.md`
- Modify: `docs/future-improvements.md`
- Create: `docs/superpowers/specs/2026-08-08-abi-bottle-staging-design.md`

**Interfaces:**

- Consumes: every foundation command, fixture, registry, checker, and test
  entrypoint produced by Tasks 1–8.
- Produces: effect-based CI routing, one local foundation validation command,
  the restored approved design file, and truthful reference documentation.
- `scripts/test-abi-staging-product-authority.sh` is the single cheap
  foundation validation entrypoint. It runs canonical freshness, registry
  selection, guard/retirement validation, JavaScript projection tests, builder
  contract tests, and the local miniature.
- Change-scope routing sends `images/vfs/products/`, consumer registries,
  `abi/staging/`, the new `xtask` modules, and the foundation test script to
  ABI/package/browser validation as their effects require. It does not route
  them to a credentialed publisher.
- Reference docs describe the checked-in authority and local-only evidence,
  then explicitly list remote issuance, tap execution, candidate publication,
  PR Checks, promotion, ABI history, and atomic Pages integration as not yet
  operational.

- [ ] **Step 1: Write failing path-routing assertions**

  Add exact positive cases for a product manifest, Pages registry, test
  registry, guard registry, and `tools/xtask/src/abi_staging/selection.rs`.
  Add negative assertions that documentation-only plan changes do not schedule
  package builds and that no new path reaches an existing credentialed
  Homebrew publisher by special case.

- [ ] **Step 2: Write the foundation validation script first**

  Make it fail immediately because the docs have not yet declared the
  foundation status and deferred boundaries. It must locate every command and
  file relative to the repository root, reject arguments, and use no host tool
  outside the dev shell.

- [ ] **Step 3: Run routing and foundation checks and verify red**

  ```bash
  scripts/dev-shell.sh bash \
    .github/actions/detect-change-scope/test-ci-scope-paths.sh
  scripts/dev-shell.sh bash scripts/test-abi-staging-product-authority.sh
  ```

  Expected: FAIL on new path routing and missing documentation assertions.

- [ ] **Step 4: Implement effect-based routing**

  Extend existing anchored path expressions; do not add a second change-scope
  action or a broad `.github/` wildcard. Preserve the documented frozen
  Homebrew publisher exceptions.

- [ ] **Step 5: Update authoritative docs truthfully**

  Restore
  `docs/superpowers/specs/2026-08-08-abi-bottle-staging-design.md`
  byte-for-byte from final approved commit
  `6e1b7ff24e544463d6f9c5f6b7fb67a873e1337a`; do not reconstruct or edit the
  settled design while moving it from the disconnected documentation history
  into the implementation branch.

  Document:

  - product TOML and generated JSON ownership;
  - consumer-owned Pages/test registries;
  - legacy package/build metadata as checked transitional projections;
  - the builder resolved-input/report boundary;
  - lazy whole-VFS and lazy package-layer preservation;
  - the local miniature's exact claim; and
  - the fact that no hosted staging or deployment behavior changes in this
    foundation.

  Merge only the approved staging-specific future-work sections for semantic
  ABI modeling, complete external-source custody, and ABI-matched man pages
  into the current `docs/future-improvements.md`. Preserve all newer current
  entries and wording outside those additions.

- [ ] **Step 6: Run routing, docs, and foundation validation**

  ```bash
  scripts/dev-shell.sh bash \
    .github/actions/detect-change-scope/test-ci-scope-paths.sh
  scripts/dev-shell.sh bash scripts/test-abi-staging-product-authority.sh
  scripts/dev-shell.sh npm run docs:build
  ```

  Expected: PASS. Documentation says the remote system is not operational.

- [ ] **Step 7: Commit**

  ```bash
  git add .github/actions/detect-change-scope/ci-scope-paths.sh \
    .github/actions/detect-change-scope/test-ci-scope-paths.sh \
    scripts/test-abi-staging-product-authority.sh \
    docs/abi-versioning.md docs/package-management.md \
    docs/browser-support.md docs/repository-organization.md \
    docs/future-improvements.md \
    docs/superpowers/specs/2026-08-08-abi-bottle-staging-design.md
  git commit -m "[ABI] Document the inert staging foundation"
  ```

---

### Task 10: Final foundation verification and plan-to-diff audit

**Files:**

- Verify every file in this plan; do not add an implementation file that is
  absent from the File Map without first updating the plan and explaining the
  repository evidence that required it.

**Interfaces:**

- Consumes: the complete committed output of Tasks 1–9 and the unchanged
  `origin/main` baseline.
- Produces: fresh command evidence for only the foundation exit criteria and
  a file/commit-scope audit suitable for review; it produces no code or remote
  state.

- [ ] **Step 1: Verify the worktree boundary**

  ```bash
  scripts/dev-shell.sh bash -c '
    git status --short --branch
    git diff --check origin/main...HEAD
    git diff --name-only origin/main...HEAD
  '
  ```

  Confirm `tests/sortix/os-test` and `.serena/` remain uncommitted and absent
  from every foundation commit.

- [ ] **Step 2: Run the complete foundation suite**

  ```bash
  scripts/dev-shell.sh bash scripts/test-abi-staging-product-authority.sh
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo test -p xtask --target "$host_target" abi_staging
  '
  scripts/dev-shell.sh npx tsx --test \
    scripts/vfs-product-catalog.test.mjs \
    scripts/check-pages-vfs-product-registry.test.mjs \
    scripts/run-vfs-product-builder.test.ts
  scripts/dev-shell.sh bash -c '
    cd host
    npx vitest run \
      test/vfs-product-builder-contract.test.ts \
      test/abi-staging-mini-vfs.test.ts \
      test/homebrew-vfs-materialization-policy.test.ts \
      test/optional-demo-vfs.test.ts \
      test/shell-lazy-archive-inputs.test.ts \
      test/lazy-vfs.test.ts \
      test/homebrew-vfs-formula-layer.test.ts \
      test/vfs-image.test.ts
  '
  scripts/dev-shell.sh bash scripts/ci-check-browser-assets.sh
  scripts/dev-shell.sh npm run docs:build
  ```

  Expected: PASS. This supports only the local product-authority and miniature
  claims, not hosted GitHub, registry, Check, promotion, or Pages behavior.

- [ ] **Step 3: Run ABI and workflow safety checks**

  ```bash
  scripts/dev-shell.sh bash scripts/check-abi-version.sh
  scripts/dev-shell.sh bash -c '
    ruby scripts/check-homebrew-publish-workflow-trust.rb
    ruby scripts/check-homebrew-experimental-vfs-workflow.rb
    ruby scripts/check-homebrew-closed-selection-workflow.rb
    actionlint
  '
  ```

  Expected: PASS. No ABI snapshot changes are expected, and no existing
  workflow authority or action reference changes.

- [ ] **Step 4: Audit genericity, authority, and placeholders**

  ```bash
  scripts/dev-shell.sh bash -c '
    if rg -n -i "abi[-_ ]?4[23]|integration/abi4[23]" \
      tools/xtask/src/abi_staging images/vfs/products abi/staging \
      scripts/test-abi-staging-mini-lifecycle.sh; then
      echo "concrete ABI fixture leaked into generic infrastructure" >&2
      exit 1
    fi
    if rg -n "TO""DO|TB""D|FIX""ME|CHANGE""_ME" \
      tools/xtask/src/abi_staging images/vfs/products abi/staging \
      apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.toml \
      tests/vfs-products.toml; then
      echo "unfinished placeholder remains" >&2
      exit 1
    fi
    rg -n "VfsProductManifestV1|PagesProductRegistryV1|TestProductRegistryV1|ResolvedVfsProductInputsV1|VfsBuilderReportV1|FormulaRequirementV1" \
      tools/xtask/src/abi_staging
  '
  ```

  Manually confirm each public type name matches this plan, every selected
  Formula originates in a product manifest, Pages placement originates only in
  its consumer registry, lazy intent survives selection and builder reports,
  and all negative tests named in Tasks 2, 3, 6, 7, and 8 exist.

- [ ] **Step 5: Review commit scope and stop**

  ```bash
  scripts/dev-shell.sh bash -c '
    git log --format=fuller --stat origin/main..HEAD
    git diff --stat origin/main...HEAD
  '
  ```

  Do not add request-release workflows, tap writers, package publication,
  candidate OCI writes, Check updates, promotion, ABI-branch mutation, Pages
  deployment, or legacy deletion. Those begin only after review of this plan
  and the separately written Plan 2.

## Foundation Exit Criteria

- Canonical TOML and generated JSON cover every inventoried VFS builder.
- Pages and test consumers select products without copying software roots.
- Formula requirements derive only from selected product manifests.
- Embedded and lazy intent survives selection, resolution, build reporting,
  miniature composition, and candidate-to-canonical recomposition.
- The builder boundary rejects missing, extra, mismatched, or incompletely
  captured software inputs.
- The guard registry and durable records reject contradictory or unauthorized
  states.
- The local miniature proves a complete generic successor transition,
  including source custody, public-style anonymous readback, independent
  promotion, prior-ABI preservation, and last-complete Pages behavior.
- Existing hosted workflows and supported user behavior are unchanged.
- Every legacy component remains present and nonremovable in the retirement
  ledger.
- Every obsolete VFS-wrapper package entry and the main-shell Brewfile has an
  explicit future removal condition, while ordinary software recipes remain
  outside that retirement set.
- Documentation describes only the implemented local foundation and keeps
  semantic ABI modeling, complete external-source custody, and man pages as
  explicit future work.

After these criteria are met, execute the separately reviewed Plan 2 for the
exact-head request feed and reconciliation. Do not begin Plan 2 implementation
in the same change.
