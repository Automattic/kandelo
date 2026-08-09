# Generic ABI Bottle Staging Implementation Roadmap

**Status:** Approved for autonomous execution on 2026-08-09. Production Pages
deployment and artifact or legacy-infrastructure deletion remain explicitly
out of scope for this execution.

**Approved design:**
`docs/superpowers/specs/2026-08-08-abi-bottle-staging-design.md` from final
documentation commit `6e1b7ff24e544463d6f9c5f6b7fb67a873e1337a`.

**Scope:** `Automattic/kandelo` and
`kandelo-dev/homebrew-tap-core`, implemented as five independently reviewable
and testable plans.

## Why the whole roadmap is written now

The plans share public record types, OCI names, workflow authority boundaries,
and activation gates. Writing all five before implementation lets review catch
a mismatch at a handoff before either repository depends on it. Approval may
then authorize uninterrupted local execution in dependency order.

The roadmap does not turn hosted side effects into implied authority. The
executor may complete code, tests, fixtures, dry runs, and documentation
without interruption. It must stop at a hosted gate if the required branch,
repository rule, credential, package association, or public record is absent.
It must not replace that gate with a weaker mechanism.

## Fixed invariants

- All reusable code and policy model ABI `N` to ABI `N + 1`. The first hosted
  successor branch is fixture data only.
- The build source is the exact pull-request head commit and tree. A synthetic
  merge may remain in unrelated legacy package flows, but it is never an ABI
  staging source, reuse identity, or promotion source.
- Canonical VFS product TOML is the lasting product authority. Formula roots
  are derived from selected products and resolved transitively only by the tap.
- Pages and tests own product selection. Products cannot grant themselves
  deployment placement or merge-gating applicability.
- Whole-VFS loading and bottle/package-layer loading retain separate eager or
  lazy materialization contracts.
- Candidate and canonical references use distinct visible namespaces.
  Promotion reuses bottle-layer bytes; final products are recomposed with
  canonical references.
- Candidate-controlled execution has no write credential. A write-capable job
  runs protected code and treats all downloaded content as bounded inert data.
- Identity, verification, override, admission, and deletion are separate
  immutable facts. Human status is a projection.
- Current applicability uses exact head plus current requirements, policy, and
  guard-registry identities. Time, upload order, and lexical Git SHA ordering
  never choose the current request.
- Previously issued exact heads remain historically valid and buildable after
  a pull request advances.
- Incomplete capture fails before ordinary construction. Only an exact
  maintainer authorization can permit that exact subject to build.
- Three classified transient-infrastructure retries follow the initial
  attempt. Deterministic full jitter records eligibility and returns; no runner
  sleeps while waiting.
- Required products gate the pull request; unrelated Formulae converge in the
  background.
- Protected and verified `abi/N` history is an activation barrier before any
  `N + 1` canonical promotion or current-ABI mutation.
- MVP Pages deployment is atomic and preserves the last complete site on any
  new-site failure.
- Legacy infrastructure stays present until complete transition, repair,
  Pages, custody, consumer-audit, and failure-recovery evidence is retained.
- Obsolete VFS-wrapper entries in `packages/registry/` and the legacy
  `homebrew/main-shell.Brewfile` are explicit retirement targets. Ordinary
  software recipes remain package authority and are not legacy merely because
  a VFS product consumes them.
- Semantic ABI modeling, complete external-source custody, and man pages remain
  explicit future work.

## Plan set

1. [Product authority foundation](2026-08-08-abi-staging-product-authority-foundation.md)

   Establish canonical product and consumer data, shared request/record models,
   builder-input enforcement, guard and retirement registries, and a complete
   local miniature. Hosted behavior remains unchanged.

2. [Exact-head request feed and reconciliation](2026-08-08-abi-staging-exact-head-request-feed-and-reconciliation.md)

   Issue append-only exact-head requests from protected Kandelo code and let
   protected tap code discover, validate, and reconcile every historical and
   current request through scheduled and manual read-only paths.

3. [Tap candidates, custody, verification, retries, and overrides](2026-08-08-abi-staging-tap-candidates-and-verification.md)

   Resolve tap dependencies, calculate complete bottle contracts, build
   without credentials, publish source and candidate objects through protected
   code, verify exact bytes independently, and schedule bounded retries and
   exact overrides.

4. [Candidate VFS evidence and Kandelo PR Check](2026-08-08-abi-staging-candidate-vfs-evidence-and-pr-check.md)

   Adapt real product builders, compose nonendorsed candidate VFS images, run
   declared Node and browser evidence against the exact head, publish product
   evidence, and project it into the required exact-head Check.

