# BINARYEN-133-CONSTRAINT-ANALYSIS

Status: confirmed. Fixed upstream in a commit that is in no release yet; not
filed by Kandelo (the upstream fix already exists).

**Revisit this.** Kandelo skips Binaryen's `constraint-analysis` pass
everywhere it runs `wasm-opt`. Two separate decisions hang on this entry:

1. Dropping the workaround for the *abort* needs a released Binaryen that
   contains WebAssembly/binaryen#9258 (see "Removal criteria").
2. *Turning the pass back on* is a different decision, made after
   re-measuring the pass on Kandelo's programs. A fixed abort alone is not
   a reason to enable it. The plan, triggers and criteria are in
   `docs/future-improvements.md`, "Revisit Binaryen's constraint-analysis
   pass".

## Defect

Binaryen 133 added the `constraint-analysis` pass
([#8853](https://github.com/WebAssembly/binaryen/pull/8853)) and enabled it
by default at `-O3`, `-O4`, `-Os` and `-Oz`
([#9010](https://github.com/WebAssembly/binaryen/pull/9010)). The pass
collects linear constraints on locals along branches and uses them to fold
comparisons whose result is already known.

On some inputs the pass aborts:

```
Assertion failed: (!constraints.provesEverything()), function operator(),
file constraint.cpp, line 1223.
```

The cause is an asymmetric overlap check in `provesPair`: one ordering of a
pair of constraints is checked for contradiction and the other is not, so
the pass stores a contradictory constraint set (one that "proves
everything") and then asserts that it never holds one.
[#9258](https://github.com/WebAssembly/binaryen/pull/9258) ("Fix asymmetry
in provesPair overlap check", commit `ca1cf60a`, merged 2026-10-13) fixes
it. The newest release, `version_133` (2026-09-21), predates the fix.

## Why Kandelo is affected

Kandelo runs `wasm-opt` at levels that schedule the pass:

- the fork instrumenter's post-instrumentation pass, `-Os` by default;
- the SDK driver's post-link `wasm-opt`, which reruns the job clang
  schedules (`-O<level>` from the compile flags, so `-O3`, `-Os` and `-Oz`
  builds run the pass);
- `-Oz` in the build scripts of two Rust modules, the image module and the
  program-policy module.

With LLVM 23, FFmpeg's `ff_spatial_dwt` (`libavcodec/snow_dwt.c`) triggers
the abort. The ffmpeg package's instrumented `ffplay` failed to build: the
instrumenter's `wasm-opt -Os` aborted. The same abort happens on the plain,
uninstrumented `ffplay`, `ffmpeg` and `ffprobe` links at `-O3`, `-Os` and
`-Oz` (not at `-O1` or `-O2`), so the instrumenter's transform is not
involved.

## Workaround and its cost

Every `wasm-opt` run Kandelo makes at a level that can schedule the pass
gets `--skip-pass=constraint-analysis`. Tagged sites:

- `crates/fork-instrument/src/cli/optimize.rs`: `SKIP_CONSTRAINT_ANALYSIS`,
  passed after the `--post-optimize` level on every run.
- `crates/kandelo-cc/src/driver.rs`: `SKIP_CONSTRAINT_ANALYSIS` and
  `post_link_wasm_opt_job`, appended to clang's scheduled post-link job for
  modules that do not fork.
- `crates/kandelo-image-module/build-wasm.sh`: the `wasm-opt -Oz` shrink
  step.
- `crates/program-policy/build-wasm.sh`: the `wasm-opt -Oz` step.
- Tests: `crates/fork-instrument/tests/cli_post_optimize.rs`
  (`the_default_level_is_os` checks the flag reaches `wasm-opt`) and
  `crates/kandelo-cc/tests/driver.rs`
  (`post_link_wasm_opt_skips_constraint_analysis`).

Package recipes that run `wasm-opt` themselves (bash, cpython, git, lsof,
php, spidermonkey, vim) use `-O2`, which does not schedule the pass, so they
are unchanged. If a recipe moves to `-O3`, `-O4`, `-Os` or `-Oz`, it needs
the flag and a tag.

`wasm-opt` accepts `--skip-pass` with a pass name it does not know (exit 0,
no warning, checked on 133), so the flag is harmless with a Binaryen that
lacks the pass and at levels that do not schedule it. The flip side is that
a misspelled name would silently do nothing; the checks below run the exact
string.

Cost: the size and speed the pass would win, which measured as negligible
(below), and a little less `wasm-opt` CPU time (the pass costs 3-18%).

## Evidence

Reproduction (`repro/run.sh`, through `driver.mjs`, 2026-11-15, macOS):

| wasm-opt | verdict |
|---|---|
| `wasm-opt version 133` (dev shell, nix `binaryen-133`) | reproduced: both inputs abort, `control.wat` passes |
| `wasm-opt version 133 (version_133-1-gbd78c3fa)`, a local build of 133 plus #9258 | not reproduced (control, not recorded in `entry.toml`) |

The script runs `wasm-opt <input> --constraint-analysis` on two inputs:
`upstream-9258.wat`, the regression function from #9258's own test, and
`ffplay-dwt-reduced.wat`, a 513-byte `wasm-reduce` result from FFmpeg's
`ff_spatial_dwt` as it stood in `ffplay` just before the pass ran in `-Os`.
The reduced inputs abort only when the pass runs alone: in the full `-O`
pipelines, earlier passes simplify them first. `control.wat` shows that the
pass runs to completion on this tool.

On full modules (before this change; logs kept in the investigating
worktree's `.scratch/binaryen-assert/logs/`):

| input | 133 `-O1`/`-O2` | 133 `-O3`/`-Os`/`-Oz` | 133 `-Os`/`-O3` + skip | 133 + #9258 | 126 |
|---|---|---|---|---|---|
| ffplay, uninstrumented link | ok | abort | ok | ok | ok (no such pass) |
| ffplay, instrumenter output before its pass | ok (`-O2`) | abort | ok | ok | ok |
| ffmpeg, ffprobe, uninstrumented | | abort (`-Os`) | | | |

`-O4` happened not to abort on the uninstrumented ffplay, presumably
because its heavier inlining changes the function; it schedules the pass
all the same.

After the change (2026-11-15): a logging `wasm-opt` shim showed that both
`wasm32posix-cc -Os` on a program that does not fork and
`wasm-fork-instrument` on a forking program pass
`--skip-pass=constraint-analysis` to the dev shell's 133, and the ffmpeg
package (with `ffplay`) builds and installs.

## Why this is not a Kandelo defect

The reproduction is two small WAT modules and one `wasm-opt` command, with
no Kandelo code, and one of the two modules is upstream's own regression
test. The same `wasm-opt` with #9258 applied does not abort. The abort is
an internal assertion in Binaryen; whatever the input, `wasm-opt` must not
abort on a valid module (both `ffplay` modules validate in Binaryen and V8).

## Draft upstream report

Not needed: fixed upstream by #9258, merged 2026-10-13. If a released
Binaryen containing #9258 still aborts on `repro/`, report that, attaching
`repro/`: "constraint-analysis: `!constraints.provesEverything()` assertion
in `constraint.cpp` on `<version>`", steps `bash run.sh` with `WASM_OPT` set,
expected `not-reproduced`, actual the assertion.

## Removal criteria

The abort is gone when a **released** Binaryen that contains #9258 is
pinned (`flake.nix` and the `binaryen` package) and `repro/run.sh` reports
`not-reproduced` on it through the driver; record that `observed` result.

That alone retires this entry's **abort** rationale, not the skip. Then
decide separately, by re-measuring as described in
`docs/future-improvements.md` ("Revisit Binaryen's constraint-analysis
pass"), whether to run the pass again. If the decision is to enable it,
delete the four tagged code sites and the two test assertions, update
`docs/sdk-guide.md` and `docs/fork-instrumentation.md`, and retire this
entry. If the decision is to keep skipping it, keep the flag, retire this
entry with `retired_reason` saying the abort is fixed and the skip
continues as a measured choice, and move the code comments' reference to
the future-improvements section (the tag must leave the code when the entry
retires).
