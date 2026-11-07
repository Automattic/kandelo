# Erlang/OTP wasm32 -O2 Miscompilation Coverage Design

Date: 2026-07-02

Tracked work:

- `kd-r8h7` - [homebrew] Systematic wasm32 -O2 miscompilation coverage for
  Erlang/OTP.
- Follow-up from `kd-qe2c` - erlang:md5/1 badarg on iolist input (PR #824,
  in progress).

This is a design handoff for `kd-r8h7`. It does not implement the coverage,
smoke, audit, or upstream reports. It defines the problem, the bug class, a
layered strategy, and an implementation sequence that later beads can execute.

## Problem Statement

`packages/registry/erlang/build-erlang.sh` compiles a growing, **reactively
discovered** set of ERTS translation units at `-O1` to dodge LLVM wasm32 `-O2`
miscompilations. On `origin/main` (04e889cc0) the Makefile patch downgrades:

- `erl_unicode.c` - ESTACK iodata traversal returns garbage.
- `erl_db_util.c` - `db_is_fully_bound` out-of-bounds crash (ETS match).
- `erl_db_hash.c` - `match_traverse` corruption (ETS traverse).
- `erl_db.c` - kept at `-O1` for a consistent ETS optimization level.

A fifth file, `erl_bif_chksum.c` (`do_chksum` for `md5`/`crc32`/`adler32` over
iodata), is downgraded by the in-progress `kd-qe2c` fix on PR #824 and is **not
yet on `origin/main`**. Any coverage work must treat that file as arriving via
PR #824, not as already landed.

Each of these was found only when a real user hit it: unicode conversion
returning garbage, ETS match crashing, and - most damaging - `erlang:md5/1`
over an iolist returning `badarg`, which broke `beam_asm` and made **on-Kandelo
compilation (`erlc`/`compile:file`) unusable** because `beam_asm` MD5-hashes a
module's BEAM chunks as an iolist.

The common thread is a single wasm32 codegen bug class (characterized below).
Other BEAM files that walk term/iodata structures via the same idiom may harbor
the same defect and **ship silently until a user trips them**. The current
posture is whack-a-mole: we pay a production-incident cost per discovery, and we
have no systematic way to (a) detect a new instance early, (b) know which files
are at risk, or (c) ever remove the `-O1` workarounds.

The goal of `kd-r8h7` is to convert this reactive posture into a systematic one
without over-correcting into a blanket `-O1` build.

## Non-Goals

- **Do not rebuild all of ERTS (or all of BEAM) at `-O1`.** That is the
  explicit non-goal on the bead: unmeasured but real steady-state performance
  cost, and overkill for a bug confined to one code idiom.
- Do not treat this as a correctness blocker. The known cases are fixed; this
  is hardening and regression-prevention.
- Do not fix the LLVM wasm32 backend or OTP in this work. Upstream engagement
  is a track we open (Layer C), not a deliverable we complete here.
- Do not remove any existing `-O1` downgrade or the `global.h` init patch as
  part of this work. Removal is gated on Layer C landing and is out of scope.
- Do not block or duplicate PR #824. This design consumes the `erl_bif_chksum.c`
  workaround from that PR; it does not re-implement it.

## Bug Class Characterization

Understanding the defect precisely is what lets us bound the risk surface
instead of guessing.

### The idiom

ERTS avoids unbounded C recursion when walking arbitrarily deep terms and
iodata by using explicit heap-or-stack work stacks: `ESTACK` (a stack of
`Eterm`) and `WSTACK` (a stack of `UWord`), declared with `DECLARE_ESTACK(s)` /
`WSTACK_DECLARE(s)` (see `erts/emulator/beam/global.h`). The macro:

1. declares a fixed-size **local array on the C stack**
   (`Eterm ESTK_DEF_STACK(s)[DEF_ESTACK_SIZE]`), and
2. initializes a small control struct (`ErtsEStack`/`ErtsWStack`) whose fields
   (`start`, `sp`, `end`, `edefault`) are **pointers into that local array**.

On wasm, C-stack locals whose address is taken live in the **shadow stack**
(linear memory), not in wasm locals. So the idiom is precisely "a struct whose
pointer fields alias a shadow-stack local array," initialized by aggregate /
compound-literal assignment.

