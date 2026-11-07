# ABI-56 program fixtures

`manifest.json` pins seven freshly compiled outputs from clean producer
`39aadd13386b5683f5dacc482b4c9e2dc54822ce`, built on 2026-11-07 through its
normal development shell, musl core, SDK, instrumenter and ABI stamp tool.
It records the source hashes, compilation flags, program contract digest,
output sizes and SHA-256 identities. Six programs are fork-instrumented;
`raw-fork.wasm` is compiled and stamped before instrumentation so preparation
can be tested separately. Generated Wasm files remain ignored.

The maintainer retired ABI 55 before deployment because no deployed software
relies on it. The archived `../v55/manifest.json` and its original program
bytes remain unchanged historical/refusal evidence. Copying or restamping
those bytes cannot create this cohort. The supported baseline is program
ABI 56 and the exact source-derived digest in
`../../supported-program-baseline.json`.

To verify or reproduce the pinned fixtures, run:

```sh
scripts/dev-shell.sh python3 scripts/build-program-baseline.py
```

The helper verifies existing output or rebuilds it with its recorded producer.
It separately reproduces the immutable ABI-55 negative-control cohort using
that cohort's own producer. It never treats ABI 55 as a supported fallback.
A changed file fails rather than being silently overwritten.

The initial capture used `build-program-baseline.py --create-current` from
the clean producer above, after the ordinary source-derived ABI generation
and baseline checks. That command refuses existing destinations and stamps
only newly compiled outputs. Its successful run produced seven new stamps
and zero reused stamps; all seven identities were independently checked
against the resulting manifest. The archived ABI-55 manifest was unchanged.

Fixture production establishes provenance, not runtime compatibility.
Current-kernel Rust, Node and browser baseline/admission tests, the coherent
normal build and all broader graphics acceptance checks remain required.
