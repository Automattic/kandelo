# ABI Bottle Staging Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make tap-built candidate bottles and protected product evidence the
merge authority for ABI-applicable Kandelo pull requests, then stop running the
legacy full-registry package matrix for those requests without enabling
promotion, deletion, or Pages deployment.

**Architecture:** First repair the three isolated-output regressions blocking
the bootstrap Kandelo pull request. Next replace the tap's unbounded Release
listing with bounded request-tag discovery and prove the existing exact URL
path in observe mode. Activate request issuance, candidate publication, and
product evidence through separate protected commits. Only after a complete
public result exists, enforce the exact-head Check and route ABI-applicable
Kandelo CI around the legacy package overlay while preserving source-only and
kernel validation. The cutover uses the existing protected Check and product
evidence contracts; it does not translate bottles back into legacy `binaries/`
entries.

**Tech Stack:** Bash, CMake, Rust/xtask, Python 3.13, Ruby workflow checkers,
GitHub Actions, GitHub CLI, OCI/GHCR, Node.js, Playwright/Chromium, Nix dev
shell.

## Global Constraints

- Run local verification through `scripts/dev-shell.sh` from the Kandelo
  checkout.
- Execute exact candidate code only in uncredentialed jobs; protected jobs may
  treat candidate files and artifacts only as bounded inert data.
- `Automattic/kandelo` may publish the canonical request as a GitHub Release
  asset. It must not publish any OCI object or GHCR package.
- Every OCI write in this tranche must use a repository below
  `ghcr.io/kandelo-dev/homebrew-tap-core-abi-<N>/`.
- Keep `Kandelo/staging/promotion-activation.toml` at `mode = "disabled"`.
- Keep cleanup deletion absent or observe-only. Do not create tombstones,
  delete tags, purge packages, or remove legacy infrastructure.
- Keep `abi/staging/pages-activation.toml` inactive. Do not deploy production
  Pages.
- Do not use the legacy package matrix as fallback for an ABI request. Missing,
  stale, failed, or conflicting exact evidence must leave the pull request
  blocked.
- Preserve the legacy package matrix for non-applicable package-only pull
  requests during this rollout.
- Preserve unrelated dirty submodules and untracked local state. Stage only the
  files named by the active task.
- Preserve original authorship when restacking or merging. Inspect
  `git log --format=fuller` and use the merge method selected by the existing
  `batched-changes` / `preserve-head-commit` contract.
- The original promotion-and-retirement roadmap remains open after this
  cutover: original Task 6, Task 7, Task 10, Task 11, the promotion/history/
  retry/override portions of Task 12, Tasks 13–16, the shared CandidateRecord
  fixture, and the sealed-file no-follow review are not completed here.

During execution, establish these roots once per shell and never infer the tap
checkout from ambient current-directory state:

```bash
export KANDELO_ROOT=/Users/brandon/emdash/worktrees/Kandelo/emdash/homebrew-pr-staging-1q1w6
export TAP_PARENT=$(mktemp -d)
export TAP_ROOT="$TAP_PARENT/homebrew-tap-core"
git clone --filter=blob:none \
  https://github.com/Kandelo-dev/homebrew-tap-core.git "$TAP_ROOT"
git -C "$TAP_ROOT" fetch origin main --no-tags
git -C "$TAP_ROOT" checkout -b abi-staging-bounded-request-discovery origin/main
```

---

### Task 1: Repair Bootstrap Package Output Ownership

**Files:**
- Create: `packages/registry/mariadb/mariadb-glue-object-contract.cmake`
- Create: `scripts/test-package-isolated-output-contracts.sh`
- Modify: `packages/registry/tcl/build-tcl.sh`
- Modify: `packages/registry/mariadb/build-mariadb.sh`
- Modify: `packages/registry/mariadb/build.toml`
- Modify: `packages/registry/mariadb/wasm32-posix-toolchain.cmake`
- Modify: `packages/registry/mariadb/wasm64-posix-toolchain.cmake`
- Modify: `packages/registry/php/build-php.sh`
- Regenerate: `packages/registry/program-packages.json`
- Modify: `scripts/test-package-build-roots.sh`

**Interfaces:**
- Consumes: resolver-owned `WASM_POSIX_DEP_OUT_DIR`, the package work root
  selected by `kandelo_package_prepare_build_roots`, and the sealed-install
  interface in `scripts/install-local-binary.sh`.
- Produces: CMake cache variable
  `WASM_POSIX_MARIADB_GLUE_OBJ_DIR:PATH`, which must be absolute and contain
  regular `channel_syscall.o` and `compiler_rt.o` files; Tcl diagnostics that
  inspect `$TCLSH`; PHP sealed installs with
  `WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto`.

- [ ] **Step 1: Add focused RED tests for all three regressions**

  Create `scripts/test-package-isolated-output-contracts.sh` with a private
  temporary root and these assertions:

  ```bash
  #!/usr/bin/env bash
  set -euo pipefail

  REPO_ROOT=$(git rev-parse --show-toplevel)
  TEST_ROOT=$(mktemp -d)
  trap 'rm -rf "$TEST_ROOT"' EXIT

  fail() {
    echo "test-package-isolated-output-contracts: $*" >&2
    exit 1
  }

  tcl="$REPO_ROOT/packages/registry/tcl/build-tcl.sh"
  grep -F 'ls -lh "$TCLSH"' "$tcl" >/dev/null ||
    fail "Tcl does not inspect the resolver-owned tclsh"
  if awk '/if \[ -n "\$\{WASM_POSIX_DEP_OUT_DIR:-\}" \]; then/,/else/' \
      "$tcl" | grep -F '$SCRIPT_DIR/bin/tclsh.wasm' >/dev/null; then
    fail "Tcl resolver mode still reads a checkout-local output"
  fi

  php="$REPO_ROOT/packages/registry/php/build-php.sh"
  awk '/if \[ -n "\$\{WASM_POSIX_DEP_OUT_DIR:-\}" \]; then/,/else/' \
      "$php" | grep -F 'WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto' \
      >/dev/null || fail "PHP sealed install lacks explicit fork policy"

  glue="$TEST_ROOT/glue"
  mkdir -p "$glue"
  : >"$glue/channel_syscall.o"
  : >"$glue/compiler_rt.o"
  driver="$TEST_ROOT/driver.cmake"
  cat >"$driver" <<'CMAKE'
  include("${CONTRACT}")
  kandelo_mariadb_glue_object_flags(result)
  file(WRITE "${RESULT}" "${result}")
  CMAKE
  cmake -DCONTRACT="$REPO_ROOT/packages/registry/mariadb/mariadb-glue-object-contract.cmake" \
    -DRESULT="$TEST_ROOT/result" \
    -DWASM_POSIX_MARIADB_GLUE_OBJ_DIR="$glue" -P "$driver"
  grep -F "$glue/channel_syscall.o" "$TEST_ROOT/result" >/dev/null ||
    fail "MariaDB glue contract omitted channel_syscall.o"
  grep -F "$glue/compiler_rt.o" "$TEST_ROOT/result" >/dev/null ||
    fail "MariaDB glue contract omitted compiler_rt.o"

  symlink_glue="$TEST_ROOT/symlink-glue"
  mkdir -p "$symlink_glue"
  ln -s "$glue/channel_syscall.o" "$symlink_glue/channel_syscall.o"
  cp "$glue/compiler_rt.o" "$symlink_glue/compiler_rt.o"
  for bad in missing relative symlink; do
    err="$TEST_ROOT/$bad.err"
    args=()
    if [ "$bad" = relative ]; then
      args=(-DWASM_POSIX_MARIADB_GLUE_OBJ_DIR=relative)
    elif [ "$bad" = symlink ]; then
      args=(-DWASM_POSIX_MARIADB_GLUE_OBJ_DIR="$symlink_glue")
    fi
    if cmake -DCONTRACT="$REPO_ROOT/packages/registry/mariadb/mariadb-glue-object-contract.cmake" \
        -DRESULT="$TEST_ROOT/$bad.result" "${args[@]}" -P "$driver" \
        >"$TEST_ROOT/$bad.out" 2>"$err"; then
      fail "MariaDB glue contract accepted $bad authority"
    fi
  done

  grep -F -- '-DWASM_POSIX_MARIADB_GLUE_OBJ_DIR="$GLUE_OBJ_DIR"' \
    "$REPO_ROOT/packages/registry/mariadb/build-mariadb.sh" >/dev/null ||
    fail "MariaDB build does not pass its resolver-owned glue directory"

  echo "test-package-isolated-output-contracts: PASS"
  ```

  Add this invocation to `scripts/test-package-build-roots.sh` after the
  caller-owned output checks:

  ```bash
  bash "$REPO_ROOT/scripts/test-package-isolated-output-contracts.sh"
  ```

