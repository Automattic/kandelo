# Generic ABI Bottle Staging: Implementation Roadmap

> **Junior-review edition:** The complete command-level roadmap and all five
> implementation plans are preserved in docs-only commit `0153a8863`. This
> edition explains the same design in plainer language for review. During
> implementation, use the preserved task details together with any review
> changes approved against this edition.

**Status:** Ready for review. This is a documentation plan. Production
implementation has not started.

**Approved design:**
`docs/superpowers/specs/2026-08-08-abi-bottle-staging-design.md` from commit
`6e1b7ff24e544463d6f9c5f6b7fb67a873e1337a`.

**Repositories:** `Automattic/kandelo` and
`kandelo-dev/homebrew-tap-core`.

## Start here

Kandelo needs a safe way to prepare software for a new Application Binary
Interface (ABI) before the ABI-changing pull request merges. We call that
software a *candidate*. A candidate is public so it can be tested, but public
does not mean trusted or approved.

The complete system is too large for one implementation plan. It is split
into five plans that build on each other:

1. define which VFS products exist and what software they contain;
2. issue an immutable request for an exact pull-request head;
3. build, publish, and verify candidate bottles safely;
4. build candidate VFS products and report one exact-head pull-request Check;
5. promote approved bottle layers, publish Pages atomically, and retire old
   infrastructure only when evidence permits it.

Writing all five plans now lets us review shared names and trust boundaries
once. It does not authorize a workflow to bypass a missing repository rule,
credential, public artifact, or hosted test.

## Small glossary

- **ABI:** The binary contract between a Kandelo program, kernel, and host.
- **ABI `N → N + 1`:** A generic transition from one ABI version to its
  immediate successor. Reusable code must never assume particular numbers.
- **Bottle:** A prebuilt Homebrew package archive.
- **Bottle layer:** The exact immutable bytes of one bottle stored in OCI.
- **VFS product:** A named Virtual File System image that Kandelo ships, tests,
  or uses as another image's input.
- **Candidate:** A public, visibly nonendorsed artifact created before merge.
- **Canonical:** An admitted artifact that normal consumers may select after
  merge and verification.
- **Exact head:** The pull request's real head commit and tree, not GitHub's
  synthetic merge commit.
- **Protected code:** Reviewed code from a protected repository branch.
- **Inert data:** Bytes that protected code parses and validates without
  executing them.
- **Admission:** The protected decision that a verified candidate may be used
  canonically.
- **Required product:** A product whose failure blocks the pull request.
- **Background Formula:** A Formula that should eventually be rebuilt but is
  unrelated to the selected required products.

## One end-to-end picture

```text
exact pull-request head
        |
        v
canonical VFS products + Pages/test selections
        |
        v
append-only request asset
        |
        v
tap dependency plan
        |
        +--> uncredentialed bottle build
        |            |
        |            v
        |    protected inert-data publisher
        |            |
        |            v
        |    public nonendorsed candidate
        |            |
        |            v
        |    independent verification
        |
        v
candidate VFS products + Node/browser evidence
        |
        v
Kandelo PR Check for the exact current head
        |
      merge
        |
        v
protected abi/N history --> unchanged bottle-layer promotion
        |
        v
canonical VFS recomposition + evidence
        |
        v
one complete atomic Pages deployment
```

## Rules shared by all five plans

- Every reusable path models ABI `N` to `N + 1`. A concrete successor branch
  is fixture data only.
- Build the exact pull-request head. Never stage a synthetic merge with main.
- Product TOML is the lasting authority for VFS composition and direct
  software roots.
- Pages and tests own product selection. A product cannot put itself on Pages
  or declare itself merge-gating.
- The tap owns Formula dependency resolution. Kandelo supplies direct roots;
  it does not copy the tap's transitive graph.
- Preserve two separate lazy choices: lazy loading of a whole VFS and lazy
  bottle/package references inside a VFS.
- Candidate and canonical references use visibly different namespaces.
- Promotion reuses exact bottle-layer bytes. It does not relabel a candidate
  VFS as canonical; final VFS products are built again around canonical
  references.
- Candidate-controlled execution receives no write credentials.
- A write-capable job runs protected code and validates downloaded artifacts
  as bounded inert data.
- Identity, verification, override, admission, and deletion are separate
  immutable records.
- Current applicability is exact head plus current requirements, policy, and
  guard-registry identities. It never uses timestamps, upload order, or Git
  hash ordering.
- An older exact head stays historically valid and buildable after a pull
  request advances.
- Incomplete input capture fails before an ordinary build. Only a protected
  authorization for the exact request and subject may permit that build.
- A classified transient infrastructure failure receives three retries after
  its first attempt. The coordinator records deterministic full jitter and
  returns; a runner never sleeps until the retry time.
- Required VFS products gate the pull request. Unrelated Formulae continue in
  the background.
- A protected and verified `abi/N` branch must exist before any `N + 1`
  canonical promotion or current-ABI metadata change.
- MVP Pages publication is all-or-nothing. Failure keeps the last complete
  deployment live.
