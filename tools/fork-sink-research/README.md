# Fork-sink research tooling

Research tooling behind
[`docs/plans/2026-10-02-fork-sinks.md`](../../docs/plans/2026-10-02-fork-sinks.md).
Not part of the build or the shipped instrumenter.

## Contents

- `fsa/`: the fork-sink analysis (Rust, walrus 0.26.4, depends on
  `crates/fork-instrument` for today's closure). For one Wasm module it
  reports:
  - today's instrumented count;
  - the count with the same refinements but no sinks;
  - the set under sinks, with every sink, every open function and why;
  - optionally an oracle check against observed fork stacks.

  Flags select the rule set:

  | Flag | Effect |
  |---|---|
  | `--signal-policy sig\|nothrow\|list:<file>` | `nothrow` is the signal gate |
  | `--registries` | musl callback registries |
  | `--param` | parameter function-pointer refinement |
  | `--cancel` | the pthread-cancel rule |
  | `--exc static\|equiv\|runtime` | how rule 2 is enforced |
  | `--itargets <fpa export>` | typed indirect targets |
  | `--main-direct` | the crt what-if |

  Diagnostics: `--explain f1,f2` (per-site child verdicts), `--throw-path`,
  `--fork-path`, `--oracle <stacks>`, `--out-set`, `--out-today`.
  `fsa/tests/run.sh` runs the WAT fixtures.
- `fpa/`: a copy of ljubljana's fork-path analysis
  (`tools/fork-path-research/fpa` at commit `9f044cac4`). One addition,
  `--export-targets <file> <mode>`, writes the per-(function, signature)
  indirect target sets that fsa reads with `--itargets`. `FPA_DEBUG_FN`
  prints one function's edge admissions.
- `scripts/corpus.sh`, `scripts/corpus-typed.sh`: run fsa over the corpus
  under the four rule sets, signature-level and typed.
- `scripts/sizes.py`: shipped-shape sizes. It runs fsa on a named
  instrumenter input and instruments it with an experiment build of today's
  instrumenter restricted by `WPK_FORK_ALLOWLIST`.
- `scripts/size-set.py`: the same, for a set computed on a different module
  (name-mapped, so an estimate).
- `RESULTS.md`: the raw output lines the plan quotes.

## Inputs (read-only, not copied)

- `/Users/brandon/conductor/workspaces/kandelo/ljubljana/.context/fpr/`:
  - `shims/links/`: pre-`wasm-opt` links with names, wasm-ld maps and input
    hashes;
  - `shims/side/`, `runtime/aliases.tsv`: plugin v3 side files;
  - `shape3/*/`: named shipped-shape instrumenter inputs;
  - `oracle/*.stacks|*.parsed`: observed fork stacks.
- `/Users/brandon/conductor/workspaces/kandelo/st-georges/.context/qsmap/quickshell.named.wasm`:
  Quickshell's named shipped-shape input, the 29.4 MB → 82.2 MB build.

## Building

```bash
HOST=$(rustc -vV | awk '/^host/ {print $2}')
(cd tools/fork-sink-research/fsa && cargo build --release --target "$HOST")
(cd tools/fork-sink-research/fpa && cargo build --release --target "$HOST")
```

The experiment instrumenter used by `sizes.py` is a copy of
`crates/fork-instrument` and `crates/shared` in `.context/sink/instr-exp/`,
with an exact-name `WPK_FORK_ALLOWLIST` filter added to
`prepare_fork_path`. Rebuild it the same way if `.context` is gone.

## Production

The production analysis now lives in `crates/fork-instrument` (`src/facts/`
for the `fpa` rules, `src/sink.rs` for the `fsa` rules), reading the facts
from the module's `kandelo.calltypes` section; see
`docs/fork-instrumentation.md`. `crates/fork-instrument/examples/facts_equivalence.rs`
checks it against the results of these tools. This directory is the
research snapshot.
