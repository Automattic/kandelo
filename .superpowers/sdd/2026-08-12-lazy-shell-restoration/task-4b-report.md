# Task 4b Report: Restore the Lazy-Shell Pages Consumer

## Outcome

Task 4b restores the existing lazy Homebrew shell as the GitHub Pages
consumer. Ordinary browser preparation now resolves the canonical
`homebrew-bootstrap` package and atomically stages its exact ZIP. Pages can run
only from the post-activation `workflow_dispatch`; in one fresh cache it
resolves the shell, Node VFS, and bootstrap, anonymously verifies the checked
37-asset mirror, proves the exact lazy partition, and binds all three emitted
browser artifacts before the existing browser acceptances and deployment.

No package revision, ABI, package recipe, VFS builder, or transport changed.
No release, push, dispatch, publication, or GitHub mutation was performed.

## Implementation

- `run.sh prepare-browser` no longer excludes `homebrew-bootstrap`. It resolves
  the package through the normal `build-deps` path and stages the declared ZIP
  with a same-directory temporary file and atomic rename. The authenticated
  source-rootfs bridge remains an explicit no-Homebrew exception.
- The Pages workflow has no push trigger. It accepts only the exact activation
  dispatch, resolves shell, Node VFS, and bootstrap in its fresh package cache,
  verifies the bootstrap staged by browser preparation, and anonymously checks
  the public mirror before building.
- The existing public-product inspector now derives the current partition from
  the checked selection and policies. It requires exactly three embedded
  bottles, one bootstrap tree, the libyaml/Ruby two-bottle boot cohort, 35
  ordinary deferred bottles, 37 deferred mirror bottles, and 38 initially
  pending trees. The embedded mirror plan must equal the checked-in plan
  byte-for-byte and bind the exact deferred package inventory.
- The existing Chromium spec now treats bootstrap, libyaml, and Ruby as the
  initial boot materialization cohort and proves that the other 35 bottle trees
  remain ordinary deferred work. Pages still runs the exact production
  WordPress-proxy `npm install cowsay --verbose` acceptance after that proof.
- Focused browser, release, Homebrew publication, and package-management docs
  now describe the lazy consumer and post-activation deployment ordering.

## TDD Evidence

The initial RED command was:

```sh
bash scripts/dev-shell.sh bash -c '
  set +e
  npx tsx --test scripts/inspect-homebrew-main-shell-public-product.test.ts
  inspector=$?
  bash scripts/test-stage-homebrew-bootstrap-browser-asset.sh
  staging=$?
  bash scripts/ci-check-pages-deployment.sh
  pages=$?
  printf "RED inspector=%s staging=%s pages=%s\n" \
    "$inspector" "$staging" "$pages"
'
```

Results before implementation:

- the five new inspector cases all failed because the old inspector expected
  the retired runtime-support input contract;
- the staging suite exited 127 because the stager did not exist; and
- the Pages checker rejected the `main` push lane because publication was not
  restricted to the post-activation dispatch.

Final focused GREEN command:

```sh
bash scripts/dev-shell.sh bash -c '
  set -euo pipefail
  npx tsx --test scripts/inspect-homebrew-main-shell-public-product.test.ts
  bash scripts/test-stage-homebrew-bootstrap-browser-asset.sh
  bash scripts/ci-check-pages-deployment.sh
  bash scripts/test-pages-deployment-contract.sh
'
```

Result: inspector 5/5 passed; canonical bootstrap staging passed for initial,
stale, missing, non-regular, and symlink boundaries; the focused Pages checker
passed; and the complete Pages workflow mutation/ordering suite passed.

Independent review found two stale CI assertions outside those focused Task 4b
suites. Before correction,
`.github/scripts/test-merge-candidate-workflows.sh` failed with `Pages checkout
must bind the requested source SHA` because it still required the former event
SHA fallback. The closure suite still required sealed-option gating, retired
bootstrap skipping, and the historical Formula preparer. After its static
assertions were corrected, re-review found its executable fixture still modeled
that preparer; running the fixture with the current function exited 1 at
`pkg_xtask_bin: command not found`.

The merge-candidate contract now requires exact `inputs.source_sha` checkout
and explicitly rejects an event-SHA fallback. The closure contract now requires
ordinary canonical package resolution, fetch-only forwarding, exact output
lookup, atomic staging, and the source-rootfs exception. Its executable fixture
supplies the package resolver and stager, checks both fetch-only and ordinary
resolver traces, compares staged bytes, proves source-rootfs bypass, and checks
`bootstrap`, `fetch`, `build` ordering. Verification was:

```sh
bash scripts/dev-shell.sh bash \
  .github/scripts/test-merge-candidate-workflows.sh
bash scripts/dev-shell.sh bash -c '
  set -euo pipefail
  # Extract the executable bootstrap/dispatch probe block with the current
  # run.sh functions and run it using the suite's resolver/stager fixture.
'
```

Results: `merge candidate workflow contract tests passed` and
`task4b executable closure probes: ok`. The broad closure suite was not rerun
because it stops earlier on the separately known stale finalizer mismatch; the
focused executable probe proves that `test-homebrew-publish-workflow.sh` no
longer reaches a deterministic Task 4b fixture failure when it invokes that
closure suite.

## Exact Product Evidence

The inspector was run against Task 4a's fresh source-built package outputs and
the checked selection, materialization policy, runtime policy, bootstrap tree
specification, and mirror plan. It reported:

- shell: 5,730,802 bytes,
  `5000efa83ba6f19df259cd497f6f609c25e56bb9ad74df38fcceeeb37cdedcec`;
- bootstrap: 5,251,369 bytes,
  `26ac98e328573244d3e7c0c149f30114ef5d9c8882200f5a22e56f97d2541482`;
- partition: 3 embedded, 1 bootstrap, 2 runtime-cohort, 35 ordinary
  deferred, 37 total deferred, and 38 initially pending trees; and
- mirror plan: 19,901 bytes, 37 assets,
  `0eaf1454cd94eeddf45fe508e6a727f75344398540c5f84f33b85a9509b988ff`.

A production Vite build passed after staging the exact Task 4a bootstrap. The
hashed shell and Node assets and emitted bootstrap were compared to their
selected inputs:

- emitted shell: exact 5,730,802-byte shell above;
- emitted Node VFS: 16,034,889 bytes,
  `a8f15eb300a5cfd9a27d1017d8f4fe78e9d1a8ba27a0f857230a2eeec1fdbf34`;
  and
- emitted bootstrap: exact 5,251,369-byte bootstrap above.

The temporary bootstrap staged for this build was removed afterward; the
normal public path remains package-resolver owned.

## Public Rollout Dependency

The required anonymous mirror check was attempted once with credentials
removed:

```sh
bash scripts/dev-shell.sh env -u GH_TOKEN -u GITHUB_TOKEN node \
  scripts/verify-public-homebrew-bottle-mirror.mjs \
  --plan homebrew/main-shell-flat-lazy-mirror-plan.json \
  --out /tmp/kandelo-task4b-public-mirror-receipt.json
```

Result: `public mirror plan is unavailable: HTTP 404`. The Task 4a mirror and
canonical bootstrap package have not yet been published/activated, so no live
Chromium or production npm/cowsay acceptance was run locally. The Pages job is
deliberately ordered behind this anonymous check and will fail before build or
deployment until publication is complete.

## Additional Verification

```sh
bash scripts/dev-shell.sh bash -c '
  node --test docs-site/.vitepress/homebrew-doc-links.test.mjs
  npm run docs:build
  node --test docs-site/.vitepress/homebrew-doc-output.test.mjs
'
bash scripts/dev-shell.sh bash scripts/check-abi-version.sh
git diff --check
```

Results: all six documentation source/output tests passed, the VitePress build
passed, the ABI snapshot/header/TypeScript bindings remain in sync at ABI 42,
and the scoped diff has no whitespace errors.

The broad app TypeScript command
`npx tsc --noEmit -p apps/browser-demos/tsconfig.json` is not currently a clean
repository gate. It failed on existing unrelated declarations including the
`BrowserKernel.fs` shape, nullable display refs, Node globals in shared host
sources, and ES2024 Atomics/SharedArrayBuffer library declarations. It did not
report an error in the changed lazy-shell spec. The production browser build
passed.

`scripts/ci-check-browser-assets.sh` passed its Pages size, freshness, asset,
and complete workflow mutation suites, then its final broad asset-import scan
remained silent and was interrupted. A direct invocation of that final scan
behaved the same. This was not treated as evidence that the scan passed.

No Playwright invocation occurred because the checked public mirror is 404.
The user-owned `apps/browser-demos/test-results/` directory remained untracked
and untouched. A final read-only archive contained two paths, used 4 KiB, and
had SHA-256
`f039030e4790d83611f3b9d8288e120110ed336ad9000b54689909131099b943`.