- Old Homebrew infrastructure stays until every retirement condition has
  retained evidence.
- Semantic ABI modeling, complete custody for all external source bytes, and
  man pages remain future work.

## The five plans

### Plan 1: Product authority foundation

[Open Plan 1](2026-08-08-abi-staging-product-authority-foundation.md)

This plan creates canonical VFS product manifests and separate Pages/test
registries. It derives Formula roots from selected products, adds a strict
builder-input/report boundary, freezes shared record types, and runs a small
local ABI-transition example.

It does not publish anything or change hosted behavior.

### Plan 2: Exact-head request feed and reconciliation

[Open Plan 2](2026-08-08-abi-staging-exact-head-request-feed-and-reconciliation.md)

Protected Kandelo code creates append-only request assets for exact
same-repository pull-request heads. Protected tap code discovers and validates
those public assets through scheduled and manual read-only paths. Old heads
remain available; only the exact current head can satisfy the current Check.

The first hosted mode observes decisions but does not schedule builds.

### Plan 3: Tap candidates and verification

[Open Plan 3](2026-08-08-abi-staging-tap-candidates-and-verification.md)

The tap reads the request, resolves its actual Formula graph, and calculates
complete bottle contracts. Candidate code builds without credentials.
Protected code publishes source custody and candidate OCI objects, proves
anonymous readback, and records independent verification. This plan also owns
retry scheduling and exact maintainer overrides.

### Plan 4: Candidate VFS evidence and PR Check

[Open Plan 4](2026-08-08-abi-staging-candidate-vfs-evidence-and-pr-check.md)

Every real VFS builder is moved behind the Plan 1 input/report contract while
its old entry point remains available. Candidate VFS products use candidate
references, run their declared Node/browser evidence, and produce immutable
product records. Kandelo projects those records into the exact-name
`Kandelo PR Check` for the exact current head.

### Plan 5: Promotion, Pages, and retirement

[Open Plan 5](2026-08-08-abi-staging-promotion-pages-and-retirement.md)

Protected tap history preserves `abi/N` before activation. Eligible Formulae
promote independently by reusing exact candidate bottle layers. Kandelo then
rebuilds canonical VFS products, reruns evidence, and deploys one complete
Pages site. The hosted successor fixture proves the complete path. Cleanup
removes only legacy entries whose individual retirement checks pass.

## What each repository owns

| Repository | Owns |
|---|---|
| Kandelo | Product and consumer authority, ABI classification, request issuance, required evidence policy, exact-head kernel/host/product tests, the PR Check, and Pages. |
| Homebrew tap | Formula parsing and dependency resolution, bottle contracts, uncredentialed builds, custody, candidate/canonical OCI objects, verification records, promotion, `abi/N` history, and background convergence. |

The repositories exchange public canonical JSON and immutable OCI references.
No plan introduces one broad token shared by both repositories.

## Interfaces passed from one plan to the next

| Created by | Interface | Used by | Important guarantee |
|---|---|---|---|
| Plan 1 | `VfsProductCatalogV1` | Plans 2–5 | Product paths, digests, composition, software roots, materialization, and evidence are exact. |
| Plan 1 | `PagesProductRegistryV1`, `TestProductRegistryV1` | Plans 2, 4, 5 | Consumers, not products, select VFS products. |
| Plan 1 | `FormulaRequirementV1` | Plan 3 | Contains direct ordinary Formula roots only. |
| Plan 1 | `AbiStagingRequestV1` | Plans 2–5 | Contains exact source and requirements, but no tap build plan or mutable status. |
| Plan 1 | Guard registry and record variants | Plans 2–5 | Unknown fields/codes and contradictory states fail closed. |
| Plan 2 | Request asset, `CurrentRequestSelectionV1` | Plans 3, 4 | Filename, bytes, exact head, and current policy identities agree. |
| Plan 2 | `ReconciliationDecisionV1` | Plan 3 | Old heads remain valid work; only current evidence can gate. |
| Plan 3 | `TapPlanV1`, `BottleContractV1` | Plans 3–5 | Exact tap snapshot, graph, capture, and dependency-layer identities are bound. |
| Plan 3 | `PublishedRecordLocatorV1` | Plans 3–5 | The transport returns a digest/reference outside the bytes it hashes. |
| Plan 3 | Candidate, custody, and verification records | Plan 4 | Public bytes can be fetched and checked anonymously by digest. |
| Plan 4 | `ProductEvidenceRecordV1` | Plans 4, 5 | Product, inputs, runtime, VFS, report, definitions, and receipts agree. |
| Plan 4 | `CurrentCheckProjectionV1` | Plan 5 | Success applies only to the current exact head and current requirements. |
| Plan 5 | `AdmissionRecordV1`, ABI history record | Plan 5 Pages | Canonical objects reuse exact candidate layers only after protected history. |
| Plan 5 | `PagesReadinessRecordV1` | Deployment and retirement | One site revision contains every selected Pages product or does not deploy. |

