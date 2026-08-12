# Task 4a Report: Publish and Gate the Exact Flat-Lazy Mirror

## Outcome

Task 4a is implemented locally. The protected tap publisher now derives the
mirror from a fresh current-`main` source build of the registry
`homebrew-bootstrap` and `shell` packages, recovers the shell's flat-lazy
payloads, and requires the recovered plan to equal the checked-in 37-asset
plan byte-for-byte before the existing immutable publisher can receive them.

Candidate activation anonymously verifies that exact public plan and every
asset immediately before `ensure_release` performs the first canonical
package-release mutation. An absent or corrupt mirror exits without a
rejection receipt or canonical package change, preserving manual and scheduled
retry behavior. No GitHub publication, dispatch, push, or repository mutation
was performed while implementing this task.

ABI version 42 and `abi/snapshot.json` are unchanged.

## Governing Scope Resolution

The task brief originally said to make the shell package build compare the
generated plan before emitting the shell. During implementation, the governing
scope decision was narrowed: the checked-in plan must not become a shell recipe
input because a validation-only input would rotate every derived package cache
key even though the package bytes are unchanged.

The comparison therefore lives in the protected `create-mirror` publisher. It
force-source-builds the direct bootstrap dependency and shell through the
normal resolver, recovers the plan from that source-built shell, and runs
`cmp` before the publication handoff. No shell `build.toml`, build script,
package revision, selection, or registry index changed. The package import
closure check remains green.

## Exact Rollout Plan

The checked-in authority is
`homebrew/main-shell-flat-lazy-mirror-plan.json`:

- repository: `kandelo-dev/homebrew-tap-core`;
- collection:
  `d5aa52c246ccb9a93751ef2c57c93e18a798cc1637ddd57f921fea957a61f48b`;
- tag:
  `homebrew-shell-bottles-sha256-d5aa52c246ccb9a93751ef2c57c93e18a798cc1637ddd57f921fea957a61f48b`;
- plan bytes: 19,901;
- plan SHA-256:
  `0eaf1454cd94eeddf45fe508e6a727f75344398540c5f84f33b85a9509b988ff`;
- deferred assets: 37;
- total deferred bytes: 48,116,392; and
- largest asset: 11,347,489 bytes.

A fresh isolated resolver build produced:

- `shell.vfs.zst`: 5,730,802 bytes,
  `5000efa83ba6f19df259cd497f6f609c25e56bb9ad74df38fcceeeb37cdedcec`;
- `homebrew-bootstrap.zip`: 5,251,369 bytes,
  `26ac98e328573244d3e7c0c149f30114ef5d9c8882200f5a22e56f97d2541482`;
  and
- `homebrew-brew.env`: 210 bytes,
  `2eb3f05703b6a6f23feabda24f622bacd068115c7f74a0eac51bb4085e9eec5a`.

Recovering that fresh shell produced a report with source
`flat-lazy-image-binding`, the exact repository/collection/tag above, and 37
assets. This exact comparison passed:

```sh
cmp /tmp/kandelo-task4a-source-build.EHKFRM/mirror/kandelo-homebrew-bottle-mirror-plan.json \
  homebrew/main-shell-flat-lazy-mirror-plan.json
sha256sum homebrew/main-shell-flat-lazy-mirror-plan.json
wc -c homebrew/main-shell-flat-lazy-mirror-plan.json
```

The output was SHA-256 `0eaf1454...b988ff` and 19,901 bytes. A separate
read-only build/recovery check reproduced all three package-product identities,
the 37-asset flat-lazy report, and the byte-identical plan comparison.

## Implementation

### Protected publisher

The `create-mirror` path in
`.github/workflows/reusable-homebrew-main-shell-mirror-publish.yml` now:

1. enters one dev shell and keeps all scalar resolver queries inside it, so
   dev-shell banners cannot contaminate output paths;
2. force-source-builds `homebrew-bootstrap` and `shell` for `wasm32` into one
   isolated resolver cache;
3. accepts only resolver-created symlinks under the isolated programs tree,
   resolves their absolute targets, and confines the regular targets to the
   canonical isolated cache root;
4. recovers the flat-lazy mirror without GitHub credentials;
5. compares its plan byte-for-byte with the checked-in authority; and
6. feeds the existing immutable publish manifest/handoff.

The historical `publish-lifecycle` path, sealed bootstrap preparation, and
artifact-lock validation remain intact. The protected write job and anonymous
readback are unchanged. Its frozen digest remains
`5f38b593eeffd4cacf3d728baa64695e88fe2f0723757628dbc936b6b679c54b`.
The changed complete workflow digest is frozen as
`d8aaa7ff78ce755552c2004ee5e758702da2f44ffb8c3732c9ad4a56132d80d6`.

The publish-manifest parser now accepts either the exact legacy catalog report
or the exact current `flat-lazy-image-binding` report. Extra or mixed fields
remain rejected.

### Anonymous verification and activation ordering

`scripts/verify-public-homebrew-bottle-mirror.mjs` uses only Node built-ins and
the global Fetch implementation. It downloads anonymously with credentials
omitted and release redirects followed. The published plan must match the
checked-in bytes exactly. Each payload must match its declared byte count and
SHA-256. Streaming reads stop at the checked-in bound, and a present
`Content-Length` must equal that exact bound.

`.github/scripts/activate-merge-candidate.sh` invokes the verifier after its
final default-branch recheck and immediately before `ensure_release`. The
workflow does not repeat the 48 MiB download on every quiet 30-minute sweep.
Early canonical recovery only resumes transactions previously created after
this gate; a new candidate cannot have such a transaction before activation
passes the gate.