- [ ] **Step 2: Run the focused test and verify the expected failures**

  Run:

  ```bash
  scripts/dev-shell.sh bash scripts/test-package-isolated-output-contracts.sh
  ```

  Expected: FAIL because the CMake contract file is absent; after temporarily
  limiting the test to Tcl/PHP, Tcl reports the checkout-local diagnostic and
  PHP reports the missing explicit fork policy.

- [ ] **Step 3: Make Tcl diagnostics follow the selected output**

  In `packages/registry/tcl/build-tcl.sh`, keep the direct-build compatibility
  copy inside the no-`WASM_POSIX_DEP_OUT_DIR` branch, but change the diagnostic
  to:

  ```bash
  echo "==> tclsh.wasm built:"
  ls -lh "$TCLSH"
  ```

  Do not create or read `$SCRIPT_DIR/bin` in resolver mode.

- [ ] **Step 4: Add the closed MariaDB glue-object CMake contract**

  Implement `mariadb-glue-object-contract.cmake` as:

  ```cmake
  function(kandelo_mariadb_glue_object_flags output_variable)
    if(NOT DEFINED WASM_POSIX_MARIADB_GLUE_OBJ_DIR OR
       "${WASM_POSIX_MARIADB_GLUE_OBJ_DIR}" STREQUAL "")
      message(FATAL_ERROR
        "WASM_POSIX_MARIADB_GLUE_OBJ_DIR must name the prepared glue directory")
    endif()
    if(NOT IS_ABSOLUTE "${WASM_POSIX_MARIADB_GLUE_OBJ_DIR}")
      message(FATAL_ERROR
        "WASM_POSIX_MARIADB_GLUE_OBJ_DIR must be absolute")
    endif()
    set(channel "${WASM_POSIX_MARIADB_GLUE_OBJ_DIR}/channel_syscall.o")
    set(compiler_rt "${WASM_POSIX_MARIADB_GLUE_OBJ_DIR}/compiler_rt.o")
    foreach(object IN ITEMS "${channel}" "${compiler_rt}")
      if(NOT EXISTS "${object}" OR IS_DIRECTORY "${object}" OR
         IS_SYMLINK "${object}")
        message(FATAL_ERROR "MariaDB glue object is absent: ${object}")
      endif()
    endforeach()
    set(${output_variable} "${channel} ${compiler_rt}" PARENT_SCOPE)
  endfunction()
  ```

  In both toolchains, replace `_TOOLCHAIN_DIR2` / `_GLUE_OBJ_DIR` inference
  with:

  ```cmake
  include("${CMAKE_CURRENT_LIST_DIR}/mariadb-glue-object-contract.cmake")
  kandelo_mariadb_glue_object_flags(MARIADB_GLUE_OBJECT_FLAGS)
  ```

  and insert `${MARIADB_GLUE_OBJECT_FLAGS}` into
  `CMAKE_EXE_LINKER_FLAGS_INIT`.

  In `build-mariadb.sh`, pass the exact prepared directory to the main CMake
  invocation:

  ```bash
  -DWASM_POSIX_MARIADB_GLUE_OBJ_DIR="$GLUE_OBJ_DIR" \
  ```

- [ ] **Step 5: Declare PHP sealed-install instrumentation policy**

  Change the resolver-mode loop in `packages/registry/php/build-php.sh` to:

  ```bash
  WASM_POSIX_INSTALL_LOCAL_MIRROR=0 \
  WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto \
      install_local_binary php "$BIN_DIR/$artifact" "$artifact"
  ```

  Keep direct developer installs unchanged. `auto` must validate the already
  instrumented CLI/FPM and safely no-op for extension modules that do not
  import `kernel_fork`.

- [ ] **Step 6: Run focused and existing sealed-output gates**

  Run:

  ```bash
  scripts/dev-shell.sh bash scripts/test-package-isolated-output-contracts.sh
  scripts/dev-shell.sh bash scripts/test-install-local-binary-sealed.sh
  scripts/dev-shell.sh bash scripts/test-package-build-roots.sh
  bash -n packages/registry/tcl/build-tcl.sh
  bash -n packages/registry/mariadb/build-mariadb.sh
  bash -n packages/registry/php/build-php.sh
  ```

  Expected: all commands exit 0.

- [ ] **Step 7: Commit the bootstrap fixes**

  ```bash
  git add \
    packages/registry/tcl/build-tcl.sh \
    packages/registry/mariadb/build-mariadb.sh \
    packages/registry/mariadb/build.toml \
    packages/registry/mariadb/wasm32-posix-toolchain.cmake \
    packages/registry/mariadb/wasm64-posix-toolchain.cmake \
    packages/registry/mariadb/mariadb-glue-object-contract.cmake \
    packages/registry/php/build-php.sh \
    packages/registry/program-packages.json \
    scripts/test-package-isolated-output-contracts.sh \
    scripts/test-package-build-roots.sh
  git commit -m "[Packages] Keep staged outputs in resolver roots"
  ```

---

### Task 2: Land the Bootstrap Kandelo Pull Request Safely

**Files:**
- No additional source files.
- Inspect: pull request `Automattic/kandelo#1247` and its current Actions runs.

**Interfaces:**
- Consumes: Task 1 commit and GitHub's exact PR head/check inventory.
- Produces: protected `Automattic/kandelo/main` containing the staging
  machinery and package fixes. This task does not claim that #1247 itself was
  staged by bottles.

- [ ] **Step 1: Refresh the exact PR and CI state**

  ```bash
  gh pr view 1247 --repo Automattic/kandelo \
    --json headRefOid,baseRefOid,mergeStateStatus,reviewDecision,labels,statusCheckRollup
  gh run list --repo Automattic/kandelo --branch emdash/homebrew-pr-staging-1q1w6 \
    --limit 20 --json databaseId,workflowName,headSha,status,conclusion,url
  ```

  Record any newly failing job before rerunning. Do not retain the earlier
  four-job diagnosis if the current run exposes a different failure.

