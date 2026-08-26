# ABI 43 History Replay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the ABI 43 squash merge with one rebase-merged pull request
whose linear history contains conceptually complete ABI 43 commits and the
postcommit spawn-liveness repair.

**Architecture:** Build a grouped replay line on the squash parent, prove that
line recreates the squash tree exactly, then assemble one public branch that
reverts the squash and cherry-picks the grouped line. Add replay documentation
and the already validated Node/browser liveness repair only after exact tree
equality is proven.

**Tech Stack:** Git, GitHub CLI, Bash, Rust/TypeScript repository checks,
Vitest, Kandelo dev shell.

## Global Constraints

- Never force-push or rewrite `main`.
- Open one pull request and merge it only with GitHub **Rebase and merge**.
- Keep the pull request below GitHub's 100-commit rebase limit.
- Preserve original authors and every original commit through explicit
  provenance.
- Preserve the two protected source-test changes that landed after the
  original ABI 43 branch point.
- The grouped replay tree must equal
  `bd28679cd2452f24e5c3ea2c245ed3dfcace1e05`.
- The final net source change is limited to replay docs and the postcommit
  spawn-liveness repair.
- Run build and validation commands through `scripts/dev-shell.sh` where the
  repository provides a declared environment.

---

### Task 1: Audit the original range and planning documents

**Files:**
- Create:
  `docs/superpowers/specs/2026-08-17-abi43-history-replay-design.md`
- Create: `docs/superpowers/plans/2026-08-17-abi43-history-replay.md`

**Interfaces:**
- Consumes: merge base `847875deeb07d2be4039485a7c3287ad5edf400f`,
  original head `c218d35225c411859d067133242316ddf07cb08e`, squash
  parent `c1ff05541a7d9eaa4f295acb065f735cdb0bd272`, and squash
  commit `bd28679cd2452f24e5c3ea2c245ed3dfcace1e05`.
- Produces: the exact 63-group authority used by Tasks 2-4.

- [ ] **Step 1: Verify range size, authors, and trailers**

Run:

```bash
git rev-list --count \
  847875deeb07d2be4039485a7c3287ad5edf400f..\
c218d35225c411859d067133242316ddf07cb08e
git shortlog -sne \
  847875deeb07d2be4039485a7c3287ad5edf400f..\
c218d35225c411859d067133242316ddf07cb08e
git log --format=%B \
  847875deeb07d2be4039485a7c3287ad5edf400f..\
c218d35225c411859d067133242316ddf07cb08e | \
  rg '^Co-authored-by:' || true
```

Expected: 135 commits; 131 by Brandon Payton, three by Dependabot, one by
`mho22`; any co-author trailers are visible for explicit preservation.

- [ ] **Step 2: Verify the intervening-main delta**

Run:

```bash
git diff --name-status \
  c218d35225c411859d067133242316ddf07cb08e \
  bd28679cd2452f24e5c3ea2c245ed3dfcace1e05
```

Expected: exactly the protected publisher trust checker, exact source-test
packer, and packer regression named in the design.

- [ ] **Step 3: Commit the design and this plan separately**

Run:

```bash
git add docs/superpowers/specs/2026-08-17-abi43-history-replay-design.md
git commit -m "docs: design the ABI 43 history replay"
git add docs/superpowers/plans/2026-08-17-abi43-history-replay.md
git commit -m "docs: plan the ABI 43 history replay"
```

### Task 2: Build the grouped replay line

**Files:**
- Modify: Git commit topology only; no final source edits.

**Interfaces:**
- Consumes: the 135 original commits and the design grouping table.
- Produces: temporary branch `abi43-replay-grouped`, based on
  `c1ff05541a7d9eaa4f295acb065f735cdb0bd272`, with 63 commits.

- [ ] **Step 1: Create the temporary grouped branch**

Run:

```bash
git switch -c abi43-replay-grouped \
  c1ff05541a7d9eaa4f295acb065f735cdb0bd272
```

- [ ] **Step 2: Define the bounded grouping helper**

Run in the Bash session used for grouped commits:

```bash
replay_group() {
  first="$1"
  last="$2"
  subject="$3"
  author="$(git show -s --format='%an <%ae>' "$first")"
  provenance="$(git log --reverse --format='Original-commit: %H' \
    "$first^..$last")"
  git cherry-pick --no-commit "$first^..$last"
  git commit --author="$author" \
    -m "$subject" \
    -m "This concept commit consolidates its complete contiguous change from the original ABI 43 batch." \
    -m "$provenance"
}
```

- [ ] **Step 3: Replay independent commits 1-41**

Run:

```bash
git cherry-pick -x \
  4efcab85fe10dd9abcc3b1c74cc78ba9b0850703^..\
0b21ee6b3
```

Expected: 41 commits with `mho22` and Dependabot authors unchanged.