The ordering contract test locates the verifier call and
`ensure_release "$CANONICAL_TAG"` in the executable activation script and
requires the verifier to occur first. The dynamic failure test additionally
proves that mirror failure leaves upload count, canonical index bytes,
canonical candidate archive digest, rejection receipt, and activation receipt
unchanged. A subsequent successful retry activates the same candidate.

## TDD Evidence

### Initial publisher and report RED

```sh
bash scripts/dev-shell.sh bash \
  scripts/test-homebrew-main-shell-mirror-workflow.sh
bash scripts/dev-shell.sh npx --prefix host vitest run --root . \
  tests/package-system/homebrew-bottle-mirror-recovery.test.ts
```

The workflow checker failed because `create-mirror` did not source-build the
shell and its direct bootstrap package. The recovery suite failed its new
current-report case because the manifest generator rejected a report without
the retired catalog object.

### Verifier REDs

```sh
bash scripts/dev-shell.sh node --test \
  scripts/verify-public-homebrew-bottle-mirror.test.mjs
```

The first run failed because the verifier module did not exist. Boundary-first
follow-up tests also exposed missing rejection for a declared
`Content-Length` below the checked-in count. The implementation now requires
exact declared length and bounds the streaming body independently.

### Workflow trust REDs

The workflow mutation suite was extended before the corresponding fixes. It
rejected the initial implementation for capturing dev-shell wrapper output in
artifact paths. The resolver-link contract then failed because scalar
`output-path` calls did not select `--arch wasm32`; review of the real resolver
showed the original containment check would also reject legitimate absolute
symlinks from `--binaries-dir` into the package cache. The implementation now
validates the relative programs-tree entry first and the resolved regular cache
target second.

### GREEN results

```sh
bash scripts/dev-shell.sh node --test \
  scripts/verify-public-homebrew-bottle-mirror.test.mjs
```

Result: 9 tests passed. Coverage includes exact checked-in plan identity,
anonymous redirect-following success, missing plan, wrong digest, short body,
declared over/undersize, streaming oversize cancellation, and changed plan
bytes.

```sh
bash scripts/dev-shell.sh npx --prefix host vitest run --root . \
  tests/package-system/homebrew-bottle-mirror-recovery.test.ts
```

Result: 1 file and 7 tests passed, including legacy and current flat-lazy
manifest generation.

```sh
bash scripts/dev-shell.sh bash \
  scripts/test-homebrew-main-shell-mirror-workflow.sh
bash scripts/dev-shell.sh bash \
  .github/scripts/test-merge-candidate-workflows.sh
bash scripts/dev-shell.sh bash \
  .github/scripts/test-activate-merge-candidate.sh
```

Results: all three focused workflow suites passed. The reusable-workflow suite
mutation-checks missing source builds, dev-shell path contamination, missing
resolver symlink validation, wrong cache containment, missing exact-plan
comparison, and preservation of the lifecycle/bootstrap path.

## Additional Verification

Package import closure:

```sh
host_target="$(bash scripts/dev-shell.sh rustc -vV | \
  awk '/^host:/ {print $2}')"
bash scripts/dev-shell.sh cargo run -p xtask \
  --target "$host_target" --quiet -- build-deps \
  program-index-context-check --source-repo-root "$PWD"
```

Result: passed.

Host declarations and ABI:

```sh
bash scripts/dev-shell.sh npm --prefix host run typecheck
bash scripts/dev-shell.sh bash scripts/check-abi-version.sh
```

Results: host declaration generation passed; ABI snapshot, C header, and
TypeScript bindings were current and ABI 42 was consistent.

Documentation and diff hygiene:

```sh
bash scripts/dev-shell.sh npm run docs:build
git diff --check
git diff --exit-code -- abi/snapshot.json crates/shared/src/lib.rs
```

Results: VitePress built successfully, and both diff checks passed.

## Documentation and Deferred Work

The package, binary-release, and Homebrew publication docs now describe the
current revision-24 flat-lazy shell, registry bootstrap ownership, protected
source-build publication order, exact activation gate, and retry behavior.
They also distinguish the current registry bootstrap's deterministic ZIP from
the historical tap support-data Formula without conflating provenance.

`docs/future-improvements.md` now explicitly defers:

- an exact candidate-shell-to-public-mirror binding carried through candidate
  and activation receipts; and
- automatic cross-repository publication dispatch using a least-privilege
  installation identity.

Neither candidate handoff machinery nor automatic dispatch was added.

## Self-Review and Preservation

Independent read-only review found no Critical code issue. It found one
Important documentation mismatch: an older publication paragraph claimed
both modes verify the retired shell artifact lock. The paragraph now states
the implemented ownership precisely: `create-mirror` source-builds and binds
the checked-in plan, while only `publish-lifecycle` verifies that historical
lock. Re-review found no remaining Critical or Important issue.

No package recipe, package revision, registry index, ABI file, protected
publish job, candidate schema, or cross-repository dispatch mechanism changed.
The verifier receives no GitHub token, creates its receipt exclusively, and
cannot buffer beyond the checked-in plan/asset bounds. The activation gate is
inside the executable script, so direct callers cannot bypass it.

The pre-existing user-owned dirty paths `libc/musl`, `tests/sortix/os-test`,
`.serena/`, and `apps/browser-demos/test-results/` were not edited or staged.
No live browser or GitHub rollout was run because Task 4a forbids publication
and dispatch; deployment and browser acceptance belong to the controller's
later rollout work.