- [ ] **Step 2: Push the two design commits and Task 1**

  ```bash
  git push origin HEAD:emdash/homebrew-pr-staging-1q1w6
  ```

  Verify the remote head equals `git rev-parse HEAD`.

- [ ] **Step 3: Rerun only the failed current-head jobs**

  Select the newest failed `Staging build` run whose `headSha` equals the PR
  head, then run:

  ```bash
  run_id=$(gh run list --repo Automattic/kandelo \
    --branch emdash/homebrew-pr-staging-1q1w6 \
    --workflow staging-build.yml --limit 20 \
    --json databaseId,headSha,status,conclusion \
    --jq --arg head "$(git rev-parse HEAD)" \
      '[.[] | select(.headSha == $head and .conclusion == "failure")][0].databaseId')
  if [ "$run_id" != null ] && [ -n "$run_id" ]; then
    gh run rerun "$run_id" --repo Automattic/kandelo --failed
    gh run watch "$run_id" --repo Automattic/kandelo --exit-status
  fi
  ```

- [ ] **Step 4: Require every merge authority to be current and green**

  ```bash
  gh pr checks 1247 --repo Automattic/kandelo --required --watch
  gh pr view 1247 --repo Automattic/kandelo \
    --json headRefOid,mergeStateStatus,reviewDecision,labels
  ```

  Confirm the displayed head still equals the tested head. Do not merge while
  a required check is pending, skipped unexpectedly, stale, or failed.

- [ ] **Step 5: Merge with the repository-selected method**

  Inspect labels and use exactly one command:

  ```bash
  labels=$(gh pr view 1247 --repo Automattic/kandelo --json labels \
    --jq '[.labels[].name]')
  if jq -e 'index("preserve-head-commit") != null' <<<"$labels" >/dev/null; then
    gh pr merge 1247 --repo Automattic/kandelo --merge
  elif jq -e 'index("batched-changes") != null' <<<"$labels" >/dev/null; then
    gh pr merge 1247 --repo Automattic/kandelo --rebase
  else
    gh pr merge 1247 --repo Automattic/kandelo --squash
  fi
  ```

  Expected: GitHub accepts the merge only after current required checks and
  review policy pass.

---

### Task 3: Replace Broad Tap Release Discovery with Bounded Tag Discovery

**Files (in `Kandelo-dev/homebrew-tap-core`):**
- Modify: `scripts/abi_staging/github_public.py`
- Modify: `scripts/abi_staging/tests/test_github_public.py`
- Modify: `scripts/test_check_abi_staging_workflows.rb`
- Modify: `scripts/check_abi_staging_workflows.rb`

**Interfaces:**
- Consumes: `RequestIssuerPolicyV1.request_release_tag_prefix`,
  `max_release_pages`, `max_release_assets`, `max_api_response_bytes`, and the
  existing `discover_url(url, created_at=...)` validator.
- Produces: `GitHubPublicClient.scan() -> tuple[DiscoveredRequestV1, ...]`
  with identical selection semantics but no call to the broad
  `/repos/Automattic/kandelo/releases` endpoint.

- [ ] **Step 1: Create an isolated tap worktree from current protected main**

  Use the using-git-worktrees skill. Run the root-establishment commands in the
  Global Constraints section, then record:

  ```bash
  git -C "$TAP_ROOT" rev-parse HEAD >"$TAP_PARENT/tap-base.sha"
  git -C "$TAP_ROOT" status --short --branch
  ```

- [ ] **Step 2: Rewrite the discovery test as a bounded namespace RED**

  Replace the broad-release fixture in
  `test_scan_paginates_releases_and_assets_and_matches_manual_discovery` with:

  ```python
  refs = (
      "https://api.github.com/repos/Automattic/kandelo/"
      "git/matching-refs/tags/abi-staging-pr-"
  )
  opener.add(
      f"{refs}?per_page=1&page=1",
      json_response([{
          "ref": "refs/tags/abi-staging-pr-19",
          "object": {"type": "commit", "sha": "1" * 40},
      }]),
  )
  opener.add(f"{refs}?per_page=1&page=2", json_response([]))
  release = (
      "https://api.github.com/repos/Automattic/kandelo/"
      "releases/tags/abi-staging-pr-19"
  )
  opener.add(
      release,
      json_response({
          "id": 9,
          "tag_name": "abi-staging-pr-19",
          "prerelease": True,
          "draft": False,
          "assets": [{
              "id": 11,
              "name": asset_name,
              "browser_download_url": public_url,
              "created_at": ASSET_CREATED_AT,
          }],
      }),
  )
  ```

  Assert `opener.calls` contains no URL ending in `/releases` or
  `/releases?...`.

  Add subtests that reject duplicate refs, tags outside
  `abi-staging-pr-<positive integer>`, tag counts beyond
  `max_release_assets`, a release-by-tag response whose tag differs, a
  non-public prerelease, duplicate assets, and an API page larger than 4 MiB.

- [ ] **Step 3: Run the RED test**

  From the Kandelo checkout:

  ```bash
  scripts/dev-shell.sh env \
    KANDELO_TAP_ROOT="$TAP_ROOT" \
    PYTHONPATH="$TAP_ROOT" \
    python3 -m unittest \
      scripts.abi_staging.tests.test_github_public.GitHubPublicClientTests \
      -v
  ```

  Expected: FAIL because `scan()` still calls `/releases`.

- [ ] **Step 4: Implement matching-ref and release-by-tag validation**

  Add these private methods to `GitHubPublicClient`:

  ```python
  def _request_release_tags(self) -> tuple[str, ...]:
      repository = self.policy.issuer_repository
      prefix = self.policy.request_release_tag_prefix
      endpoint = (
          f"https://api.github.com/repos/{repository}/"
          f"git/matching-refs/tags/{urllib.parse.quote(prefix, safe='')}"
      )
      refs = self._pages(endpoint)
      if len(refs) > self.policy.max_release_assets:
          raise PublicGitHubError("ABI staging request tag inventory is too large")
      tags: set[str] = set()
      for value in refs:
          ref = _bounded_text(value.get("ref"), "Git reference", 512)
          expected_prefix = f"refs/tags/{prefix}"
          if not ref.startswith(expected_prefix):
              raise PublicGitHubError("matching-ref response escaped its prefix")
          tag = ref.removeprefix("refs/tags/")
          if PR_TAG.fullmatch(tag) is None or tag in tags:
              raise PublicGitHubError("ABI staging request tag inventory is invalid")
          tags.add(tag)
      return tuple(sorted(tags, key=lambda tag: int(PR_TAG.fullmatch(tag).group(1))))
  ```

  Add `_release_by_tag(tag)` using exactly:

  ```python
  endpoint = (
      f"https://api.github.com/repos/{repository}/releases/tags/"
      f"{urllib.parse.quote(tag, safe='')}"
  )
  ```

  Require one mapping with matching `tag_name`, positive `id`,
  `prerelease is True`, `draft is False`, and an `assets` array bounded by
  `max_release_assets`. Reuse the existing asset identity, creation-time,
  canonical URL, body, digest, and duplicate checks. Keep the final sorted
  `DiscoveredRequestV1` output unchanged.

