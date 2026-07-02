# kd-jin7 — wasm32 -O2 miscompilation coverage (kd-r8h7 steps 1-4)

Date: 2026-07-02. Branch base: `origin/main` via convoy base f4339836e.
Implements the low-risk core (steps 1-4) of the `kd-r8h7` design:
`docs/plans/2026-07-02-erlang-wasm32-o2-miscompilation-coverage-design.md`.

## Delivered

- **Step 1 — Audit (Layer B2).** ESTACK/WSTACK/EQUEUE/DMC risk audit of OTP 28.2
  `erts/emulator/beam`. Artifacts: `audit-estack-wstack-20260702.md`,
  `audit-grep-raw.txt`. Corrected the design's guessed list (refuted
  `erl_bif_binary.c`/`erl_bif_re.c`; added `erl_term_hashing.c`, `erl_iolist.c`,
  `erl_io_queue.c`); surfaced a latent gap (facet-1 init patch covers only
  ESTACK/WSTACK, not EQUEUE/DMC_STACK).
- **Step 2 — Registry (Layer B1).** `packages/registry/erlang/wasm32-miscompilations.md`
  (triage runbook, applied-workaround table with chksum marked PR #824,
  detection-only table, CI wiring, removal checklist, OTP-bump re-audit trigger),
  referenced from `build-erlang.sh` at both workaround sites. Doc/comment-only:
  **no build output byte change → `build.toml` revision NOT bumped.**
- **Step 3 — Smoke matrix + local runner (Layer A.1).**
  `test/wasm32-miscompilation-matrix.ts` (single source of `{name, expr,
  expected}` with native-OTP-28 oracles, inputs sized past
  `DEF_*_SIZE == 16`); `test/erlang.test.ts` extended to run the whole matrix in
  one BEAM boot under `skipIf`.
- **Step 4 — CI gate runner (Layer A.2).**
  `test/run-wasm32-miscompilation-smoke.ts` — one boot, fails on mismatch, on
  incompletion, and on the false-coverage case (no active case ran). Emits
  passed/failed/skipped outcome lists. Wiring + promotion path documented in the
  registry (PR-gate promotion is blocked on infra — see Limitations).

## Verification (native OTP 28 — authoritative oracle source)

A real from-source `erlang.wasm` build was not run (see Limitations); the matrix
was instead validated end-to-end on native OTP 28 via `scripts/dev-shell.sh`,
which is exactly where the design says oracles must come from.

- **Positive self-check** (`native-selfcheck.txt`, `gate-outcomes-native/`):
  `GATE PASS`, exit 0. **8/8 active pass, 2 pending skip, matrix_done=10.**
- **Negative control:** corrupting one oracle produces
  `FAIL term_to_binary_roundtrip expected={deliberately,wrong} got={true,2741}`
  and a non-zero gate — proves the gate catches a plausible-but-wrong regression.
- **False-coverage guard:** with the OTP tree absent (BEAM emits nothing) the
  gate FAILs (`NO active case executed …`), exit 1 — the design's highest-listed
  risk is actively guarded, not silently passed.
- **Oracle cross-check:** `md5`/`crc32`/`adler32` oracle verified byte-for-byte
  against Python `hashlib`/`zlib`. Hand-verified oracles: `ets_match`
  {50,3775,51,100}, `iolist_to_binary_deep` {200,100,120,200}, `format_p_deep`
  length 293.
- **Syntax:** all three TS files pass esbuild transform.

### Outcome counts

| Category | Count | List |
| --- | --- | --- |
| passed (active) | 8 | `gate-outcomes-native/passed-tests.txt` |
| failed | 0 | `gate-outcomes-native/failed-tests.txt` |
| skipped (pending PR #824) | 2 | `gate-outcomes-native/skipped-tests.txt` |

## Limitations / skipped-with-reason

- **Full matrix on real `erlang.wasm`: not executed.** `erlang` is in CI's
  `disabled_pkgs` ("too slow to rebuild") and a from-source wasm build was out
  of proportion for a detection/registry change. Mitigation: validated on native
  OTP 28 (the oracle source); the runner is verified and ready for the gate job.
  A correctly-built Kandelo BEAM must reproduce the 8 oracles; a miscompiled one
  diverges (negative control proves detection).
- **Local `vitest` run of `erlang.test.ts`: not executed here.** The worktree
  has no `node_modules` and no local erlang build, so the suite `skipIf`s (by
  design). Syntax validated via esbuild; logic validated by running the shared
  matrix/runner directly on native OTP.
- **CI PR-gate wiring: deferred (documented, not landed).** The bottle-build/
  smoke job + framebuffer gate (`kd-ivdr`/`kd-jg94`) are not on `origin/main`,
  and no current CI job has the OTP runtime tree, so a hard gate would trip the
  false-coverage guard. Follow-up bead filed for promotion; coordinated by mail.
- **`chksum_iolist` + `compile_module`: pending PR #824 (`kd-qe2c`).** Their
  `-O1`/fix is not on this base, so they are reported as expected skips until
  #824 lands (flip `pendingPr` in the same change).