- [ ] **Step 4: Replay ownership, audio, and vfork groups**

Run:

```bash
replay_group 4968cbca2 774eec589 \
  "ABI: Move lifecycle metadata ownership into Rust"
replay_group 5d3317bbc 78b64f174 \
  "Audio: Provide process-safe OSS PCM across hosts and packages"
replay_group eebf350ae 691b5ede7 \
  "ABI: Establish the production vfork mechanism"
git cherry-pick -x 0f33598ea
```

- [ ] **Step 5: Replay credential, login, and runtime groups**

Run:

```bash
replay_group 7d0a7074f 91d6be903 \
  "POSIX: Make credentials and set-ID execution authoritative"
replay_group 8abe5ef8b 6144a4ea8 \
  "POSIX: Complete interrupted waits and login integration"
replay_group 6e4a37b52 c2b572cc8 \
  "Build: Initialize the reentrant Node runtime"
replay_group a272497b5 cbd148ebb \
  "Packages: Integrate ABI 43 descriptors and products"
```

- [ ] **Step 6: Replay CI and candidate-authority groups**

Run:

```bash
replay_group 6254851d6 e61878bcd \
  "CI: Repair ABI 43 product contract fixtures"
replay_group 7b81eebb7 819882228 \
  "Packages: Make candidate provenance authoritative"
replay_group 4b4127b35 446749856 \
  "Packages: Preserve candidate tests and program projections"
replay_group b81889e01 b4b55a183 \
  "Packages: Preserve candidate artifact identity"
```

- [ ] **Step 7: Replay publication and verification groups**

Run:

```bash
replay_group b38598451 7a80d1248 \
  "ABI: Unblock first-wave candidate publication"
replay_group 34112844b fdb8cb04b \
  "ABI: Enforce qualified candidate metadata"
replay_group e33081997 4dd2ae433 \
  "Packages: Install authenticated candidates in bounded realms"
replay_group 9b7844fe7 8f46de6cb \
  "Packages: Preserve Chromium across candidate tests"
```

- [ ] **Step 8: Replay dependency and final execution groups**

Run:

```bash
replay_group 20b3f97b5 6ac709107 \
  "ABI: Materialize candidate dependency artifacts"
git cherry-pick -x c66ccdb0b
git cherry-pick -x 66468b600
git cherry-pick -x d6b381482
replay_group 7d01b329a ae23d0dc0 \
  "ABI: Authorize artifact-independent staging validation"
replay_group bfd069791 c218d3522 \
  "Host: Carry secure exec and retirement through commit"
```

If either final group conflicts with the protected source-test changes, inspect
each conflict with `git diff --cc` and resolve it to the exact content in
`bd28679cd2452f24e5c3ea2c245ed3dfcace1e05`. Do not use a blanket side
selection.

- [ ] **Step 9: Prove grouped tree equality**

Run:

```bash
git diff --exit-code \
  bd28679cd2452f24e5c3ea2c245ed3dfcace1e05 HEAD
git rev-list --count \
  c1ff05541a7d9eaa4f295acb065f735cdb0bd272..HEAD
```

Expected: no tree diff and 63 commits.

### Task 3: Assemble the public repair branch

**Files:**
- Modify: Git commit topology only until replay equality is proven.

**Interfaces:**
- Consumes: grouped line plus design and plan commits.
- Produces: `emdash/abi43-history-replay-final`, based on current `main`.

- [ ] **Step 1: Record the prepared heads**

Run:

```bash
grouped_head="$(git rev-parse HEAD)"
design_head="$(git rev-parse emdash/abi43-history-replay~1)"
plan_head="$(git rev-parse emdash/abi43-history-replay)"
```

- [ ] **Step 2: Revert the squash on the final branch**

Run:

```bash
git switch -c emdash/abi43-history-replay-final origin/main
git revert --no-edit bd28679cd2452f24e5c3ea2c245ed3dfcace1e05
git diff --exit-code \
  c1ff05541a7d9eaa4f295acb065f735cdb0bd272 HEAD
```

Expected: the revert tree equals the squash parent.

- [ ] **Step 3: Append the grouped replay**

Run:

```bash
git cherry-pick \
  c1ff05541a7d9eaa4f295acb065f735cdb0bd272.."$grouped_head"
git diff --exit-code \
  bd28679cd2452f24e5c3ea2c245ed3dfcace1e05 HEAD
```

Expected: the replay tree equals the squash tree exactly.

- [ ] **Step 4: Append design and plan**

Run:

```bash
git cherry-pick "$design_head" "$plan_head"
```

### Task 4: Append the postcommit spawn-liveness repair

**Files:**
- Create:
  `docs/superpowers/specs/2026-08-17-posix-spawn-postcommit-liveness-design.md`