- [ ] **Step 5: Make the workflow checker reject broad discovery regressions**

  Extend `test_check_abi_staging_workflows.rb` to require the discovery module
  tests and to reject a mutation that restores
  `https://api.github.com/repos/{repository}/releases`. The workflow itself
  continues to call `discover-workflow-request`; no extra token or input is
  added.

- [ ] **Step 6: Run tap discovery and workflow gates**

  ```bash
  scripts/dev-shell.sh env \
    KANDELO_TAP_ROOT="$TAP_ROOT" \
    PYTHONPATH="$TAP_ROOT" \
    python3 -m unittest \
      scripts.abi_staging.tests.test_github_public \
      scripts.abi_staging.tests.test_reconcile \
      scripts.abi_staging.tests.test_workflow -v
  scripts/dev-shell.sh env KANDELO_TAP_ROOT="$TAP_ROOT" \
    ruby "$TAP_ROOT/scripts/test_check_abi_staging_workflows.rb"
  git -C "$TAP_ROOT" diff --check
  ```

  Expected: all commands exit 0.

- [ ] **Step 7: Commit and open the tap discovery PR**

  ```bash
  git -C "$TAP_ROOT" add \
    scripts/abi_staging/github_public.py \
    scripts/abi_staging/tests/test_github_public.py \
    scripts/check_abi_staging_workflows.rb \
    scripts/test_check_abi_staging_workflows.rb
  git -C "$TAP_ROOT" commit -m "[ABI] Bound public request discovery"
  git -C "$TAP_ROOT" push -u origin abi-staging-bounded-request-discovery
  pr_body="$TAP_PARENT/abi-staging-discovery-pr.md"
  cat >"$pr_body" <<'MARKDOWN'
  ## Why

  Scheduled ABI request discovery currently downloads the repository's entire
  GitHub Release inventory. That response has grown beyond the protected
  4 MiB response limit, so reconciliation cannot discover any request.

  ## What changed

  Discovery now enumerates only the bounded ABI request tag namespace, fetches
  each exact Release by tag, and retains the existing asset/body validation.

  ## Validation

  - Focused public-GitHub discovery unit tests
  - Reconciliation and workflow tests
  - ABI staging workflow checker
  MARKDOWN
  gh pr create --repo Kandelo-dev/homebrew-tap-core \
    --head abi-staging-bounded-request-discovery \
    --base main \
    --title "[ABI] Bound public request discovery" \
    --body-file "$pr_body"
  ```

  The PR body must put `## Why` first and explain the 4 MiB broad-listing
  failure before implementation details.

---

### Task 4: Prove the Hosted Observe-Mode Request Path

**Files:**
- Modify: `scripts/abi_staging/tests/test_policy.py` in the tap.
- Modify: `scripts/check_abi_staging_workflows.rb` in the tap.
- Modify: `scripts/test_check_abi_staging_workflows.rb` in the tap.
- Operational evidence: GitHub workflow runs and public readbacks; no checked-in
  activation change in this task.

**Interfaces:**
- Consumes: one exact `Automattic/kandelo` request Release asset URL and the
  merged Task 3 tap workflow.
- Produces: one retained observe-mode coordination run proving exact request
  discovery without candidate publication.

- [ ] **Step 1: Add namespace and observe-mode mutation coverage**

  The tap policy and workflow tests must reject all of these mutations:

  ```python
  def test_candidate_owner_must_match_tap_owner(self) -> None:
      source = TAP_ROOT / "Kandelo/staging/tap-policy.toml"
      with tempfile.TemporaryDirectory() as directory:
          candidate = Path(directory) / "tap-policy.toml"
          candidate.write_text(
              source.read_text().replace(
                  'candidate_owner = "kandelo-dev"',
                  'candidate_owner = "Automattic"',
              )
          )
          with self.assertRaisesRegex(PolicyError, "tap owner"):
              load_tap_staging_policy(candidate)
  ```

  ```ruby
  assert_rejected("promotion enabled during candidate canary") do |workflow|
    workflow.dig("jobs", "plan-promotion")["if"] = "success()"
  end
  ```

  Assert the flattened reviewed workflow has no
  `ghcr.io/Automattic/` string and all writer-side validation ultimately binds
  `tap-policy.toml.candidate_owner == "kandelo-dev"` and
  `candidate_repository_prefix == "homebrew-tap-core-abi-"`.

- [ ] **Step 2: Commit the added guards and merge the discovery PR**

  ```bash
  git -C "$TAP_ROOT" add \
    scripts/abi_staging/tests/test_policy.py \
    scripts/check_abi_staging_workflows.rb \
    scripts/test_check_abi_staging_workflows.rb
  git -C "$TAP_ROOT" commit -m "[ABI] Keep candidate canaries nonpromoting"
  git -C "$TAP_ROOT" push
  TAP_DISCOVERY_PR=$(gh pr view abi-staging-bounded-request-discovery \
    --repo Kandelo-dev/homebrew-tap-core --json number --jq .number)
  gh pr checks "$TAP_DISCOVERY_PR" \
    --repo Kandelo-dev/homebrew-tap-core --required --watch
  gh pr merge "$TAP_DISCOVERY_PR" \
    --repo Kandelo-dev/homebrew-tap-core --squash
  ```

  Re-fetch tap main and record the merged commit.

- [ ] **Step 3: Locate one exact current request asset**

  From the Kandelo request-feed run for the exact #1247 head, select the sole
  asset whose name binds that head:

  ```text
  candidate-request-<40 lowercase hex>-sha256-<64 lowercase hex>.json
  ```

  Use:

  ```bash
  REQUEST_TAG=abi-staging-pr-1247
  REQUEST_HEAD=$(gh pr view 1247 --repo Automattic/kandelo \
    --json headRefOid --jq .headRefOid)
  REQUEST_ASSET_URL=$(gh release view "$REQUEST_TAG" \
    --repo Automattic/kandelo --json assets \
    --jq --arg head "$REQUEST_HEAD" \
      '[.assets[] | select(.name | startswith("candidate-request-" + $head + "-sha256-"))] | if length == 1 then .[0].url else error("request asset is not unique") end')
  export REQUEST_ASSET_URL
  ```

  Record its name, byte size, and SHA-256. Do not use a mutable `latest` URL.

- [ ] **Step 4: Dispatch protected tap main with the exact URL**

  ```bash
  gh workflow run abi-staging-reconcile.yml \
    --repo Kandelo-dev/homebrew-tap-core \
    --ref main \
    -f request_asset_url="$REQUEST_ASSET_URL"
  ```

  Select the resulting run by workflow, event `workflow_dispatch`, current tap
  main SHA, and creation time; then watch it to completion.

- [ ] **Step 5: Verify observe-mode non-mutation**

  Require all of the following from the run and public repositories:

  - `discover-plan` succeeds and reports `selected=true`.
  - coordination reports `mode=observe` and `product_mode=observe`.
  - candidate, reuse, verification, product publication, and promotion writer
    jobs are skipped.
  - tap `main`, `abi/*` refs, Formula files, and promotion activation are
    unchanged across the run.
  - no package version or tag appears under an Automattic GHCR namespace.

  Save the run URL, request URL/digest, tap commit/tree, and Kandelo exact head
  in the implementation report.

---

### Task 5: Activate Request and Candidate Production in Separate Changes