### The defect - two facets of one bug

LLVM's wasm32 backend at `-O2` miscompiles this idiom. The existing workarounds
reveal that it has **two distinct facets**:

1. **Aggregate initialization.** The stock `ESTACK_DEFAULT_VALUE` /
   `DECLARE_ESTACK` expand to a struct-literal initialization of the pointer
   fields. At `-O2` the initialized fields can hold wrong values.
   `patches/patch-global-h.py` fixes this **globally** by replacing the
   aggregate init with explicit field-by-field assignment through an inline
   helper (`estack_make_default_` / `wstack_make_default_`) under `#ifdef
   __wasm32__`. Because it edits the shared macro, every ESTACK/WSTACK user gets
   the corrected initialization.

2. **Optimized traversal codegen.** Even with correct initialization, `-O2`
   still miscompiles the push/pop/pointer-arithmetic loop body in specific
   functions - it returns garbage (`erl_unicode`, `do_chksum`) or reads
   out of bounds (`db_is_fully_bound`, `match_traverse`). This facet is **not**
   fixed by the init patch and is what the per-file `-O1` Makefile downgrades
   address.

The important consequence: **the `global.h` patch is necessary but not
sufficient.** A file can be correctly initialized and still be miscompiled in
its traversal loop. So "ESTACK/WSTACK is used here" is a *risk marker*, not a
guarantee of breakage, and the init patch does not retire the risk.

The defensive `patches/patch-db-bounds-check.py` (`wasm_db_ptr_valid` in
`erl_db_util.c`) is a third, orthogonal mitigation: it converts a miscompiled
OOB *trap* into a controlled failure. It reduces blast radius but does not make
results correct, so it is not a substitute for the `-O1` fix.

### Related but distinct wasm workarounds (explicitly out of class)

`build-erlang.sh` also patches `sys_drivers.c` (no forker on wasm32) and the
`inet_drv.c` / `ram_file_drv.c` driver-`start` signatures (3-arg `call_indirect`
type match). These are **not** `-O2` miscompilations - they are wasm ABI /
capability differences - and are out of scope for this coverage work. Naming
them here prevents a future reader from folding them into the same bucket.

## Users And Operator Workflows

- **End user running Erlang on Kandelo.** Writes ordinary Erlang that compares
  terms, converts unicode, serializes with `term_to_binary`, hashes iodata, or
  queries ETS. A latent miscompilation surfaces as *wrong results* (worst case:
  silent data corruption) or a crash. They have almost no way to attribute this
  to a compiler bug; they will file it as "Kandelo Erlang is broken." Early
  detection in our CI is what keeps this off their desk.
- **Porter bumping OTP** (e.g. 28.2 -> a later release). Today they have no
  signal that the reactive `-O1` set is still correct or sufficient for the new
  source. A new OTP version can move code between files, add new ESTACK/WSTACK
  users, or change line offsets the Makefile patch depends on. They need a
  fast, mechanical smoke that fails loudly if a regression reappears, plus a
  documented re-audit trigger.