`PublishedRecordLocatorV1` avoids a circular digest. A record's canonical bytes
do not contain their own digest. After publishing and anonymous readback, the
transport returns `{ repository, digest, immutable_reference }`. Later records
may refer to that locator.

## Activation is a separate decision

New code starts inert, observe-only, disabled, or legacy-compatible. A narrow
reviewed change activates each hosted stage only after its own evidence exists.

| Stage | Starting state | Evidence required before activation |
|---|---|---|
| Request feed | `observe` | Exact-head dry run, append/no-clobber canary, workflow trust tests. |
| Tap reconciliation | `observe` | Scheduled/manual equivalence, pagination, lifecycle, URL checks. |
| Candidate publication | `observe` | Uncredentialed build, bounded publisher, package association, anonymous readback. |
| Product evidence | `observe` | Candidate-reference composition and required Node/browser evidence. |
| PR Check | `observe` | Correct exact-head projection, delayed discovery, required/background separation. |
| Promotion | `disabled` | Merged exact-request canary and protected `abi/N` history. |
| Pages | `legacy` | Canonical recomposition/evidence and a failed-readiness proof that keeps the old site. |
| Legacy cleanup | `false` | Every ledger predicate has immutable evidence. |

An implementation commit cannot quietly activate a stage.

## Hosted prerequisites

Local implementation can proceed without these, but hosted activation cannot:

- The approved successor fixture head must exist in the public Kandelo
  repository. The currently inspected branch exists only locally.
- A repository rule must protect tap branches matching `abi/*`. Workflow code
  can verify that rule but cannot grant itself administration permission.
- Kandelo's workflow token must have the narrow permissions needed for
  prerelease assets and Checks.
- Tap workflows must be able to publish correctly associated public GHCR
  packages, and anonymous readback must work.
- Branch protection should require `Kandelo PR Check` only after observe-mode
  evidence passes.
- Production Pages activation waits for a complete canary and a deliberate
  failed-readiness test that leaves the old site live.

If a prerequisite is missing, finish safe local work and stop at that gate.
Do not replace it with a weaker mechanism.

## How to execute after approval

1. Use `superpowers:executing-plans` and complete the plans in order.
2. Create a separate implementation worktree for the tap.
3. Run build and validation commands through Kandelo's
   `scripts/dev-shell.sh`; supply the checked tap path as
   `KANDELO_TAP_ROOT` where a cross-repository test needs it.
4. Follow every task's red, green, and commit steps.
5. At a plan boundary, compare the interfaces actually implemented with the
   later plans. Update documentation before code if repository evidence
   requires a different path or name.
6. Keep the existing unrelated `tests/sortix/os-test` and `.serena/` state out
   of commits.
7. Never claim hosted behavior from a local test.

## Approved acceptance criteria and their owners

| Criterion | Planned evidence |
|---|---|
| 1. Structural ABI enforcement | Plan 2 Tasks 2 and 5; Plan 4 Task 12 |
| 2. Protected exact-head request | Plan 2 Tasks 2, 4, and 5 |
| 3. Idempotent discovery/manual reconciliation | Plan 2 Tasks 6–10 |
| 4. Product-derived roots and tap dependency resolution | Plan 1 Tasks 2–5; Plan 3 Tasks 2 and 3 |
| 5. Uncredentialed candidate build | Plan 3 Tasks 5 and 11 |
| 6. Custody, publication, anonymous readback | Plan 3 Tasks 6–8 and 12 |
| 7. Provenance-independent reuse | Plan 3 Task 4 |
| 8. Changed-input rebuilds and dependant invalidation | Plan 3 Tasks 4, 9, and 11 |
| 9. Fail-closed capture and exact override | Plan 1 Task 6; Plan 3 Tasks 1, 4, and 10 |
| 10. Separate immutable verification | Plan 3 Task 8 |
| 11. Required VFS Node/browser evidence | Plan 4 Tasks 2–10 |
| 12. Required-only pull-request gate | Plan 4 Task 11 |
| 13. Current-head merge gate | Plan 4 Tasks 12 and 13 |
| 14. Independent unchanged-layer promotion | Plan 5 Tasks 3–5 |
| 15. No stale prior-ABI metadata on tap main | Plan 5 Tasks 1 and 4 |
| 16. Retrievable history and controlled rebuild | Plan 5 Tasks 2 and 6 |
| 17. Post-merge background convergence | Plan 3 Tasks 3, 9, and 11; Plan 5 Tasks 5 and 6 |
| 18. Last-complete atomic Pages behavior | Plan 5 Tasks 8–10 |
| 19. Close/reopen/new-head history | Plan 2 Tasks 3, 7, and 8 |
| 20. Exact visible override; integrity cannot be waived | Plan 1 Task 7; Plan 3 Task 10 |
| 21. Local miniature and hosted acceptance | Plan 1 Task 8; Plans 2–4 hosted canaries; Plan 5 Tasks 11, 12, and 16 |

The legacy Homebrew lane can be removed only after all applicable evidence and
the checked-in retirement conditions are retained.