**Files (Kandelo request activation):**
- Modify: `abi/staging/request-feed-activation.toml`
- Modify: `scripts/test-abi-staging-request-feed.sh`
- Modify: `scripts/check-abi-staging-request-workflow.rb`

**Files (tap activations):**
- Modify: `Kandelo/staging/reconciliation-activation.toml`
- Modify: `Kandelo/staging/candidate-publication-activation.toml`
- Modify: `Kandelo/staging/product-evidence-activation.toml`
- Modify: `scripts/abi_staging/tests/test_reconcile.py`
- Modify: `scripts/abi_staging/tests/test_policy.py`
- Modify: `scripts/abi_staging/tests/test_product_evidence.py`
- Modify: `scripts/test_check_abi_staging_workflows.rb`

**Interfaces:**
- Consumes: the successful observe canary and the exact request asset from
  Task 4.
- Produces: public requests in active mode, Kandelo-dev candidate bottles and
  verification receipts, and protected Node/browser product evidence.
  Promotion remains disabled.

- [ ] **Step 1: Turn the Kandelo request feed test RED for active mode**

  Change the final assertion in `scripts/test-abi-staging-request-feed.sh` to:

  ```bash
  [[ $activation == active ]] || {
    echo "request feed activation must be active after the hosted observe canary" >&2
    exit 1
  }
  ```

  Extend `check-abi-staging-request-workflow.rb` so the publisher must retain
  both branches:

  ```ruby
  publish_source.include?("if [[ $mode == observe ]]") &&
    publish_source.include?("elif [[ $mode == active ]]")
  ```

- [ ] **Step 2: Run the RED request-feed gate**

  ```bash
  scripts/dev-shell.sh bash scripts/test-abi-staging-request-feed.sh
  ```

  Expected: FAIL because the checked-in activation is still `observe`.

- [ ] **Step 3: Activate and commit the Kandelo request feed**

  Change only:

  ```toml
  schema = 1
  kind = "kandelo-abi-staging-request-feed-activation"
  mode = "active"
  ```

  Run the request-feed gate, request-policy Rust tests, workflow checker, and
  `git diff --check`; then commit:

  ```bash
  git commit -m "[ABI] Activate exact staging requests"
  ```

  Open and merge this as a separate Kandelo PR. After merge, manually dispatch
  the request feed for the canary PR and anonymously read back the exact public
  asset.

- [ ] **Step 4: Activate tap reconciliation alone**

  In a fresh tap branch, first update
  `test_activation_is_strict_observe_only` to assert the checked-in mode is
  `active` while retaining parser tests for both valid values and all invalid
  values. Record RED, then change only:

  ```toml
  schema = 1
  kind = "kandelo-abi-staging-reconciliation-activation"
  mode = "active"
  ```

  Run `test_reconcile`, `test_workflow`, and the Ruby workflow checker. Merge
  the PR only after CI passes. Dispatch the exact request and verify candidate
  jobs remain skipped because candidate publication is still observe.

- [ ] **Step 5: Activate tap candidate publication**

  In a new tap branch, change the checked-in expectation in `test_policy.py`,
  record RED, then set:

  ```toml
  schema = 1
  kind = "kandelo-candidate-publication-activation"
  mode = "active"
  ```

  Run `test_policy`, `test_reconcile`, `test_execution`, `test_records`, and the
  Ruby checker. Merge only after CI passes.

- [ ] **Step 6: Dispatch and verify candidate publication**

  Dispatch the exact request URL again. Require:

  - every selected candidate/reuse job reaches one terminal record;
  - every selected Formula has a valid verification receipt;
  - anonymous readback matches each manifest/config/layer digest and size;
  - every repository begins
    `ghcr.io/kandelo-dev/homebrew-tap-core-abi-<ABI>/`;
  - no `ghcr.io/Automattic/` repository was created or updated; and
  - all promotion jobs remain skipped because promotion is disabled.

- [ ] **Step 7: Activate tap product evidence**

  In a third tap branch, update the checked-in expectation in
  `test_product_evidence.py`, record RED, then set:

  ```toml
  schema = 1
  kind = "kandelo-vfs-product-evidence-activation"
  mode = "active"
  ```

  Run `test_product_evidence`, `test_reconcile`, `test_workflow`, and the Ruby
  checker. Merge only after CI passes.

- [ ] **Step 8: Dispatch and verify complete candidate/product evidence**

  Require terminal success for all selected Formulae, products, Node evidence,
  and browser evidence. Re-run anonymous readback after the workflow completes.
  Record exact public record digests and the final `Kandelo PR Check` computed
  conclusion while the Check is still observe-neutral.

---

### Task 6: Enforce the Exact-Head Check and Protected Merge Status

**Files:**
- Modify: `abi/staging/required-check-activation.toml`
- Modify: `.github/workflows/abi-staging-merge-gate.yml`
- Modify: `scripts/check-abi-staging-pr-check-workflow.rb`
- Modify: `.github/scripts/test-merge-candidate-workflows.sh`
- Test: `tools/xtask/src/abi_staging/check_projection.rs`

**Interfaces:**
- Consumes: complete public evidence for the current exact request.
- Produces: enforced `Kandelo PR Check` conclusions and, only after a second
  protected revalidation on `ready-to-ship`, the existing `merge-gate=success`
  status on the exact PR head.

- [ ] **Step 1: Add RED workflow mutations for protected status publication**

  Extend the Ruby checker to require the final protected job to have exactly:

  ```ruby
  {
    "actions" => "read",
    "checks" => "read",
    "contents" => "read",
    "statuses" => "write"
  }
  ```

  Require the final source to publish status only after current Check and PR
  revalidation, with exact fields:

  ```text
  state=success
  context=merge-gate
  target_url=<validated current Check details URL>
  ```

  Add mutations that move the write before revalidation, publish in observe
  mode, change the context, write to another SHA, or grant `contents: write`.

- [ ] **Step 2: Run the RED checker**

  ```bash
  scripts/dev-shell.sh ruby scripts/check-abi-staging-pr-check-workflow.rb
  ```

  Expected: FAIL because the protected job has no status authority or write.

- [ ] **Step 3: Add the protected status write**

  After the existing exact Check and current PR revalidation, add:

  ```bash
  if [[ $mode != enforce ]]; then
    echo "::notice::observe mode never publishes merge-gate authority"
    exit 0
  fi
  gh api -X POST \
    -H 'Accept: application/vnd.github+json' \
    "/repos/$GITHUB_REPOSITORY/statuses/$PR_HEAD_SHA" \
    -f state=success \
    -f context=merge-gate \
    -f description='Exact staged bottles and product evidence succeeded.' \
    -f target_url="$details_url"
  ```

  Re-query the PR head and Check immediately before this block. The job gets
  `statuses: write` but no package, release, branch, or pull-request write
  permission.

- [ ] **Step 4: Turn the activation RED, then enforce it**

  Add a Rust test that reads the checked-in activation and expects
  `RequiredCheckActivationV1::Enforce`, while retaining the closed parser
  vectors for observe/enforce/invalid. Run it to observe failure, then set:

  ```toml
  schema = 1
  kind = "kandelo-abi-staging-required-check-activation"
  mode = "enforce"
  ```

