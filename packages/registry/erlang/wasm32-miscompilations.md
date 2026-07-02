# Erlang/OTP wasm32 `-O2` miscompilation registry

**Source of truth** for the wasm32 `-O2` codegen workarounds applied by
`build-erlang.sh`, the smoke case that guards each one, and the criteria for
ever removing them. `build-erlang.sh` references this file next to every
workaround it applies; the detection smoke
(`test/erlang.test.ts` + `test/wasm32-miscompilation-matrix.mjs`) references it
by smoke-case name. Adding or removing a workaround is **one reviewable edit
here plus a matching smoke row** — that coupling is deliberate, so the fix, the
guard, and the rationale never drift apart.

Design: `docs/plans/2026-07-02-erlang-wasm32-o2-miscompilation-coverage-design.md`
(`kd-r8h7`). Point-in-time audit of the full at-risk surface:
`test-runs/kd-jin7/audit-estack-wstack-20260702.md`.

> One-line summary of the bug class: LLVM's wasm32 backend at `-O2`
> miscompiles ERTS's "control struct whose pointer fields alias a **shadow-stack
> local array**, walked by a push/pop loop" idiom (`ESTACK`/`WSTACK`/`EQUEUE`/
> `DMC_STACK`). It manifests as **wrong results** (worst case silent) or an
> out-of-bounds trap, only once the term is big enough (> `DEF_*_SIZE == 16`) to
> leave the inline fast path.

---

## Triage runbook — "Erlang returns wrong output / crashes on Kandelo"

Follow this fixed path before assuming a new bug. It is the reactive process
made systematic:

1. **Does the operation walk terms or iodata?** term compare/sort, `phash2`,
   `term_to_binary`/`binary_to_term`, unicode conversion, ETS match/select,
   iolist/iodata (`iolist_to_binary`, checksums), or `~p`/`~w` printing. If yes,
   suspect this class. (If it does none of these, it is probably *not* this
   class — e.g. `erl_bif_binary.c`/`erl_bif_re.c` do not use the idiom.)
2. **Reproduce with a minimal `-eval`,** then confirm the *same input is correct
   on native OTP 28*. Native OTP is the oracle. A result that differs between
   native and Kandelo for a pure term operation is almost certainly this class.
3. **Rebuild just the suspect translation unit at `-O1`** (add a one-line
   `$(OBJDIR)/<tu>.o:` rule to the Makefile patch in `build-erlang.sh`, mirroring
   the existing ones). If the result becomes correct, it is facet 2 (traversal
   codegen). If it was a *trap* rather than a wrong value, a bounds guard
   (see `patches/patch-db-bounds-check.py`) may be the better containment.
4. **Land the fix and its guard together:** add a row to the table below **and**
   a row to the smoke matrix (`wasm32-miscompilation-matrix.mjs`) with a
   native-OTP oracle, in the same change. Link the discovering bead/PR.

---

## The bug class in one paragraph (facets)

The idiom declares a fixed 16-slot array on the C stack (which lives in the
wasm **shadow stack** / linear memory, because its address is taken) and a small
control struct (`start`/`sp`/`end`/`edefault`) pointing into it. There are
**two independent facets**:

- **Facet 1 — aggregate init.** The stock struct-literal initialization is
  miscompiled; fields can hold wrong values. Fixed **globally** by
  `patches/patch-global-h.py` (`estack_make_default_`/`wstack_make_default_`,
  explicit field assignment under `#ifdef __wasm32__`). Covers all ESTACK/WSTACK
  users. **Does not** cover `EQUEUE`/`DMC_STACK` (latent — see audit).
- **Facet 2 — traversal codegen.** Even with correct init, the push/pop/pointer
  loop is miscompiled in specific functions. **Not** fixed by init; this is what
  per-file `-O1` addresses.

`patches/patch-db-bounds-check.py` (`wasm_db_ptr_valid`) is a third, orthogonal
mitigation that converts a miscompiled OOB *trap* into a controlled failure. It
reduces blast radius; it does not make results correct, so it is not a
substitute for `-O1`.

**Key rule:** using the idiom is a *risk marker, not proof of breakage*. A file
can be correctly initialized (facet 1) and still wrong in its loop (facet 2). So
the init patch does **not** retire the risk, and detection (the smoke) is what
actually protects a given operation.

---

## Applied workarounds (the `-O1` / patch set)

