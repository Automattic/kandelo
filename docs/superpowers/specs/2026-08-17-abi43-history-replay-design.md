# ABI 43 History Replay Design

## Purpose

Pull request #1264 was squash-merged as `bd28679cd2452f24e5c3ea2c245ed3dfcace1e05`.
That preserved the final source tree but discarded the reviewable ABI 43 commit
sequence from `c218d35225c411859d067133242316ddf07cb08e`. Repair the public history
without rewriting or force-pushing `main`.

The repair is one pull request merged with GitHub's **Rebase and merge** method.
It first reverts the squash, then replays a conceptually complete ABI 43
sequence, and finally adds the postcommit `posix_spawn` liveness repair needed
by the `msmtpd` bottle test.

## Repository facts

- Squash commit: `bd28679cd2452f24e5c3ea2c245ed3dfcace1e05`
- Squash parent/current pre-ABI tree:
  `c1ff05541a7d9eaa4f295acb065f735cdb0bd272`
- Original PR head: `c218d35225c411859d067133242316ddf07cb08e`
- Original PR merge base:
  `847875deeb07d2be4039485a7c3287ad5edf400f`
- Original PR range: 135 commits
- GitHub rebase-merge limit: 100 commits

The original PR head is not byte-identical to the squash commit. Two protected
source-test preparation commits landed on `main` after the original branch
point. GitHub's squash result correctly combined those intervening changes
with the ABI 43 diff, affecting three protected workflow-support files. The
replay must therefore be applied onto the squash parent, not copied from the
old PR head as a complete tree.

## One-PR topology

The repair branch starts at the current squash-merged `main` and contains this
linear sequence:

1. One revert of the squash commit.
2. Sixty-three conceptually complete ABI 43 replay commits.
3. The reviewed design and implementation plan.
4. One postcommit spawn-liveness commit containing its contract docs,
   Node/browser implementation, and parity regression.

The tree immediately after the revert must equal the squash parent. The tree
immediately after the ABI replay must equal the squash commit exactly. The
final pull-request diff may then contain only the replay documentation and the
spawn-liveness repair.

## Consolidation policy

Keep a commit separate when it represents an independently reviewable platform
contract, has a distinct upstream author, or is an independent dependency
update. Consolidate contiguous commits when later commits complete or repair
the same contract, regenerate artifacts for that contract, or record its
validation and rollout.

Each consolidated commit records every original SHA and subject in its body.
The resulting commit author is the author shared by the grouped commits.
`mho22` remains the author of the Windows mount-permissions commit. Each of the
three Dependabot commits remains separate with Dependabot as author. Any
original co-author trailer is retained on the consolidated commit.

The following table is the complete grouping authority. Ordinals refer to
`git log --reverse 847875dee..c218d3522`.

| Original ordinals | Replay treatment | Concept |
|---|---|---|
| 1-38 | Keep individually | Independent fork, host, POSIX, network, SDK, CI, and browser contracts |
| 39-41 | Keep individually | Three independent Dependabot updates |
| 42-49 | Consolidate | Move lifecycle and host metadata ownership into Rust |
| 50-52 | Consolidate | Provide process-safe OSS audio across hosts and packages |
| 53-57 | Consolidate | Establish the ABI 43 vfork mechanism and build artifacts |
| 58 | Keep individually | Default executable mounts to `nosuid` |
| 59-66 | Consolidate | Make credentials, set-ID execution, and PTY metadata authoritative |
| 67-72 | Consolidate | Complete interrupted-wait, login, sudo-lite, and vfork integration |
| 73-75 | Consolidate | Pin build tools and initialize the reentrant Node runtime |
| 76-83 | Consolidate | Integrate ABI 43 Homebrew descriptors and product projections |
| 84-86 | Consolidate | Repair CI and product contract fixtures for ABI 43 |
| 87-93 | Consolidate | Make Formulae and candidate provenance authoritative |
| 94-97 | Consolidate | Preserve candidate Formula tests and program projections |
| 98-102 | Consolidate | Preserve keg, launcher, rebuild, schema, and public clone identity |
| 103-111 | Consolidate | Unblock and validate first-wave candidate publication |
| 112-117 | Consolidate | Enforce qualified metadata and close first-wave platform drift |
| 118-120 | Consolidate | Pour authenticated candidates in bounded verification realms |
| 121-124 | Consolidate | Preserve and project Chromium across Formula tests |
| 125-127 | Consolidate | Materialize exact candidate dependency bottles |
| 128 | Keep individually | Keep publisher integration out of PR staging |
| 129 | Keep individually | Export PHP side-module ABI identity |
| 130 | Keep individually | Preserve worker output process identity |
| 131-132 | Consolidate | Make exact ABI validation artifact-independent and authorize the builder |
| 133-135 | Consolidate | Carry secure exec and retirement through commit and refresh projections |

This produces 63 replay commits. With the revert, two documentation commits,
and the final runtime repair, the pull request has 67 commits.

## Replay mechanics

Build a temporary replay line from the squash parent. Apply each group in
original order with `git cherry-pick --no-commit`, resolve only the protected
source-test overlap introduced after the original merge base, and commit the
group once its complete final state is present. Never select conflict sides by
blanket `ours` or `theirs`; compare each conflict against the squash tree.

After the grouped line is complete, require:

```text
git diff --exit-code <grouped-replay-head> bd28679cd2452f24e5c3ea2c245ed3dfcace1e05
```

Then, on the public repair branch, revert the squash and cherry-pick the 63
grouped commits. Re-run the same tree-equality check before adding the runtime
repair.

## Merge and attribution rules

- No force push to `main`.
- No squash merge.
- No merge commit.
- The pull request must be merged using GitHub **Rebase and merge**.
- The pull request must contain fewer than 100 commits.
- Every replay commit must have the intended original author.
- Consolidated commit bodies must list their complete original SHA set.
- Compare original and replay author inventories before merge.

GitHub rewrites committer identity and commit SHAs during rebase merge while
retaining authors. That is acceptable; losing original authors or conceptual
boundaries is not.

## Validation

Before opening the pull request:

1. Prove the post-revert tree equals `c1ff05541...`.
2. Prove the post-replay tree equals `bd28679cd...`.
3. Prove the final diff contains only the design/plan and spawn-liveness files.
4. Prove the branch is linear and contains fewer than 100 commits.
5. Compare author inventories and original-SHA coverage.
6. Run `scripts/check-abi-version.sh`.
7. Run the focused spawn/exec host tests.
8. Run the full Vitest lane used by the merged ABI tree.
9. Run `git diff --check`.

Before merging, re-fetch `main`, require the pull-request base to remain the
expected squash commit, and re-run the tree, attribution, and commit-count
checks. If `main` moves, rebuild the replay against the new base rather than
force-merging stale history.

## Staging interaction

The active tap workflow may continue validating the immutable original ABI 43
request while this history repair is prepared. Its candidate bytes remain
useful. The repaired Kandelo history produces a new source commit identity, so
after the history pull request lands the staging coordinator must either prove
reuse against the new request or rebuild only contracts changed by the final
spawn-liveness repair. It must not pretend the old source commit is the new
one.