- [ ] **Step 5: Run all protected Check and merge-evidence gates**

  ```bash
  scripts/dev-shell.sh ruby scripts/check-abi-staging-pr-check-workflow.rb
  scripts/dev-shell.sh bash .github/scripts/test-merge-candidate-workflows.sh
  host_target=$(scripts/dev-shell.sh rustc -vV | awk '/^host/ {print $2}')
  scripts/dev-shell.sh cargo test -p xtask --target "$host_target" \
    abi_staging::check_projection
  scripts/dev-shell.sh actionlint \
    .github/workflows/abi-staging-pr-check.yml \
    .github/workflows/abi-staging-merge-gate.yml
  ```

- [ ] **Step 6: Commit, merge, and prove one enforced result**

  Commit with:

  ```bash
  git commit -m "[ABI] Enforce exact staged product evidence"
  ```

  Merge after required CI, dispatch the PR Check for the canary PR, apply
  `ready-to-ship`, and require both the exact `Kandelo PR Check` and protected
  `merge-gate` status to succeed for the same head and external identity.

---

### Task 7: Derive the Protected ABI CI Route

**Files:**
- Create: `.github/scripts/classify-exact-abi-staging.sh`
- Create: `.github/scripts/test-classify-exact-abi-staging.sh`
- Modify: `.github/actions/detect-change-scope/ci-scope-paths.sh`
- Modify: `.github/actions/detect-change-scope/test-ci-scope-paths.sh`
- Modify: `.github/workflows/staging-build.yml`
- Modify: `.github/workflows/prepare-merge.yml`
- Modify: `.github/scripts/test-merge-candidate-workflows.sh`
- Modify: `scripts/check-homebrew-publish-workflow-trust.rb`
- Create: `scripts/ci-vitest-evidence-classes.tsv`
- Create: `scripts/pack-exact-abi-source-test-workspace.sh`
- Create: `scripts/test-pack-exact-abi-source-test-workspace.sh`
- Modify: `scripts/ci-run-test-suite.sh`
- Modify: `tests/scripts/ci-run-test-suite-groups.test.sh`
- Modify: `scripts/test-homebrew-main-shell-closure.sh`
- Modify: `tools/xtask/src/abi_staging/check_projection.rs`
- Modify: `tools/xtask/src/abi_staging/mod.rs`

**Interfaces:**
- Consumes: protected-base `xtask abi-staging request classify`, exact base and
  head commits, and the protected exact bytes of
  `abi/staging/required-check-activation.toml`.
- Produces these strict GitHub outputs:
  `exact_abi_staging_applicable=true|false`,
  `legacy_package_staging_required=true|false`, and one single-line
  `exact_abi_staging_reason`. Existing raw
  `package_archive_changed` remains unchanged for diagnostics. The workflow's
  public `package_staging_reason` output is the protected route reason when
  the exact route is selected and remains the existing scope reason otherwise.

- [ ] **Step 1: Write the RED classifier fixture**

  `test-classify-exact-abi-staging.sh` must create two temporary Git
  repositories: an immutable authority checkout and an exact-head checkout.
  It must exercise this CLI:

  ```bash
  bash .github/scripts/classify-exact-abi-staging.sh \
    --authority-root "$authority" \
    --exact-head-root "$candidate" \
    --base "$base" \
    --head "$head" \
    --raw-package-staging-required true \
    --github-output "$output"
  ```

  Cases:

  - ABI-classified change plus exact `enforce` activation => exact `true`,
    legacy `false`.
  - ABI change plus `observe` activation => exact `false`, legacy `true`.
  - host/kernel-only change => exact `false`, legacy preserves raw input.
  - non-ABI package-only change => exact `false`, legacy `true`.
  - missing/extra/duplicate/non-NUL path inventory, unavailable base/head, dirty
    authority, symlink activation, invalid boolean, or classifier failure =>
    command fails without outputs.

- [ ] **Step 2: Run the classifier RED**

  ```bash
  scripts/dev-shell.sh bash .github/scripts/test-classify-exact-abi-staging.sh
  ```

  Expected: FAIL because the classifier script is absent.

- [ ] **Step 3: Add a typed required-Check activation query**

  Extend `xtask abi-staging check-projection` with:

  ```text
  check-projection activation-mode --activation <absolute path>
  ```

  Reuse `parse_required_check_activation` and print exactly `observe` or
  `enforce` plus one newline. Add Rust tests for both accepted modes, invalid
  mode, extra TOML field, symlink/nonregular input, and unknown flags. Update
  the help string in `tools/xtask/src/abi_staging/mod.rs`.

  Run:

  ```bash
  host_target=$(scripts/dev-shell.sh rustc -vV | awk '/^host/ {print $2}')
  scripts/dev-shell.sh cargo test -p xtask --target "$host_target" \
    abi_staging::check_projection
  ```

- [ ] **Step 4: Implement the protected classifier**

  Parse only the named flags above. Validate both roots are absolute Git
  worktrees, `authority/HEAD` is clean, base/head are full lowercase SHAs, and
  both commits exist in the exact-head repository. Do not require the checked
  out `HEAD` to equal the subject head: `prepare-merge` intentionally has a
  synthetic merge checked out while the captured PR head remains the subject.
  Write a NUL-delimited inventory with:

  ```bash
  git -C "$exact_head_root" diff --name-only -z "$base...$head" \
    >"$private/changed-paths.nul"
  ```

  Build and run only the authority xtask:

  ```bash
  host_target=$(cd "$authority_root" && scripts/dev-shell.sh \
    rustc -vV | awk '/^host/ {print $2}')
  (cd "$authority_root" && scripts/dev-shell.sh cargo build -p xtask \
    --target "$host_target")
  "$authority_root/target/$host_target/debug/xtask" \
    abi-staging request classify \
    --changed-paths "$private/changed-paths.nul" \
    --out "$private/change-classes.json"
  ```

  Query activation with the authority xtask:

  ```bash
  activation=$(
    "$authority_root/target/$host_target/debug/xtask" \
      abi-staging check-projection activation-mode \
      --activation \
        "$authority_root/abi/staging/required-check-activation.toml"
  )
  ```

  Treat the route as exact only when the sorted class array contains `"abi"`
  and activation is exactly `enforce`.

  Write outputs atomically only after every validation succeeds.

- [ ] **Step 5: Add the route to both change-scope jobs**

  In each workflow, keep the exact PR/synthetic checkout, add a second
  `actions/checkout` of the captured base SHA into `abi-staging-authority`, and
  invoke only:

  ```yaml
  - name: Derive protected exact ABI staging route
    id: exact-abi
    run: |
      bash abi-staging-authority/.github/scripts/classify-exact-abi-staging.sh \
        --authority-root "$GITHUB_WORKSPACE/abi-staging-authority" \
        --exact-head-root "$GITHUB_WORKSPACE" \
        --base "${{ github.event.pull_request.base.sha }}" \
        --head "${{ github.event.pull_request.head.sha }}" \
        --raw-package-staging-required \
          "${{ steps.scope.outputs.package_staging_required }}" \
        --github-output "$GITHUB_OUTPUT"
  ```

  For `prepare-merge`, use the captured `synthesize-merge` base/head outputs,
  not live event projections.

  The existing route step must set:

  ```text
  package_staging_required = legacy_package_staging_required
  test_gate_required = true when exact_abi_staging_applicable is true
  ```

  Export `exact_abi_staging_applicable` from both jobs.