- Create:
  `docs/superpowers/plans/2026-08-17-posix-spawn-postcommit-liveness.md`
- Modify: `host/src/node-kernel-worker-entry.ts`
- Modify: `host/src/browser-kernel-worker-entry.ts`
- Modify: `host/test/spawn-host-parity.test.ts`

**Interfaces:**
- Consumes: validated commits `b7a42cfd2`, `93880b52a`, and
  `108f47fea`.
- Produces: one complete Node/browser runtime repair commit.

- [ ] **Step 1: Apply all validated changes without committing**

Run:

```bash
git cherry-pick --no-commit b7a42cfd2^..108f47fea
```

- [ ] **Step 2: Commit the complete repair**

Run:

```bash
git commit --author="Brandon Payton <brandon@happycode.net>" \
  -m "Host: Defer spawn liveness until after allocation" \
  -m "Keep the single legal post-allocation child-liveness fence in both Node and browser hosts, with the reviewed design, plan, and parity regression."
```

### Task 5: Verify history, attribution, and behavior

**Files:**
- Verify only.

**Interfaces:**
- Consumes: final repair branch.
- Produces: evidence for the one rebase merge.

- [ ] **Step 1: Verify count and linearity**

Run:

```bash
git rev-list --count origin/main..HEAD
git rev-list --merges origin/main..HEAD
test "$(git rev-list --count origin/main..HEAD)" -lt 100
```

Expected: 67 commits and no merge commits.

- [ ] **Step 2: Verify every original SHA exactly once**

Run:

```bash
git rev-list --reverse \
  847875deeb07d2be4039485a7c3287ad5edf400f..\
c218d35225c411859d067133242316ddf07cb08e | sort \
  > /tmp/abi43-original-shas
git log --format=%B origin/main..HEAD | \
  sed -nE \
    -e 's/^Original-commit: ([0-9a-f]{40})$/\1/p' \
    -e 's/^\(cherry picked from commit ([0-9a-f]{40})\)$/\1/p' | \
  sort > /tmp/abi43-replayed-shas
diff -u /tmp/abi43-original-shas /tmp/abi43-replayed-shas
```

Expected: no differences or duplicates.

- [ ] **Step 3: Verify special authors and final diff**

Run:

```bash
git log --format='%an <%ae>%x09%s' origin/main..HEAD | \
  rg 'mho22|dependabot\[bot\]'
git diff --name-only origin/main..HEAD
git diff --check origin/main..HEAD
```

Expected: one `mho22` commit, three Dependabot commits, and only the four
replay/spawn docs plus three spawn implementation/test files in the final diff.

- [ ] **Step 4: Run focused host validation**

Run:

```bash
scripts/dev-shell.sh bash -lc '
  cd host && npx --no-install vitest run \
    test/spawn-host-parity.test.ts \
    test/exec-state-tracking.test.ts \
    test/deferred-worker-start.test.ts \
    test/spawn-pid-authority.test.ts
'
```

Expected: 85 tests pass.

- [ ] **Step 5: Run ABI and full Vitest validation**

Run:

```bash
scripts/dev-shell.sh bash scripts/check-abi-version.sh
scripts/dev-shell.sh bash scripts/ci-run-test-suite.sh vitest
```

Expected: ABI version/snapshot checks and the full Vitest lane pass.

### Task 6: Publish and rebase-merge one pull request

**Files:**
- No source changes after Task 5.

**Interfaces:**
- Consumes: final verified branch.
- Produces: repaired linear `main` and a new immutable staging source.

- [ ] **Step 1: Push and create the pull request**

Run:

```bash
git push -u origin emdash/abi43-history-replay-final
gh pr create --repo Automattic/kandelo \
  --base main \
  --head emdash/abi43-history-replay-final \
  --title "ABI: Replay ABI 43 as reviewable history"
```

The PR body must lead with why squash history prevents review and bisecting,
explain the one-revert/63-replay topology, list tree and attribution evidence,
and document the final spawn-liveness repair.

- [ ] **Step 2: Revalidate immediately before merge**

Run:

```bash
git fetch origin main
test "$(git rev-parse origin/main)" = \
  bd28679cd2452f24e5c3ea2c245ed3dfcace1e05
gh pr view --repo Automattic/kandelo --json \
  mergeable,mergeStateStatus,statusCheckRollup,headRefOid,baseRefOid
```

If `main` moved, rebuild from Task 3. Do not force a stale branch.

- [ ] **Step 3: Rebase-merge and verify public history**

Run:

```bash
gh pr merge --repo Automattic/kandelo --rebase --delete-branch
git fetch origin main
git log --format=fuller --reverse \
  bd28679cd2452f24e5c3ea2c245ed3dfcace1e05..origin/main
```

Expected: revert, 63 replay commits, replay docs, and final spawn repair appear
linearly with preserved authors.
