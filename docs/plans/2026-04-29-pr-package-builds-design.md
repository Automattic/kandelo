# PR Package Builds — Design

Date: 2026-04-29
Branch: `package-management-for-pr-workflows`
Worktree: `.superset/worktrees/wasm-posix-kernel/package-management-for-pr-workflows/`

## §1. Context & goals

The package management system landed in PR #365 (and follow-ups #341, #347, #348, #352–#360, #361, #362). It publishes built `.tar.zst` archives to a single `binaries-abi-v<N>-YYYY-MM-DD` GitHub release; consumers pin via a top-level `binaries.lock` (release tag + manifest sha256). Today's release flow is human-driven:

1. A PR bumps a package in `examples/libs/<name>/deps.toml` and merges to main (e.g. PR #371 publishing dinit).
2. A maintainer manually runs `scripts/stage-release.sh` + `scripts/publish-release.sh` to cut a fresh `binaries-abi-v<N>-YYYY-MM-DD` release.
3. A second PR bumps `binaries.lock` to the new release (e.g. PR #372).

This design replaces that manual two-step with an automated single-PR flow that:

- Lets a single PR include code changes + package bumps.
- Provides reviewers, CI, and preview deploys with built archives during review, without committing prebuilt bytes to git.
- Avoids cluttering the GitHub release set with one tag per PR (open or closed).
- Lands the lockfile bump atomically with the user's PR — main is never in a "code says new, lockfile says old" state.

**Non-goals (v1).**

- Fork-PR staging builds. Fork PRs use the resolver's existing source-build fallback. Two-stage `workflow_run` support for forks is documented as future work (§9).
- A `kernel.wasm` / `userspace.wasm` story. Those manifests still lack build scripts (per `docs/package-management-future-work.md`); this design ships them the same way as today.
- Promoting PR-built bytes to durable releases. The pre-merge workflow rebuilds against tip-of-main; PR-staging archives are review-only and never become durable bytes. (Earlier promotion designs are noted in §9.)

## §2. Architecture overview

Two parallel release tracks coexist on the GitHub release page:

- **Durable releases** — `binaries-abi-v<N>-YYYY-MM-DD[-<seq>]`, marked as regular releases. Pinned by `binaries.lock`. Created only by the pre-merge workflow on `ready-to-ship`-labeled PRs. Never deleted.
- **Staging pre-releases** — `pr-<NNN>-staging`, marked as pre-releases. Created by the staging-build workflow on each PR push when archive contents change. Deleted on PR close (and by a daily sweep for orphans).

Reviewers and CI consume staging via an **overlay** (`binaries.lock.pr`, gitignored, downloaded on demand from the staging release):

```
binaries.lock          (durable pin, tracked in git)
       +
binaries.lock.pr       (staging overlay, gitignored, downloaded by fetch-binaries.sh)
       =
effective manifest used for fetch
```

The overlay is sparse: it lists only the package entries whose `cache_key_sha` differs from the durable manifest. Unchanged archives keep their durable-release URLs and benefit from the existing content-addressed cache (`binaries/objects/<sha>.<ext>`).

## §3. Schema

### §3.1 `binaries.lock.pr` (new, gitignored)

```json
{
  "staging_tag": "pr-372-staging",
  "staging_manifest_sha256": "ae54cf9f…",
  "overrides": ["dinit", "libzstd"]
}
```

- `staging_tag` — the GitHub release tag where the staging manifest lives.
- `staging_manifest_sha256` — verified against the downloaded staging manifest, same way `binaries.lock`'s `manifest_sha256` guards the durable manifest.
- `overrides` — list of package names whose entries should be replaced from the staging manifest. Other entries fall through to the durable manifest. (Names, not archive filenames, so the overlay survives a version-string bump.)

### §3.2 Existing schema unchanged

- `binaries.lock` schema is unchanged. It still pins `abi_version` + `release_tag` + `manifest_sha256`.
- The release manifest (`manifest.json`) schema is unchanged. Staging manifests are valid release manifests; the staging release just happens to contain a subset of entries.
- `examples/libs/<name>/deps.toml` is unchanged.

### §3.3 `.gitignore` addition

```
binaries.lock.pr
```

### §3.4 Tag naming

- `pr-<NNN>-staging` — PR number is taken from `${{ github.event.pull_request.number }}`.
- `binaries-abi-v<N>-YYYY-MM-DD[-<seq>]` — `<seq>` is appended only if today's date already has a release (e.g. two PRs ship on the same day). The pre-merge workflow probes `gh release list` and increments.

## §4. Workflows

### §4.1 `staging-build.yml` — every PR push

Trigger: `on: pull_request` (`opened`, `synchronize`, `reopened`) for same-repo branches only.

```
1. Checkout PR HEAD.
2. Compute cache_key_sha for every package via `cargo xtask build-deps cache-key`.
3. If pr-<NNN>-staging exists, fetch its manifest.json. Skip rebuild for packages
   whose cache_key_sha matches the staging manifest's entry (and the durable manifest's
   entry — i.e., already published unchanged).
4. For changed packages: build via xtask (resolver hits cache for unchanged deps),
   archive to .tar.zst, upload to pr-<NNN>-staging (creating the pre-release if absent).
5. Compose binaries.lock.pr (staging_tag, staging_manifest_sha256, overrides[]).
   Upload as a release asset.
6. Run vitest / cargo test / libc-test against the overlaid manifest.
7. Update sticky PR comment summarising what was rebuilt + link to staging release.
8. Set `binaries / staging built` status check.
```

Skipped entirely if no package's `cache_key_sha` changed since the last staging build (cheap pushes for code-only changes).

### §4.2 `prepare-merge.yml` — `ready-to-ship` label applied

Trigger: `on: pull_request` `types: [labeled]`, filtered to label `ready-to-ship`.

```
1. Verify PR is approved + all other required checks green.
   If not: drop label, post error comment, exit.
2. Acquire concurrency lock (group: `prepare-merge-singleton`,
   cancel-in-progress: false). Only one PR builds the durable release at a time.
3. Checkout PR HEAD merged onto tip-of-main (`git merge --no-commit origin/main`)
   into a detached worktree — this is the post-merge byte state.
4. Compute durable tag: `binaries-abi-v<N>-YYYY-MM-DD[-<seq>]`. Probe `gh release list`
   for collisions; append `-<seq>` if needed.
5. Build all packages via xtask. Cache hits cover packages staging already built;
   no-op packages reuse existing durable archives via the content-addressed cache.
6. Stage the durable release: `scripts/stage-release.sh`.
7. Detect drift vs baseline: compare the staged manifest's per-entry
   `(program, arch, compatibility.cache_key_sha)` set against
   `binaries/manifest.json` (the baseline already on disk from `fetch-binaries.sh`).
   * If identical → skip steps 8–10 (no fresh release, no lockfile bump). The
     existing pin in `binaries.lock` already covers the merged-state code
     byte-for-byte; cutting another tag would just produce content-identical
     archives under a new name.
   * If any entry differs → continue with steps 8–10.
8. Publish the durable release: `scripts/publish-release.sh --tag <new-tag> --staging <dir>`.
9. Rewrite top-level binaries.lock with new release_tag + manifest_sha256.
10. Push a single commit to the PR's HEAD branch (using GITHUB_TOKEN; same-repo
    PR, so push permission exists):
        chore(binaries): bump lockfile to <new-tag>
11. Set status check `merge-gate=success`. Target sha:
    * If publish ran → the bot lockfile-bump commit (PR HEAD advanced).
    * If publish was skipped → the original PR HEAD sha. Branch protection
      evaluates the required check against the squash target's head sha;
      either form satisfies it.
12. Enable squash auto-merge: `gh pr merge --auto --squash`.
```

Tests (cargo / vitest / libc-test / POSIX / sortix) run unconditionally between staging and the lockfile bump — PR code may break tests independent of whether package contents changed.

Failure handling: any step fails → drop `ready-to-ship` label, post a comment naming the failing step, exit. Main is untouched. The contributor (or a maintainer) re-applies the label after addressing the failure. In the drift-skip path, no orphaned durable release is left behind on test failure (publish never ran).

### §4.3 `staging-cleanup.yml` — PR close + daily sweep

Triggers:
- `on: pull_request` `types: [closed]` — fires for both merged and abandoned PRs.
- `on: schedule` — daily cron.

```
On PR close:
1. Look up pr-<NNN>-staging release; if it exists, delete the release and the
   underlying tag (`gh release delete <tag> --yes --cleanup-tag`).

Daily sweep:
1. List all pre-releases matching `pr-*-staging`.
2. For each, parse the PR number from the tag.
3. Query the PR via `gh pr view <NNN> --json state`. If state != OPEN, delete.
4. Catches webhook misses + workflow failures during the close event.
```

## §5. Per-actor flow

### §5.1 Author

1. Edits `examples/libs/dinit/deps.toml` (bump version, swap source URL/sha) and any associated build script. Maybe edits code/tests in the same PR.
2. Locally: `cargo xtask build-deps build dinit` — resolver source-builds the new version into the local cache. Tests pass.
3. Does **not** touch `binaries.lock` or `binaries.lock.pr`.
4. Pushes to a same-repo branch and opens the PR.

### §5.2 Reviewer

1. Reads PR diff: `deps.toml` + code/test changes only. No lockfile churn in the diff.
2. Reads sticky PR comment from `staging-build.yml` to see what archives were rebuilt and the staging-release link.
3. (Optional, to exercise locally) `gh pr checkout 372 && scripts/fetch-binaries.sh`. The script auto-detects the PR via the public `/repos/{owner}/{repo}/commits/{sha}/pulls` endpoint, downloads `binaries.lock.pr` from the staging release, applies the overlay, fetches archives. Unchanged archives stay cached in `binaries/objects/<sha>.<ext>`.
4. Approves. Applies `ready-to-ship` label (could also be the gatekeeper / author per project convention).

### §5.3 Bot (the squashed merge commit)

After `prepare-merge.yml` runs and auto-merge fires, the squash merge collapses everything into a single main commit:
- Code/test changes.
- `deps.toml` bump.
- `binaries.lock` bump to the new durable tag.

`git log binaries.lock` on main reads as a clean series of squash-merged PRs that each include their own lockfile bump — no sibling "lockfile bump" PRs.

## §6. `fetch-binaries.sh` changes

The script gains a small overlay-resolution step:

```
1. Read binaries.lock (existing path).
2. Detect PR context:
   a. If --pr <N> flag passed: use it.
   b. Else: parse origin remote URL → owner/repo. curl
      `https://api.github.com/repos/<owner>/<repo>/commits/<HEAD-sha>/pulls`
      (no auth required for public repos; rate-limited 60/hr unauth, 5000/hr auth).
   c. If gh CLI is installed and authed, use it instead (higher rate limit).
   d. If detection fails, proceed with no overlay (--pr <N> fallback message).
3. If PR detected: try downloading `binaries.lock.pr` from `pr-<NNN>-staging`. Verify
   `staging_manifest_sha256` against the staging release's manifest.json.
4. Compose the effective manifest by replacing entries in `overrides` with the
   staging manifest's entries.
5. Fetch archives content-addressed into binaries/objects/<sha>.<ext>. Unchanged
   archives are already cached from prior fetches.
```

Behaviour without an overlay (no PR detected, or staging release missing) is byte-for-byte identical to today.

## §7. Edge cases & failure modes

### §7.1 Pre-merge build fails after PR is labeled

`prepare-merge.yml` drops `ready-to-ship` and posts a comment naming the failing step. Main is unchanged. Contributor rebases onto current main, addresses the cause, re-applies the label.

### §7.2 Two PRs labeled `ready-to-ship` simultaneously

The `prepare-merge-singleton` concurrency group serialises them. The second PR waits in the queue; when its turn comes, it merges PR HEAD onto the *now-advanced* main, rebuilds, and either succeeds (its `cache_key_sha` is unaffected) or fails loudly (e.g. an ABI bump that came in via the first merge).

### §7.3 Staging release deleted while PR still open

If a maintainer manually deletes `pr-<NNN>-staging`, the next staging-build push recreates it from scratch. `fetch-binaries.sh` falls back to no-overlay (durable-only) until the rebuild completes — the resolver source-builds for any package that needs the new bytes.

### §7.4 Webhook misses on PR close

The daily `staging-cleanup.yml` sweep deletes orphaned staging tags whose PRs are closed.

### §7.5 Author force-pushes during pre-merge workflow

If the author force-pushes between `prepare-merge.yml`'s amend and the auto-merge, the bot's lockfile commit is lost. Mitigation: the workflow's final step asserts the bot commit is on the PR HEAD before enabling auto-merge; if not, drop the label and post a "force-push during prepare; please re-label" comment.

### §7.6 `binaries.lock.pr` schema drift

Future overlay schema bumps require a version field. v1 ships without one; if/when the schema needs to evolve, add a `schema_version` field and have `fetch-binaries.sh` reject unknown versions with a clear error.

### §7.7 No applicable `cache_key_sha` change on a PR push

The staging-build workflow exits early. The status check still reports green. Stale staging release contents (from a prior push that did rebuild) remain valid because `cache_key_sha` is content-deterministic.

## §8. Local-binaries override is unchanged

`local-binaries/<name>/build/` is still priority 1 in the resolver chain. A developer who hand-builds dinit locally still beats both the durable pin and the PR overlay. Nothing in this design touches `local-binaries/`.

## §9. Future work

### §9.1 Fork PR staging builds (the (iii) two-stage workflow)

Default GitHub workflows for fork PRs run with read-only credentials and cannot push to upstream releases. To support staging builds for fork PRs, a two-stage flow is the standard secure pattern:

1. **Stage 1** — `pull_request` workflow runs on the fork PR with no credentials. Builds packages, saves outputs as workflow artifacts.
2. **Stage 2** — `workflow_run` (or `pull_request_target` gated by a maintainer-applied `binaries-staging-approved` label) downloads the artifacts from stage 1 and uploads them to `pr-<NNN>-staging`.

The label gate ensures untrusted code (the fork's `build-<name>.sh`, `xtask` modifications) never runs in a context with secrets. First-time fork contributors see a CI comment explaining "no staging release yet — a maintainer must approve". Until shipped, fork PRs use the resolver's source-build fallback (slower review cycle, but functional).

### §9.2 Promotion of PR bytes to durable release

This design rebuilds against tip-of-main in the pre-merge step. An alternative is to promote the staging release's bytes directly (skip the rebuild). The savings are real but the staleness check has to be airtight (cache_key_sha recomputed against post-merge state) and multi-PR coordination is non-trivial. Re-evaluate when CI rebuild times become a bottleneck.

### §9.3 Atomic merge via merge queue

If the project moves to GitHub Merge Queue for other reasons, `prepare-merge.yml` can move from a label trigger to a `merge_group` trigger, and the bot push lands on the queue's internal branch instead of the PR branch. Same atomic property, no PR-branch race window. Migration cost is operational rather than technical.

### §9.4 `kernel.wasm` / `userspace.wasm` in releases

Already tracked in `docs/package-management-future-work.md` §"Ship kernel.wasm + userspace.wasm in the release". This design doesn't change that story; both binaries continue to be built locally via `bash build.sh` and overridden through `local-binaries/`.

## §10. References

- `docs/package-management.md` — current package management system (cache layout, resolver chain, schema).
- `docs/binary-releases.md` — current release process (manual stage + publish).
- `docs/package-management-future-work.md` — accumulated future work on the package system, including "CI-driven dep builds" which this design partially implements.
- `scripts/stage-release.sh`, `scripts/publish-release.sh`, `scripts/fetch-binaries.sh` — existing release-side scripts this design extends.
- `crates/shared/src/lib.rs` — `ABI_VERSION` constant; staging and durable releases must agree on this.