- [ ] **Step 6: Add workflow RED mutations before changing job routing**

  Tests must reject:

  - candidate-head classifier or activation use;
  - label/name-list/path-regex substitution for protected classification;
  - exact route with nonempty package matrix;
  - a PR staging Release write on the exact route;
  - legacy `binaries/` materialization on the exact route;
  - fallback from missing exact evidence to legacy staging;
  - exact route skipping source validation, early kernel suites, the isolated
    source-test workspace, source-only host Vitest, or libc/POSIX/Sortix
    conformance;
  - prepare-merge running its legacy candidate publisher on the exact route;
  - either workflow writing an Automattic GHCR package.

  Add both new classifier scripts to `ci_control_changed_files` and assert they
  set `test_gate_required` without setting `package_archive_changed`.

- [ ] **Step 7: Split staging-build's exact ABI path from legacy preparation**

  Keep `test-gate-validation`, `test-suite-early`, and `toolchain-cache`
  enabled for exact ABI staging. An exact ABI route forces both early Cargo
  suites to run even if the ordinary `kernel` scope bit is false; an ABI
  contract change is not allowed to turn a skipped job into evidence.

  Add a complete, checked-in classification of the live Vitest file inventory
  in `scripts/ci-vitest-evidence-classes.tsv`. Each non-fixture test file
  listed by `npx vitest list --filesOnly` must appear exactly once as either:

  ```text
  source-only
  prepared-product
  ```

  The inventory validator fails on a new, missing, duplicate, or unknown
  classification. `source-only` means the test may consume the exact source
  kernel, exact SDK/sysroot, and repository-built test fixtures, but may not
  resolve a package archive, `binaries/` overlay, product VFS, candidate OCI
  object, or network input. `prepared-product` names the old package-backed
  portion whose authority is replaced by the enforced protected Node/browser
  product evidence; it is not silently reclassified as source-only.

  Extend `ci-run-test-suite.sh` with `vitest exact-abi-source` so it runs every
  and only the `source-only` files, preserving the existing fresh-process
  handling for any resource-isolated case. Extend the suite-group test to
  prove inventory bijection, exact selection, duplicate/unknown rejection,
  and that a source-only test cannot import the binary resolver or another
  `prepared-product` test helper through the statically resolved local import
  closure.

  Add `exact-abi-source-test-prepare`, needing only `change-scope` and
  `toolchain-cache`. It checks out the exact head, extracts the exact toolchain
  artifact, builds the kernel and repository test programs through the normal
  source paths, installs the kernel into one private immutable local
  generation, and invokes
  `pack-exact-abi-source-test-workspace.sh`. The packer uses an explicit
  allowlist, rejects symlinks/nonregular files and undeclared additions, emits
  a canonical inventory with size and SHA-256 for every entry, and must reject
  any `binaries/`, package archive, product VFS, or package index. Add the
  focused packer test before the implementation.

  Add `exact-abi-source-test-suite` with these cells:

  ```text
  vitest exact-abi-source
  libc functional-regression
  libc math
  posix all
  sortix include
  sortix basic
  sortix runtime
  ```

  Every cell checks out the exact head, fetches only its declared conformance
  submodule, downloads and revalidates the canonical source-workspace
  inventory, and runs through `scripts/dev-shell.sh`. No cell downloads a
  legacy staging Release or reconstructs `binaries/`. Product/browser behavior
  remains owned by the independently enforced `Kandelo PR Check`; the ordinary
  pull-request `browser-demos-ci.yml` remains unchanged.

  Add `exact-abi-test-gate` with needs on `change-scope`,
  `test-gate-validation`, `test-suite-early`,
  `exact-abi-source-test-prepare`, and `exact-abi-source-test-suite`. It
  succeeds only when the route is exact and every producer result is success.

  Add `needs.change-scope.outputs.exact_abi_staging_applicable != 'true'` to
  all legacy package/prepared-workspace jobs:

  ```text
  preflight
  lib-matrix-build
  matrix-build
  repair-staging-index
  test-gate-prepare
  test-suite
  test-gate
  f2-status
  ```

  Exclude exact ABI staging from `package-staging-not-required`. Adjust the
  exact Homebrew shell aggregate so the legacy proof is skipped only on the
  exact route and the wrapper requires `exact-abi-test-gate=success`; the
  protected `Kandelo PR Check` remains the product proof.

- [ ] **Step 8: Split prepare-merge's exact ABI path from legacy candidates**

  Keep synthesis, approval, current-base checks, required-check inspection,
  source validation, `toolchain-cache`, the forced early Cargo suites, and the
  same exact source-workspace/conformance matrix against the synthesized merge.
  Skip staging-run lookup and every legacy candidate/prepared-workspace/
  publisher job when `exact_abi_staging_applicable == 'true'`. Do not reuse the
  PR-head workspace for the synthesized merge. Add an
  `exact-abi-prepare-gate` that requires:

  ```text
  synthesize-merge=success
  change-scope=success
  gate=success
  test-gate-validation=success
  test-suite-early=success
  exact-abi-source-test-prepare=success
  exact-abi-source-test-suite=success
  exact_abi_staging_applicable=true
  ```

  It must not write a Release, package, branch, Formula, or status. The
  protected `abi-staging-merge-gate.yml` from Task 6 owns the exact
  `merge-gate` status.

- [ ] **Step 9: Run all routing and workflow gates**

  ```bash
  scripts/dev-shell.sh bash .github/scripts/test-classify-exact-abi-staging.sh
  scripts/dev-shell.sh bash .github/actions/detect-change-scope/test-ci-scope-paths.sh
  scripts/dev-shell.sh bash .github/scripts/test-merge-candidate-workflows.sh
  scripts/dev-shell.sh bash scripts/test-pack-exact-abi-source-test-workspace.sh
  scripts/dev-shell.sh bash tests/scripts/ci-run-test-suite-groups.test.sh
  scripts/dev-shell.sh ruby scripts/check-homebrew-publish-workflow-trust.rb
  scripts/dev-shell.sh bash scripts/test-homebrew-main-shell-closure.sh
  scripts/dev-shell.sh actionlint \
    .github/workflows/staging-build.yml \
    .github/workflows/prepare-merge.yml \
    .github/workflows/abi-staging-merge-gate.yml
  git diff --check
  ```

- [ ] **Step 10: Commit the legacy cutover**

  This routing change cannot self-host while protected main still lacks the
  classifier and exact source-test lane. Its own PR therefore takes the final
  legacy bootstrap path. The first later ABI-applicable PR is the cutover
  canary; do not claim the route from Task 7's own CI run.

  ```bash
  git add \
    .github/scripts/classify-exact-abi-staging.sh \
    .github/scripts/test-classify-exact-abi-staging.sh \
    .github/actions/detect-change-scope/ci-scope-paths.sh \
    .github/actions/detect-change-scope/test-ci-scope-paths.sh \
    .github/workflows/staging-build.yml \
    .github/workflows/prepare-merge.yml \
    .github/scripts/test-merge-candidate-workflows.sh \
    scripts/check-homebrew-publish-workflow-trust.rb \
    scripts/ci-vitest-evidence-classes.tsv \
    scripts/pack-exact-abi-source-test-workspace.sh \
    scripts/test-pack-exact-abi-source-test-workspace.sh \
    scripts/ci-run-test-suite.sh \
    tests/scripts/ci-run-test-suite-groups.test.sh \
    scripts/test-homebrew-main-shell-closure.sh \
    tools/xtask/src/abi_staging/check_projection.rs \
    tools/xtask/src/abi_staging/mod.rs
  git commit -m "[ABI] Route staged ABIs through candidate bottles"
  ```