5. [Promotion, ABI history, Pages, acceptance, and retirement](2026-08-08-abi-staging-promotion-pages-and-retirement.md)

   Preserve protected prior-ABI history, promote unchanged layers
   independently, recompose canonical products, converge the background set,
   deploy Pages atomically, execute the real successor fixture, and remove only
   legacy components whose recorded retirement predicates are proven.

## Dependency graph

```text
Plan 1: product and record authority
  |
  v
Plan 2: request issuance and read-only reconciliation
  |
  v
Plan 3: bottle plans, candidates, custody, and verification
  |
  v
Plan 4: candidate VFS evidence and exact-head PR Check
  |
  v
Plan 5a: protected ABI history and independent promotion
  |
  v
Plan 5b: canonical VFS evidence and atomic Pages
  |
  v
Plan 5c: hosted successor acceptance and evidence-gated retirement
```

Plans are sequential because each consumes exact public interfaces from its
predecessor. Tasks inside one plan may run independently only where the plan
says their files and state do not overlap.

## Cross-plan handoffs

| Producer | Interface | First consumer | Required property |
|---|---|---|---|
| Plan 1 | `VfsProductCatalogV1` | Plan 2 request issuer | Product paths, canonical digests, composition, software roots, materialization, and evidence are exact. |
| Plan 1 | `PagesProductRegistryV1` and `TestProductRegistryV1` | Plans 2 and 4 | Product selection is consumer-owned and carries exact registry digests. |
| Plan 1 | `FormulaRequirementV1` | Plan 3 tap planner | Contains direct ordinary Formula roots only; no transitive closure or build order. |
| Plan 1 | `AbiStagingRequestV1` | Plans 2–5 | Has exactly seven logical sections and excludes tap planning and mutable status. |
| Plan 1 | guard registry and durable record variants | Plans 2–5 | Unknown fields/codes fail closed and orthogonal states reject contradictions. |
| Plan 2 | request asset and `CurrentRequestSelectionV1` | Plans 3 and 4 | Filename, bytes, exact head, policy, requirements, and guard digests agree. |
| Plan 2 | `ReconciliationDecisionV1` | Plan 3 scheduler | Old heads remain authorized work; only current exact-head evidence can gate. |
| Plan 3 | `TapPlanV1` and `BottleContractV1` | Plans 3–5 | Tap snapshot, dependency graph, required/background membership, capture, and exact dependency layers are bound. |
| Plan 3 | `PublishedRecordLocatorV1` | Plans 3–5 | Transport digest/reference is returned outside hashed record bytes; no record embeds its own digest. |
| Plan 3 | candidate, custody, and verification records | Plan 4 product planner | Exact public bytes and qualifying receipts can be read anonymously by digest. |
| Plan 4 | `ProductEvidenceRecordV1` | Plan 4 Check and Plan 5 promotion/Pages | Exact manifest, registries, VFS, builder report, runtime, and required receipts agree. |
| Plan 4 | `CurrentCheckProjectionV1` | Plan 5 merge/promotion | Success applies only to current head/current protected requirements and required products. |
| Plan 5 | `AdmissionRecordV1` and ABI history evidence | Plan 5 canonical composition | Canonical manifest reuses the candidate bottle layer and source history is protected first. |
| Plan 5 | `PagesReadinessRecordV1` and deployed-site record | Retirement gate | Every Pages registry product is complete for one site revision or the old site remains live. |

`PublishedRecordLocatorV1` resolves a wording edge in the shared record model:
the canonical record bytes never contain their own digest. The protected
transport returns `{ repository, digest, immutable_reference }` after upload
and anonymous readback. Referencing records may bind that locator. Candidate
OCI-manifest identity remains the candidate record digest; it is not inserted
into the bytes whose hash creates it.

## Repository ownership

### `Automattic/kandelo`

Kandelo owns product/consumer authority, ABI classification, request issuance,
guard and evidence policy, exact-head kernel/host/product tests, the PR Check,
and Pages. Its write jobs never receive tap package credentials.

### `kandelo-dev/homebrew-tap-core`

The tap owns Formula parsing and dependency resolution, its exact planning
snapshot, uncredentialed builds, source custody, candidate and canonical OCI
publication, verification receipts, lifecycle reconciliation, tap-main
metadata, protected `abi/N` history, and background convergence. It does not
decide whether a later Kandelo commit invalidates an earlier merged request.

All cross-repository communication uses public canonical request/record bytes.
No plan introduces a shared broad token.

## Execution protocol after approval

1. Execute one plan at a time with `superpowers:executing-plans`, preserving
   its TDD and commit boundaries.
