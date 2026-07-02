# kd-872c — xtask stale-fixture repair + gate: test outcome summary

Command (host target, inside `scripts/dev-shell.sh`):

```
scripts/dev-shell.sh cargo test -p xtask --target aarch64-apple-darwin -- --test-threads=1
```

Base: `53fb842e8` (kd-u7f validation-gates convoy base, ABI_VERSION 15).

## Counts

| Run | Base | ABI | Total | Passed | Failed | Ignored | Exit |
|---|---|---|---|---|---|---|---|
| Before (`repro-before-serial.log`) | `53fb842e8` (convoy) | 15 | 297 | 290 | 7 | 0 | 101 |
| After  (`after-serial.log`)        | `53fb842e8` (convoy) | 15 | 298 | 298 | 0 | 0 | 0   |
| After, rebased (`after-rebase-abi16.log`) | `origin/main` (PR base) | 16 | 315 | 315 | 0 | 0 | 0 |

The PR is rebased on `origin/main` (ABI 16), which carries 17 more xtask tests
than the convoy base, so the green total there is 315 rather than 298 — all pass,
including the version-relative Class C assertion, confirming the fix is
base-independent. Before/after on the convoy base (ABI 15) is the primary
7-failure repair evidence; the design doc independently confirmed the same 7
failures at ABI 16 (kd-1mr base `f4339836`).

Delta (convoy base): the 7 stale failures now pass, plus 1 new negative
regression-guard test
(`wasm_artifact_policy_rejects_empty_and_exportless_when_exports_required`).
No previously-passing test regressed.

Outcome lists: `before-{passed,failed,skipped}.txt`,
`after-{passed,failed,skipped}.txt`. Skipped is empty by construction — the
xtask suite declares no `#[ignore]` tests.

Note on the lists: two always-passing tests
(`build_into_cache_stderr_dup_pattern_does_not_panic`,
`ensure_built_fails_when_script_exits_nonzero`) interleave captured subprocess
stdout onto their inline result line under `--test-threads=1`, so their `... ok`
is recovered by name rather than by the raw grep. The authoritative counts are
the `test result:` summary lines above.

## The 7 repaired tests (were failing → now pass)

Class A (5) — build-script fixtures `touch`ed an empty `.wasm`, rejected by the
PR #605 output validation as "is not a wasm binary". Now emit valid wasm via
`emit_wasm_build_script` + `minimal_executable_wasm` (the kernel variant emits
the full `HOST_ADAPTER_REQUIRED_KERNEL_EXPORTS` set from the shared const):

- build_deps::tests::cmd_resolve_with_binaries_dir_places_single_output_symlink
- build_deps::tests::cmd_resolve_with_binaries_dir_places_kernel_at_root
- build_deps::tests::cmd_resolve_with_binaries_dir_places_multi_output_symlinks
- build_deps::tests::cmd_resolve_with_binaries_dir_replaces_existing_link
- build_deps::tests::cmd_resolve_without_binaries_dir_places_no_symlinks

Class B (1) — fetched-archive fixture was a wasm header only (no exports), so
`validate_cache_artifacts` reported "missing required exports" and the fetch fell
back to a source build (baddep `exit 42` → panic). Now uses a valid
`minimal_executable_wasm()`:

- build_deps::tests::binaries_dir_program_fetch_does_not_require_built_deps

Class C (1) — assertion hardcoded `abi4`; the canonical filename correctly
encodes the real ABI. Now version-relative via `shared::ABI_VERSION`:

- archive_stage_cli::tests::cli_produces_archive_with_canonical_filename

## Production validation unchanged

No product code changed. Only test fixtures/assertions plus a new negative
regression guard. The guard asserts empty/non-wasm → "is not a wasm binary" and
export-less wasm → "missing required exports", so a future change cannot weaken
validation to accommodate an empty fixture without turning this test red.

## CI gate + ABI verification

- `scripts/dev-shell.sh bash scripts/ci-run-test-suite.sh cargo-xtask` runs the
  new suite through the exact CI entrypoint: exit 0, 0 failed. This is the path
  wired into the `prepare-merge`, `staging-build`, and `force-rebuild` matrices.
- `scripts/dev-shell.sh bash scripts/check-abi-version.sh`: exit 0, "ABI_VERSION
  and snapshot are consistent" — this change does not perturb the ABI.
- Shell (`bash -n`) and YAML (all three workflows) validated.

Not run (this change touches none of these surfaces): vitest, musl libc-test,
Open POSIX, browser demos, kernel `--lib`. Reason recorded per the validation
contract: the diff is xtask test fixtures + CI suite wiring + docs only.