---

### Task 8: Run a Real ABI-Applicable Hosted Cutover Canary

**Files:**
- Create: `docs/plans/2026-08-11-abi-bottle-staging-cutover-report.md`
- Modify: `docs/plans/2026-08-11-abi-bottle-staging-cutover-design.md`
- Update local ledger:
  `.superpowers/sdd/2026-08-08-abi-staging-promotion-pages-and-retirement/progress.md`

**Interfaces:**
- Consumes: merged Tasks 1–7 and one same-repository ABI-applicable PR.
- Produces: hosted evidence that exact candidates/products replace the legacy
  package matrix for that PR. This is not Formula promotion or Pages
  deployment evidence.

- [ ] **Step 1: Open or select one ABI-applicable canary PR**

  Use the real ABI 43 PR when it is ready enough to run. The canary must change
  an ABI-classified path and pass the structural ABI contract. Do not create a
  fake ABI bump or modify ABI metadata solely to exercise routing.

- [ ] **Step 2: Prove the request and tap artifacts**

  Record exact identities for:

  - PR head commit/tree and ABI snapshot digest;
  - request Release tag, asset URL, asset SHA-256, and byte size;
  - tap main commit/tree and activation file digests;
  - candidate/reuse/verification terminal records per Formula;
  - product candidate and Node/browser evidence records per selected product;
  - final exact `Kandelo PR Check` external ID and details URL.

- [ ] **Step 3: Prove the legacy matrix was not used**

  In the exact-head `staging-build` run require:

  - `exact_abi_staging_applicable=true`;
  - `lib-matrix-build`, `matrix-build`, `repair-staging-index`,
    `test-gate-prepare`, package-dependent `test-suite`, and `f2-status` are
    skipped;
  - no `pr-<N>-staging-*` Release is created for the run;
  - source validation, forced kernel/fork suites, the isolated source-test
    preparation, source-only host Vitest, and libc/POSIX/Sortix conformance
    succeed; and
  - no `binaries/` overlay is downloaded or produced.

- [ ] **Step 4: Prove protected merge enforcement**

  Apply `ready-to-ship` only after current exact evidence succeeds. Require:

  - the protected Check remains success after re-projection;
  - the protected merge-evidence workflow posts `merge-gate=success` to the
    same exact head;
  - prepare-merge runs only synthesis, approval/current-base validation, and
    its exact ABI aggregate; and
  - no legacy merge-candidate Release, Formula update, ABI-history branch, or
    promotion record is written.

- [ ] **Step 5: Verify organization boundaries anonymously**

  Enumerate all OCI locators in the request's public records. Reject the
  canary if any locator does not begin:

  ```text
  ghcr.io/kandelo-dev/homebrew-tap-core-abi-<ABI>/
  ```

  Separately query Automattic packages and record that the run created no GHCR
  package there. GitHub Release assets in `Automattic/kandelo` are allowed only
  for the canonical request.

- [ ] **Step 6: Write the cutover report and preserve roadmap status**

  The report must state what ran, exact run/record URLs and digests, what did
  not run, and the remaining boundaries. Update the design's status to
  activated only after the hosted evidence exists.

  Append this exact status shape to the original roadmap ledger:

  ```text
  Priority bottle-first cutover: complete only for ABI-applicable PR candidate
  and product staging; legacy matrix remains for non-applicable package-only
  PRs. Original Task 6 incomplete; Task 7 observe-only; Task 10 inactive;
  Task 11 hosted acceptance remains broader than this canary; promotion,
  history, retry, and override work in Task 12 remains pending; Tasks 13-16 and
  both deferred review items remain pending.
  ```

- [ ] **Step 7: Commit the evidence report**

  ```bash
  git add \
    docs/plans/2026-08-11-abi-bottle-staging-cutover-design.md \
    docs/plans/2026-08-11-abi-bottle-staging-cutover-report.md
  git commit -m "[ABI] Record bottle-first staging cutover evidence"
  ```

---

### Task 9: Snapshot the Landing and Resume the Original Roadmap

**Files:**
- Inspect: both repository logs, merged PRs, activation documents, hosted run
  records, and the original roadmap ledger.
- No production mutation is required in this task.

**Interfaces:**
- Consumes: the Task 8 report and merged protected-main states.
- Produces: a precise handoff point from the priority cutover back to the
  original plan.

- [ ] **Step 1: Verify protected-main state in both repositories**

  Record:

  ```bash
  git -C "$KANDELO_ROOT" log -1 --format=fuller
  git -C "$TAP_ROOT" log -1 --format=fuller
  git -C "$KANDELO_ROOT" status --short
  git -C "$TAP_ROOT" status --short
  ```

  Re-read every activation document. Expected states after this tranche:

  ```text
  Kandelo request feed: active
  Kandelo required Check: enforce
  Tap reconciliation: active
  Tap candidate publication: active
  Tap product evidence: active
  Tap promotion: disabled
  Pages: inactive
  Cleanup deletion: absent/observe-only
  ```

- [ ] **Step 2: Run the final local contract set**

  Kandelo:

  ```bash
  scripts/dev-shell.sh bash scripts/test-package-build-roots.sh
  scripts/dev-shell.sh bash scripts/test-abi-staging-request-feed.sh
  scripts/dev-shell.sh ruby scripts/check-abi-staging-pr-check-workflow.rb
  scripts/dev-shell.sh bash .github/scripts/test-classify-exact-abi-staging.sh
  scripts/dev-shell.sh bash .github/actions/detect-change-scope/test-ci-scope-paths.sh
  scripts/dev-shell.sh bash .github/scripts/test-merge-candidate-workflows.sh
  scripts/dev-shell.sh ruby scripts/check-homebrew-publish-workflow-trust.rb
  ```

  Tap through the Kandelo dev shell:

  ```bash
  scripts/dev-shell.sh env KANDELO_TAP_ROOT="$TAP_ROOT" \
    PYTHONPATH="$TAP_ROOT" python3 -m unittest discover \
    -s "$TAP_ROOT/scripts/abi_staging/tests" -v
  scripts/dev-shell.sh env KANDELO_TAP_ROOT="$TAP_ROOT" \
    ruby "$TAP_ROOT/scripts/test_check_abi_staging_workflows.rb"
  ```

- [ ] **Step 3: Audit the unchanged prohibited surfaces**

  Compare against the pre-tranche bases and require no unreviewed change to:

  ```text
  Kandelo/staging/promotion-activation.toml
  abi/staging/pages-activation.toml
  tap cleanup deletion/tombstone workflow authority
  production Formula metadata
  abi/* history refs
  legacy package cleanup/deletion scripts
  ```

- [ ] **Step 4: Declare the next original-plan task**

  Resume original Task 6 (historical repair) unless a production incident or
  the pending ABI PR makes original Task 11's broader hosted-acceptance work
  more urgent. Do not mark any preserved item complete merely because the ABI
  candidate cutover succeeded.
