# C++ indirect-call experiments (2026-10-02)

Scripts behind "C++ indirect-call resolution" in
`docs/plans/2026-10-02-fork-sinks.md`. Run from the repository root; outputs
go to `.context/cxx/`.

- `census.sh <label> <link> [fpa rules...]`: fpa typed closure, chokepoint
  census, and the per-(function, signature) target export that fsa reads.
- `fsa.sh <label> <link> <itargets> [fsa args...]`: the sink analysis with
  `--exc equiv --main-direct` (set `FSA_MD=` to drop main-direct).
- `corpus.sh <label> [fpa rules...]`: both over the corpus, with oracle
  checks where stacks exist. `GEN=` turns pointer generalization off.

Inputs that are not in the repository:

- `.context/cxx/aliases.tsv`: ljubljana's `runtime/aliases.tsv` plus the
  libc++ objects whose facts were regenerated with `-emit-llvm` (see the
  plan for the clang crash this avoids);
- `.context/cxx/ids.tsv`: every function type id in the side files with its
  `llvm-cxxfilt` demangling. `FPA_GENERALIZE` reads it.