- **Maintainer triaging a new report.** Needs a written signature ("does this
  look like the ESTACK/WSTACK class?"), a repro recipe, and a single place to
  register the new file so the fix, the smoke case, and the rationale stay
  together instead of scattering across commits.
- **Future maintainer trying to remove `-O1`.** Needs objective removal
  criteria tied to a toolchain version and a green smoke at `-O2`.

## Architecture: A Three-Layer Strategy

The bead offers three options and asks us to "pick low-risk." They are not
mutually exclusive; the right answer is a layered defense where each layer
covers the others' blind spots. Detection alone misses cold paths; prevention
alone is unmeasured perf cost; upstream alone is slow. Together they converge.

```
Layer A  Detection      on-Kandelo term/iodata smoke matrix, CI-gated
                         -> a NEW miscompilation fails fast, not in prod
Layer B  Containment     greppable workaround registry + risk audit
                         -> reactive process becomes systematic & bounded
Layer C  Root cause      minimal reproducer + upstream (LLVM/OTP) + removal
                         -> the -O1 workarounds eventually go away
```

### Layer A - Detection (do first, lowest risk)

A curated smoke that exercises each ESTACK/WSTACK-backed operation class with
inputs deep/large enough to force the heap-stack traversal path (not just the
inline fast path), and asserts exact expected results. This is the bead's first
option, expanded into a principled matrix keyed to the at-risk files.

Operation -> file rationale (each row is chosen because it drives a specific
ESTACK/WSTACK traversal):

| Smoke case | Exercises | Rationale |
| --- | --- | --- |
| `term_to_binary` / `binary_to_term` round-trip on deep nested terms | `external.c` | Explicitly named as a gap on the bead; encode/decode walk terms via WSTACK. |
| `unicode:characters_to_list/binary` on mixed/large input | `erl_unicode.c` | Known-hit; regression guard. |
| `erlang:md5`/`crc32`/`adler32` on nested iolists | `erl_bif_chksum.c` | Known-hit via PR #824; the beam_asm trigger. Regression guard. |
| `ets:match`/`ets:select` with non-trivial match specs | `erl_db_util.c`, `erl_db_hash.c`, `erl_db.c` | Known-hit; regression guard. |
| Term compare/sort on deep/heterogeneous terms (`==`, `lists:sort`, `maps` keys) | `utils.c` (`cmp`/`eq`) | High-risk unaudited: comparison uses WSTACK and is pervasive. |
| `copy`/`size` via large message send or `binary_to_term` of a big term | `copy.c` | High-risk unaudited: `copy_struct`/`size_object` use work stacks and sit on the message hot path. |
| `io_lib:format("~p", ...)` on deep nested terms | `erl_printf_term.c` | Term printing walks structure via a stack. |
| Deep `iolist_to_binary`, `binary:matches`, `split` | `erl_bif_binary.c` | Iolist/binary traversal. |
| **End-to-end:** `compile:file`/`erlc` of a non-trivial module on-platform | `beam_asm` MD5-over-iolist + general term traversal | The original `kd-qe2c` failure mode; a single high-value integration smoke. |

Each assertion must compare against a **known-good oracle value** (computed on a
native OTP, hard-coded in the smoke) so a miscompilation that returns *plausible
but wrong* output is caught, not just crashes.

**The gating problem is the crux of Layer A.** The existing
`packages/registry/erlang/test/erlang.test.ts` already runs `serve.ts -eval`
programs, but it is guarded by `describe.skipIf(!hasErlang)` and `hasErlang`
requires a local `erlang-install/` tree plus `erlang.wasm`. The shipped
`binaries-abi-v6` release contains only `erlang.wasm`, so **this suite silently
skips in CI today.** Adding cases to it alone would repeat the `kd-gk6o` /
`kd-9oou` pattern of a test that exists but never gates.

The build already produces the missing piece: `erlang-otp.tar.zst`, the packed
OTP runtime tree (built for the `erlang-vfs` demo, and part of the VFS language
sidecar work in `kd-yuef`/`kd-v3fs`/`kd-iyrf`). The design makes the smoke a
**single matrix consumed by two runners**:

1. **Local/dev runner:** keep and extend `erlang.test.ts`; still `skipIf` when
   no local tree - developers with a build get the matrix for free.
2. **Authoritative CI gate:** run the same matrix in the environment that has
   the OTP runtime tree - the Homebrew bottle-build / smoke job, alongside the
   `hello` smoke and the framebuffer gate (`kd-ivdr`, spec `kd-jg94`). That job
   either builds or fetches-and-extracts `erlang-otp.tar.zst`, so the matrix
   actually executes and can fail the gate.

Keeping the matrix in one source file (e.g. an exported list of
`{name, evalProgram, expected}`) prevents drift between the two runners.

**Bound CI cost with a single BEAM boot.** `erlang.test.ts` today spends a
full BEAM startup per case (30s timeouts), so running N matrix cases as N boots
would be slow and flaky in the gate. The CI runner should instead concatenate
the matrix into **one** `-eval` program that runs every check in a single boot
and prints a machine-parseable line per case (`ok <name>` / `FAIL <name>
expected=.. got=..`), then assert on that output. The local `skipIf` runner may
keep per-case `it()` blocks for readable dev output, since it is not on the
critical CI path. One boot keeps the gate cheap enough to run on every change.

### Layer B - Containment (make the reactive process systematic and bounded)

Two pieces turn "fix it when someone screams" into a bounded, auditable
process.

**B1. A single workaround registry.** Today the knowledge is scattered:
Makefile comments, patch scripts, and commit messages. Introduce one
greppable manifest (e.g. `packages/registry/erlang/wasm32-miscompilations.md`
or a small data table the build reads) with one row per worked-around TU:

- file, function/symbol, facet (init vs traversal codegen), workaround applied
  (`-O1` / init patch / bounds guard), the discovering bead/PR, and the smoke
  case name that guards it.

`build-erlang.sh` and the smoke both reference this registry, so adding a new
case is a single, reviewable edit that forces you to also add a smoke row.

The registry should open with a short **triage runbook** so a maintainer facing
a fresh "Erlang returns wrong output / crashes" report has a fixed path:

1. Does it walk terms/iodata (compare, encode/decode, unicode, ETS, hash,
   iolist, print)? If yes, suspect this class.
2. Reproduce with a minimal `-eval`; confirm the same input is correct on native
   OTP (that is the oracle).
3. Rebuild just the suspect TU at `-O1`; if the result becomes correct, it is
   this class.
4. Land the `-O1` (or narrower flag) **and** add both a registry row and a smoke
   matrix row in the same change; link the discovering bead/PR.

Encoding the path in the registry keeps future debuggers from re-deriving it
under incident pressure.

**B2. A one-time risk audit** (the bead's "identify" step, done deliberately
rather than reactively). Enumerate the actual ESTACK/WSTACK surface in the
pinned OTP source and prioritize it. The source is fetched at build time
(gitignored `erlang-src/`), so the audit runs against a built tree:

```sh
# from a completed build tree (packages/registry/erlang/erlang-src)
grep -rlE 'DECLARE_ESTACK|DECLARE_WSTACK|ESTACK_PUSH|WSTACK_PUSH|WSTACK_DECLARE' \
  erts/emulator/beam
```

Expected candidates from OTP 28 ERTS (confirm with the grep above; do not
treat this list as authoritative), ranked by user-facing risk:

- **High:** `utils.c` (`cmp`/`eq`), `external.c` (`term_to_binary`/
  `binary_to_term`), `copy.c` (`copy_struct`/`size_object`) - hot, pervasive,
  and failure = silent wrong results.
- **Medium:** `erl_map.c`, `erl_bif_binary.c`, `erl_printf_term.c`,
  `erl_bif_re.c`.
- **Already handled:** `erl_unicode.c`, `erl_db_util.c`, `erl_db_hash.c`,
  `erl_db.c`, `erl_bif_chksum.c` (PR #824).

The audit's output is coverage prioritization for Layer A (ensure the matrix
hits every high/medium file at least once) and an informed, **per-file** call on
proactive `-O1` for cold-but-high-risk files that a smoke cannot reliably reach.
It is explicitly **not** a license to `-O1` the whole list.

**On proactive `-O1` (the bead's second option):** default to detection-first.
Apply `-O1` proactively only to a file that (a) matches the signature, (b) is
cold enough that the steady-state perf cost is negligible, and (c) is hard for a
smoke to exercise deterministically. Every proactive downgrade must cite a
measured perf delta (see Test Plan) and a registry row. `erl_gc.c` is the
cautionary counter-example: it uses the idiom but is extremely hot, so `-O1`
there is presumed unacceptable absent strong evidence, and detection + upstream
are preferred.

### Layer C - Root cause (open the exit ramp)

The `-O1` downgrades are a coarse hammer and a permanent tax until removed.
Layer C is how they eventually go away:

1. **Minimal reproducer.** Reduce one known case (unicode or `do_chksum` are
   good candidates - small, self-contained) to a standalone C file that
   miscompiles at `-O2` and is correct at `-O1`, isolated from ERTS.
2. **Narrow the workaround.** Before/while filing upstream, try to replace
   whole-file `-O1` with a targeted control - bisect the responsible pass via
   `-mllvm` flags or a specific `-fno-<opt>` - so the workaround costs less perf
   and documents the actual culprit. If a single flag reproduces/​fixes it, that
   is both a better workaround and a sharper bug report.
3. **File upstream** against the LLVM wasm32 backend (and OTP if the idiom is
   technically UB that OTP should harden), linked from the registry.
4. **Removal criteria.** Document that the `-O1` set may be dropped only when
   (a) the toolchain pin advances past a fixed LLVM, and (b) the Layer A matrix
   passes with the downgrades removed. Encode this as a checklist in the
   registry so removal is a deliberate, verifiable act.

## Data And Control Flow

```
build-erlang.sh
  fetch OTP 28.2 -> erlang-src/
  apply patches:  global.h (init, all ESTACK/WSTACK users)
                  erl_db_util.c (bounds guard)
                  Makefile     (-O1: unicode, db_util, db_hash, db [, chksum via #824])
  build -> erlang.wasm  (+ erlang-otp.tar.zst runtime tree)

Detection matrix (single source: {name, evalProgram, expected}[])
  |-- local: erlang.test.ts via serve.ts -eval  (skipIf no tree)  [dev]
  '-- CI:    bottle-build/smoke job              (tree present)   [gate]
             -> assert exact oracle outputs -> fail gate on mismatch

Registry (wasm32-miscompilations.md)
  <- referenced by build-erlang.sh and the smoke matrix
  -> feeds Layer C removal checklist
```

## Alternatives Considered

- **Blanket `-O1` for all of ERTS/BEAM.** Rejected: explicit non-goal;
  unmeasured but real perf cost; hides rather than characterizes the bug.
- **Proactively `-O1` the entire audited ESTACK/WSTACK set.** Rejected as a
  default: over-broad, taxes hot paths (`utils.c`, `copy.c`, `erl_gc.c`), and
  still ships silent wrong-result risk for anything the signature misses.
  Retained as a *selective, measured* tool in Layer B.
- **Detection smoke only, no audit / no upstream.** Insufficient alone: a smoke
  only covers paths it exercises, so cold miscompilations still ship. It is
  Layer A of the plan, not the whole plan.
- **Extend `erlang.test.ts` only (no CI-gated runner).** Rejected: that suite
  skips in CI; it would give a false sense of coverage - the exact trap called
  out for `kd-gk6o`.
- **Global `-O1` fallback with a per-file `-O2` allowlist** (invert the
  default). Rejected: same perf cost as blanket `-O1` for the common case, and
  an allowlist is as reactive as the current blocklist.
- **Rely on the `global.h` init patch to cover the class.** Rejected: proven
  insufficient - the per-file `-O1` downgrades exist *because* correct init does
  not fix the traversal-codegen facet.

## Risks And Mitigations

- **Smoke that never runs (false coverage).** *Highest risk.* Mitigation:
  Layer A's authoritative runner is the CI gate with the runtime tree present;
  add an assertion/log that fails if the matrix is skipped in the gate context
  (distinguish "no tree in dev" from "tree missing in CI").
- **Smoke misses the fast path.** Inputs may be too small to enter the
  heap-stack traversal. Mitigation: size inputs past `DEF_ESTACK_SIZE`/
  `DEF_WSTACK_SIZE` and nest deeply; document why each input is "big enough."
- **CI cost / flakiness from BEAM startup.** A BEAM boot per matrix case (30s
  timeouts today) would make the gate slow and flaky. Mitigation: the CI runner
  batches the whole matrix into one boot (see Layer A), so cost is one startup
  regardless of case count.
- **Oracle drift on OTP bump.** Hard-coded expected values can change legitimately.
  Mitigation: comment each oracle with how it was computed on native OTP and the
  OTP version; re-validate on version bump.
- **Perf regression from proactive `-O1`.** Mitigation: no proactive downgrade
  without a measured delta; keep hot files (`utils.c`, `copy.c`, `erl_gc.c`) on
  detection+upstream unless evidence says otherwise.
- **Makefile patch fragility across OTP versions.** The `sed` insert keys off
  `beam_emu.o` and exact struct-body text in `global.h`. Mitigation: the audit
  and re-audit trigger; make patches fail loudly (non-zero exit) if their anchor
  text is absent rather than silently no-op'ing.
- **Registry rots.** A doc nobody reads. Mitigation: reference it from
  `build-erlang.sh` and the smoke so edits are forced during real changes;
  review it during OTP bumps.
- **Coordination with PR #824.** If this work lands before #824, the chksum
  smoke row would fail. Mitigation: sequence the chksum smoke row behind #824,
  or land it in the same change; note the dependency on the bead.

## Implementation Sequence

Each step is a candidate child bead under `kd-r8h7`.

1. **Audit (Layer B2).** Run the grep against a built `erlang-src`, produce the
   confirmed at-risk file list with risk ranking. Record on the bead. *(No repo
   change; unblocks everything.)*
2. **Registry (Layer B1).** Add `wasm32-miscompilations.md`, backfill the five
   known files (mark chksum as PR #824), and reference it from
   `build-erlang.sh`. Bump `erlang/build.toml` revision only if build *output
   bytes* change (they should not for a doc/comment-only edit).
3. **Smoke matrix source + local runner (Layer A.1).** Add the single matrix
   file and extend `erlang.test.ts` to iterate it (still `skipIf`).
4. **CI gate runner (Layer A.2).** Wire the matrix into the bottle-build/smoke
   job with the OTP runtime tree present; fail on mismatch; fail on unexpected
   skip. Coordinate with `kd-ivdr`/`kd-jg94` gate wiring.
5. **Coverage closure.** Ensure the matrix exercises every high/medium audited
   file; add rows until each is hit. Land chksum row with/after PR #824.
6. **Perf baseline (enables proactive `-O1` decisions).** Micro-benchmark the
   candidate hot files at `-O2` vs `-O1` (ring benchmark + term-heavy
   workloads); record deltas. Only then decide any proactive downgrades.
7. **Root cause (Layer C).** Minimal reproducer; attempt a narrow
   `-mllvm`/`-fno-<opt>` workaround; file upstream; add the removal checklist to
   the registry. Likely its own long-lived tracking bead.

Steps 1-4 deliver the core value (systematic detection + bounded process) and
are low-risk. 5-7 are follow-through.

## Test And Documentation Plan

Testing:

- New smoke matrix must pass in the CI gate runner with the OTP runtime tree
  present (authoritative), and locally via `erlang.test.ts` when a build exists.
- Verify the gate **fails** on a deliberately broken oracle (negative control)
  so we know it can catch a regression, and **fails on unexpected skip** in CI.
- Perf step (6): publish before/after numbers for any file considered for
  proactive `-O1`; no downgrade lands without them.
- This is a package/build + test change, not a kernel ABI change, so the
  ABI-snapshot gate does not apply. Run the standard package build for erlang
  and the host test suite for the wired gate; publish pass/fail/skip-with-reason
  counts per the validation standard.

Documentation (per `CLAUDE.md` docs map):

- `docs/agent-guidance/packages-and-builds.md` and/or `docs/porting-guide.md`:
  document the wasm32 ESTACK/WSTACK miscompilation class, the `-O1` +
  init-patch + bounds-guard pattern, and the "add a smoke row when you add an
  `-O1`" rule, pointing at the registry.
- `packages/registry/erlang/wasm32-miscompilations.md`: the registry itself
  (source of truth for the workaround set and the removal checklist).
- Note the pattern's reusability for other C ports that hit wasm32 `-O2` codegen
  bugs (see Open Questions).

## Open Questions

- **Gate home:** bottle-build/smoke job (recommended, tree already present) vs a
  host/test that fetches+extracts the published `erlang-otp.tar.zst` sidecar.
  Depends on where `kd-ivdr`/`kd-jg94` land the framebuffer gate and whether the
  erlang sidecar is a stable published artifact by then.
- **Narrow workaround feasibility:** can a single `-mllvm`/`-fno-<opt>` flag
  replace whole-file `-O1`? Unknown until Layer C bisection; would reduce perf
  cost and sharpen the upstream report.
- **Is the idiom UB?** If taking addresses of the shadow-stack array and storing
  them via aggregate init is technically UB that native targets tolerate, the
  right fix might be an OTP patch (upstreamable) rather than only an LLVM bug.
  Affects who we file against.
- **Generalization:** should the registry + smoke-row discipline be a
  cross-package convention for wasm32 `-O2` miscompilations (perl, ruby, php
  have their own reactive workarounds), owned by `docs/porting-guide.md`? Low
  risk, potentially high leverage; out of scope for `kd-r8h7` but worth a
  follow-up.
- **Re-audit trigger:** encode "re-run the audit on any OTP version bump" as a
  checklist item in the erlang recipe/registry, or as a porter-facing doc note?
