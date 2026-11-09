# Graphics workspace recovery and Cage handoff

Checkpoint: 2026-11-09. Read the [campaign plan](campaign-plan.md) for scope,
delivery order and acceptance. This handoff locates local-only recovery
material after preparing the original Moscow workspace for retirement.
It does not report a Cage fix or completed graphics validation.

## Durable material

The campaign plan is committed on `brandonpayton/graphics-campaign-plan`.
The foundation/B1 increment is already merged through #1594. Their code
and plan do not depend on retaining the original workspace.

Additional material is preserved outside Conductor's workspace directory:

```text
/Users/brandon/kandelo-handoffs/graphics-moscow-20261109/
```

Read its `README.md` first. This is a **local backup on the same Mac**, not
a remote or second-disk backup. Transfer the package when moving machines.
Bulk evidence and unreviewed drafts were not uploaded to the repository.

The package contains:

- An incremental Git bundle and pinned refs for 211 worktree heads.
- Separate staged/unstaged patches and untracked files for 207 readable
  worktrees. All combined patches passed apply checks against recorded
  heads. Four trees with broken Git metadata have raw source snapshots.
- Original context notes, worker design, task history, failed Cage traces,
  screenshots, browser reports, benchmarks and native-control evidence.
- A file manifest with hashes, exclusions, restore-check receipts and
  independent copies of six frozen preview sources/products/dependencies.

The context/source copy has 390,096 manifest entries and 52.726 GiB of
logical file content, largely APFS clones. Those figures are not physical
disk usage or reclaimed-space measurements. General build caches and
reproducible dependencies are excluded with recorded reasons; required
preview dependencies were preserved separately.

## Start the next agent

Select R1 in the campaign plan: diagnose and fix Cage startup/crashes at
their owning platform layer, profile its performance, and deliver a
bounded regression-tested follow-up. The broader B2–C3 campaign remains
paused. Work from current main in an isolated experimental checkout;
do not modify the frozen preview copies while they serve users.

Read the current repository contracts and focused guides before coding.
The shipped family was program 56 / host 4 / GL 17 / fork 21; inspect
current main and follow its ABI policy. The old worker design's permission
to alter unpublished host 3 does not apply to published host 4.

Original private notes now have these recovery-package-relative locations:

```text
context/outer/.context/ACTIVE-RESUME-2026-11-03.md
context/outer/.context/HANDOFF-2026-11-03.md
context/outer/.context/graphics-tasks.md
context/outer/.context/gpu-worker-design.md
```

They contain historical workspace paths. Use the package's README and
manifests to resolve preserved material rather than treating an old path
as an active checkout or a missing artifact as an implementation boundary.
The previous campaign's integration-path rule names the original workspace;
establish the successor workspace with the maintainer before future Git
mutations if that location has been retired.

## Cage reproduction and evidence

The shipped runtime is
`567dd52debd150f6ad0037b42c2b137be1f980e1`, preserved as
`previews/normal/` in the local package. Its production runtime is the
tested source for the combined #1594 release; the landed tree also has
release-documentation changes.

The selected release matrix passed 23/24: Chromium 8/8, Firefox 8/8,
WebKit 7/8. WebKit's Cage case failed during `LiveKernelHost` setup with
an unclassified `UnknownError`, before reaching rendering assertions.
A separate isolated control reproduced it. Neither OOM nor a browser
defect has been established, and this failure need not explain other
reported Cage crashes or slowness.

Recover the matrix/control under:

```text
context/.context/graphics-integration-r2/.context/graphics-combined-landing-r997/
```

Read `checks/browser-results.json`, `checks/browser.log`, the matching
`checks-webkit-cage-control/` files and `reviewed-case-outcomes.json`.
Original failed screenshots/traces are preserved under the corresponding
`graphics-combined-normal-r997/apps/browser-demos/test-results/` context
snapshot. Keep original outcomes when performing new diagnostics.

## Previews and archive readiness

The latest preview on port 59247 and historical partial preview on 59241
now run from external copies. Their served image hashes match the original
manifests. The latest Cage URL is:

```text
http://127.0.0.1:59247/?vfs=%2F%40kandelo-partial%2Fimage.vfs.zst&profile=cage
```

The protected older previews now run on their original ports from these
external copies, following explicit maintainer authorization:

| Port | External copy |
| --- | --- |
| 6271 | `previews/legacy6271/` |
| 5693 | `previews/legacy5693/` |
| 6075 | `previews/legacy6075/` |
| 7776 | `previews/legacy7776/` |

Each old listener was verified to run directly from Moscow before shutdown.
The replacements have external working directories and serve both the page
and main app module successfully. Temporary verification listeners were
closed after migration. Consult the local README and `metadata/*preview*`
receipts for exact jobs, artifact identities and restart instructions.

All six copied preview pages and main modules return HTTP 200, and copied
product hashes match their originals. Latest and legacy6271 each passed
their existing Chromium Sway/Foot rendering/input case after relocation.
These two cases are bounded relocation evidence, not new full graphics
acceptance or a Cage/WebKit repair. An initial check was intentionally
stopped when global setup began provisioning unrelated ABI fixtures;
its interrupted result is retained. Successful checks used verified
products and omitted that unrelated setup.

The backup task did not remove the original workspace. Other historical
diagnostic servers still referencing it must be retired by their owners
or with authorization. No unique work needs to remain solely in Moscow;
the six retained preview URLs no longer depend on the original workspace.