2. Run all build and validation commands from the Kandelo-declared environment
   through `scripts/dev-shell.sh`. Tap tests run inside that environment with a
   separately supplied, validated `KANDELO_TAP_ROOT`.
3. Keep the pre-existing `tests/sortix/os-test` and `.serena/` worktree state
   untouched and absent from commits.
4. At each plan exit, compare actual file and interface names with every later
   plan. Update plan documentation before code if repository evidence requires
   a different file; never silently drift an interface.
5. Do not describe a stage as operational until its hosted evidence task has
   passed. A locally complete but inactive stage remains documented as inert or
   observe-only.
6. Do not continue through a failed required check by using an override unless
   the guard registry marks the exact condition overrideable and the plan's
   protected workflow has emitted the exact immutable authorization/receipt.
7. If a hosted prerequisite is absent, complete all remaining local work,
   report the exact gate, and stop before the prohibited external mutation.
8. Limit repository mutations to `Automattic/kandelo` and
   `kandelo-dev/homebrew-tap-core`. Do not deploy production Pages, delete or
   purge artifacts, or delete legacy infrastructure. Code and dry-run tooling
   for those operations may be implemented and validated only while inactive.

## Activation states

Activation is reviewed protected policy, not a mutable “latest” request or
artifact pointer. Each stage moves only after its own hosted evidence:

| Stage | Initial state | Evidence before active/enforced state |
|---|---|---|
| Kandelo request feed | `observe` | Exact-head dry run, append/no-clobber canary, and workflow trust tests. |
| Tap reconciliation | `observe` | Scheduled/manual equivalence, pagination, lifecycle, and exact URL validation. |
| Candidate publication | `observe` | Uncredentialed build, bounded inert publisher, namespace association, and anonymous readback canary. |
| Product evidence | `observe` | Candidate-reference composition plus required Node/browser evidence on hosted runners. |
| Kandelo PR Check | `observe` | Correct current-head projection, delayed-discovery diagnostic, and required/background separation. |
| Promotion | `disabled` | Merged exact-request canary and verified protected `abi/N` activation barrier. |
| Pages | `legacy` | Complete canonical recomposition/evidence and a deliberate failed-readiness run retaining the old deployment. |
| Legacy cleanup | `false` | Every predicate in the retirement ledger has immutable evidence. |

An activation change is a narrow reviewed commit after evidence. It cannot be
smuggled into an implementation commit or inferred from a successful local
test.

## Hosted gates that may require maintainer preparation

- The acceptance head must be available in the public Kandelo repository. The
  currently observed `integration/abi43-batch-linear-20260801` branch exists
  only locally; the generic implementation must not manufacture or substitute
  another head.
- A repository ruleset or branch-protection rule must cover tap branches
  matching `abi/*` before the transition. Protected code verifies this rule; it
  does not grant itself repository-administration authority.
- Kandelo's workflow token must be allowed to create/update prerelease assets
  and Checks with only the documented job-scoped permissions.
- The tap workflow token must be able to create correctly associated public
  GHCR packages with `packages: write`, and anonymous readback must work.
- The required `Kandelo PR Check` must be added to branch protection only after
  its observe-mode hosted evidence passes.
- Pages production activation occurs only after a canonical full-site canary
  and last-complete-site failure proof.

These gates are not reasons to postpone planning. They are reasons the plan
must make stop conditions deterministic.

## Whole-roadmap acceptance

The roadmap is complete only when all twenty-one acceptance criteria in the
approved design have retained evidence. In particular, a successful required
product set does not imply a complete background tap, a public candidate does
not imply endorsement, and a local miniature does not imply GitHub/GHCR/Pages
behavior.

| Approved criterion | Planned evidence owner |
|---|---|
| 1. Structural ABI enforcement | Plan 2 Tasks 2 and 5; Plan 4 Task 12 |
| 2. Protected exact-head request | Plan 2 Tasks 2, 4, and 5 |
| 3. Idempotent discovery/manual reconciliation | Plan 2 Tasks 6–10 |
| 4. Product-derived roots and tap dependency resolution | Plan 1 Tasks 2–5; Plan 3 Tasks 2 and 3 |
| 5. Uncredentialed candidate build | Plan 3 Tasks 5 and 11 |
| 6. Custody, publication, and anonymous readback | Plan 3 Tasks 6–8 and 12 |
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
| 20. Exact visible override and unwaivable integrity | Plan 1 Task 7; Plan 3 Task 10 |
| 21. Local miniature and hosted acceptance | Plan 1 Task 8; Plans 2–4 hosted canaries; Plan 5 Tasks 11, 12, and 16 |

Until then, the checked-in retirement ledger remains nonremovable and current
supported behavior remains whatever the still-active legacy path actually
provides.
