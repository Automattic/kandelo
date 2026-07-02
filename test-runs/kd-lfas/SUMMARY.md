# kd-lfas — perl.wasm size: wasm-opt post-link pass

**Date:** 2026-07-02 · **Worktree:** `worktrees/kandelo/kd-lfas-perl.wasm-size-...`
· **Base:** kd-k7zy tip `0150a567` (build-perl.sh rev 2, PR #821, unmerged) ·
**Env:** `scripts/dev-shell.sh` (binaryen wasm-opt v126, LLVM 21.1.7, Node 24)

## Decision
**LAND** `wasm-opt -O2` as a **post-link, pre-fork-instrumentation** pass in
`build-perl.sh`; bump `build.toml` revision 2 → 3. Safe **−469,546 B (−6.44%)**
reduction on the shipped binary, all functional gates green.

## Key structural finding (reframes the bead premise)
The shipped `bin/perl.wasm` (7,291,919 B) is **already fork-instrumented** —
`install_local_binary` applies `wasm-fork-instrument` (auto policy; perl imports
`kernel_fork`+`kernel_execve`). Proof: `instrument(perl-src/perl)` reproduces the
shipped binary **byte-identically** (sha `f9d77c1a…`).

- Raw `make -k` output (pre-instrument): **4,232,959 B**
- Fork instrumentation overhead: **+3,058,960 B (+72%; ~42% of the shipped binary)**

So size is dominated by (a) static perl + 30 curated XS extensions and (b) fork
instrumentation — **not** primarily `--no-gc-sections` dead code. wasm-opt DCE on
the raw code reclaims ~0.45 MB; it cannot touch the instrumentation overhead.
(The bead "Context" note's "4232959 vs 7291919" is exactly raw-vs-instrumented,
not a build discrepancy.)

## Measurement (correct pipeline: wasm-opt raw → fork-instrument)
| Pipeline | raw opt | final (instrumented) | Δ vs 7,291,919 |
|---|---|---|---|
| shipped (no wasm-opt) | 4,232,959 | 7,291,919 | — |
| **-O2 → instrument (LANDED)** | 3,786,690 | **6,822,373** | **−469,546 (−6.44%)** |
| -Oz → instrument (alt) | 3,732,318 | 6,789,290 | −502,629 (−6.89%) |

`-Oz` is only **33,083 B (0.45%)** smaller than `-O2`. Chose **-O2** to match every
other fork-instrumented package (bash/git/php/vim) and preserve interpreter
throughput.

## Why the pass MUST precede instrumentation
Sibling recipes document it: *"wasm-fork-instrument must run LAST because it
hardcodes mutable-global offsets at instrument time — any later pass that
reordered globals would corrupt the fork buffer."* Confirmed empirically:
- Optimizing the **already-instrumented** shipped binary with `wasm-opt -all` produced
  an `exnref` (Exn heap-type) local that **breaks** `wasm-fork-instrument`
  (`ref-typed local … Abstract(Exn) … not yet supported`). Root cause: `-all`
  enabled features the input didn't declare. The landed pass uses plain `-O2`
  (honors the input's `target_features`: bulk-memory, exception-handling,
  reference-types, threads, …), so no unsupported reftypes are introduced.

## Verification (all on the ACTUAL recipe output, 6,822,373 B, 5 WPK exports)
Reproduced the recipe tail with the **real** `install_local_binary` auto-instrument
(logged "applying wasm-fork-instrument to perl.wasm" → 6,822,373 B in
`local-binaries/programs/wasm32/perl/`).

- **runtime-smoke.ts (kd-k7zy, 9 checks): 9/9 PERL_RUNTIME_SMOKE_PASS**
  (Config, XSLoader, File::Spec catfile/rel2abs, Cwd, POSIX, Fcntl, List::Util, Data::Dumper)
- **ext-smoke.ts (21 checks): 21/21 EXT_SMOKE_PASS** — arithmetic, floats, strings,
  sprintf, regex (named/subst/tr/unicode-/u), sort (numeric+Schwartzian), hashes,
  pack/unpack, POSIX math, List::Util, refs/closures. Baseline == optimized on all.
- **fork-smoke.ts (5 checks): FORK_SMOKE_PASS** — fork()+pipe+waitpid+exit-status,
  system(LIST) execve, open('-|',LIST). Identical PASS on shipped baseline and
  optimized (both single-instrumented). This is the gate the runtime/ext smokes
  cannot cover (they never fork).

## Notes / limitations
- Not byte-reproducible: two runs of the same pipeline give the same **size**
  (6,822,373) but different sha (`ee5a4479…` vs `214f99ac…`). This is a
  pre-existing property of `wasm-fork-instrument` (affects all fork-instrumented
  packages), not introduced here. Revision tracks size/behavior, not byte-exactness.
- Perl **source compile not re-run**: the edit only adds a post-link pass; the raw
  binary is deterministic and was validated byte-identical to kd-k7zy's shipped
  build via `instrument(raw)==shipped`. The added glue (`wasm-opt -O2` +
  `install_local_binary`) was exercised end-to-end.
- Perl fork/system had **no durable regression test**; `fork-smoke.ts` is
  verification scaffolding here. Candidate follow-up: promote to a demo/CI test
  (coordinate with kd-gk6o perl-smoke CI wiring).

## Artifacts
- `test-runs/kd-lfas/ext-smoke.ts`, `fork-smoke.ts` — verification harnesses
- `test-runs/kd-lfas/tests-passed.txt`, `tests-failed.txt`, `tests-skipped.txt`
- Recipe change: `packages/registry/perl/build-perl.sh` (+wasm-opt -O2 block),
  `packages/registry/perl/build.toml` (revision 2→3)