Each row is a translation unit `build-erlang.sh` actively works around. "Guard"
is the smoke-matrix case name that must stay green.

| File | Symbol / function | Facet | Workaround | Discovered by | Guard (smoke case) |
| --- | --- | --- | --- | --- | --- |
| `erts/emulator/beam/global.h` | `ESTACK`/`WSTACK` `*_DEFAULT_VALUE`, `DECLARE_*` | 1 (init) | `patch-global-h.py` (explicit field init, `__wasm32__`) | initial wasm32 bring-up | *all* ESTACK/WSTACK cases (global) |
| `erts/emulator/beam/erl_unicode.c` | iodata → list traversal | 2 (traversal) | `-O1` (Makefile patch) | reactive: unicode conversion returned garbage | `unicode_deep` |
| `erts/emulator/beam/erl_db_util.c` | `db_is_fully_bound`, DMC match stack | 2 + trap | `-O1` **and** `patch-db-bounds-check.py` (`wasm_db_ptr_valid`) | reactive: ETS match OOB crash | `ets_match` |
| `erts/emulator/beam/erl_db_hash.c` | `match_traverse` | 2 (traversal)¹ | `-O1` (Makefile patch) | reactive: ETS traverse corruption | `ets_match` |
| `erts/emulator/beam/erl_db.c` | (whole TU) | — (consistency)² | `-O1` (Makefile patch) | kept at `-O1` for a uniform ETS opt level | `ets_match` |
| `erts/emulator/beam/erl_bif_chksum.c` | `do_chksum` (md5/crc32/adler32 over iodata) | 2 (traversal) | `-O1` **via PR #824 (`kd-qe2c`)** | reactive: `erlang:md5/1` on iolist → `badarg` → broke `beam_asm` → on-Kandelo `erlc` unusable | `chksum_iolist` |

¹ `erl_db_hash.c` `match_traverse` is a **hand-rolled** recursive traversal, not
a declared `ESTACK`/`WSTACK` site; its `-O1` was found reactively. It is in this
table because it is an applied workaround, not because it matches the idiom
grep.

² `erl_db.c` has **no confirmed miscompile of its own**; it is `-O1` only so the
ETS subsystem builds at one optimization level. If Layer A ever proves it safe,
it is the first candidate to return to `-O2`.

> **PR #824 sequencing.** On `origin/main` the `erl_bif_chksum.c` `-O1` row and
> its `chksum_iolist` smoke are **not present yet** — they land with PR #824
> (`kd-qe2c`). Anything that adds the `chksum_iolist` smoke must land with or
> after #824, or the guard fails against a still-`-O2` chksum.

---

## Audited but detection-only (no workaround applied)

The audit found high-risk idiom users with **no** confirmed miscompile. We do
**not** proactively `-O1` them (several are hot paths; unmeasured perf cost is a
design non-goal). They are covered by the smoke matrix so a *new* miscompile
fails CI instead of a user:

| File | Risk | Why detection-only | Guard (smoke case) |
| --- | --- | --- | --- |
| `erl_term_hashing.c` | HIGH | `make_hash`/`make_hash2` = `phash2` + internal map/ETS hashing; very hot | `phash2_deep` |
| `utils.c` | HIGH | `eq`/`cmp` underlie `==`, `<`, `lists:sort`, map keys; hot | `term_compare_sort` |
| `external.c` | HIGH | `enc_term`/`dec_term`; distribution + persistence | `term_to_binary_roundtrip` |
| `erl_map.c` | HIGH | highest idiom density; maps are pervasive | `term_compare_sort` (deep map keys) |
| `copy.c` | MEDIUM | `copy_struct`/`size_object`; message copy | `copy_large_term` |
| `erl_printf_term.c` | MEDIUM | `~p`/`~w` term printer | `format_p_deep` |
| `erl_iolist.c` / `erl_io_queue.c` | MEDIUM | `EQUEUE` iodata class (same family as chksum) | `iolist_to_binary_deep` |

Plus the end-to-end guard `compile_module` (`erlc`/`compile:file` of a
non-trivial module on-platform) — the original `kd-qe2c` failure mode, which
exercises `beam_asm`'s MD5-over-iolist plus general term traversal.

---

## CI gate wiring (Layer A.2) — how to promote the smoke to a hard gate

The detection matrix has two runners sharing one source
(`test/wasm32-miscompilation-matrix.ts`):

- **Local/dev:** `test/erlang.test.ts` (vitest), `skipIf` no local build. Runs
  the whole matrix in one BEAM boot; pending-PR cases are reported skips.
- **CI gate:** `test/run-wasm32-miscompilation-smoke.ts` — one boot, exits
  non-zero on any mismatch, on incompletion, and (critically) **if no active
  case ran** (a missing OTP runtime tree → false coverage, the design's
  highest-listed risk). Emits passed/failed/skipped outcome lists to
  `MISCOMP_OUTCOME_DIR`.

Drop this step into the Homebrew **bottle-build / smoke job** (the recommended
gate home — the OTP runtime tree is already staged there, next to the `hello`
smoke and the framebuffer gate), after `erlang.wasm` + the `erlang-install/`
tree are in place:

```yaml
- name: erlang wasm32 -O2 miscompilation smoke
  run: >
    bash scripts/dev-shell.sh npx tsx
    packages/registry/erlang/test/run-wasm32-miscompilation-smoke.ts
  env:
    MISCOMP_OUTCOME_DIR: test-runs/erlang-wasm32-miscomp
# then upload test-runs/erlang-wasm32-miscomp/* as durable outcome lists
```

Alternative gate home (if the bottle job is not the chosen host): a host test
that fetches + extracts the published `erlang-otp.tar.zst` sidecar into
`erlang-install/` first, then runs the same command. Requires the sidecar to be
a published, stable artifact (tracked by `kd-yuef`).

**Promotion status / blockers (as of 2026-07-02).** The runner is complete and
verified (native-OTP self-check: 8/8 active pass, 2 pending skip; negative
control fails; false-coverage guard fails). It is **not yet a hard PR gate**
because on `origin/main`:

1. There is no bottle-build/smoke job — it lives on the unmerged `kd-8ho`
   publishing branches; the framebuffer gate (`kd-ivdr` / spec `kd-jg94`) is
   likewise not on main. Coordinate the insertion point with those.
2. `erlang` is in CI's `disabled_pkgs` ("too slow to rebuild in CI") and in
   `WASM_POSIX_FETCH_SKIP_PKGS`, and the `erlang-otp` runtime tree is not in the
   published `binaries-abi` release — so no current CI job has the tree. Wiring
   it as a hard gate today would trip the false-coverage guard on every run.

Do **not** wire this into the current PR CI as a hard gate until (1) a job with
the runtime tree exists and (2) `chksum_iolist` / `compile_module` are un-gated
by PR #824. Until then the runner is invoked manually under `dev-shell` against
a local build, and the local vitest runner provides dev coverage.

## Removal checklist (Layer C exit ramp)

The `-O1` set is a permanent perf tax until removed. Remove a downgrade only
when **all** hold, and do it one file at a time:

- [ ] The toolchain pin (`flake.nix` LLVM) has advanced **past** a release with
      the fixed wasm32 backend, and the fix is cited here.
- [ ] The file's smoke case(s) pass at `-O2` with the `-O1` rule removed, in the
      **CI gate** runner (not just locally).
- [ ] For `erl_db.c` specifically: only remove after `erl_db_util.c` /
      `erl_db_hash.c` are proven safe (it is `-O1` for consistency with them).
- [ ] Update this table and the smoke matrix in the same commit; keep the smoke
      case (now a `-O2` regression guard).

No `-O1` is removed as a side effect of an OTP bump or a "cleanup" — it is a
deliberate, smoke-verified act.

---

## Re-audit trigger (OTP version bump)

**On any `OTP_VERSION` bump in `build-erlang.sh`, re-run the audit** — a new OTP
release can move code between files, add ESTACK/WSTACK/EQUEUE users, or shift the
line/text anchors the Makefile and `global.h` patches key off:

```sh
# from a fetched source tree: packages/registry/erlang/erlang-src
grep -rlE 'DECLARE_ESTACK|DECLARE_WSTACK|WSTACK_DECLARE|ESTACK_DECLARE|DECLARE_EQUEUE' \
  erts/emulator/beam
```

Then: (1) diff the file list against this registry; (2) confirm every applied
`-O1` file still exists and its patch anchor text is present (the patches
`exit`-fail loudly if an anchor is missing — do not "fix" that by skipping);
(3) re-validate every smoke oracle on the new native OTP and update any that
changed, noting the OTP version in the matrix.
