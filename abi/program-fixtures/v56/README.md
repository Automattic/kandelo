# ABI-56 fixture preparation

This directory currently contains a source plan, not a completed fixture cohort.
The maintainer retired ABI55 before deployment because nothing deployed relies
on it. v55/manifest.json and original bytes remain unchanged historical evidence;
copying or restamping them cannot create this cohort.

After all merge conflicts are resolved, root must regenerate/review the actual
source-derived snapshot through the ordinary ABI workflow (the snapshot and
runtime ABI are owned separately):

```sh
scripts/dev-shell.sh bash scripts/check-abi-version.sh update
scripts/dev-shell.sh bash -c 'host_target=$(rustc -vV | sed -n "s/^host: //p"); cargo run -p xtask --target "$host_target" --quiet -- abi-program-digest'
```

Put that exact source/snapshot-derived digest into the program_contract_digest
of abi/supported-program-baseline.json. The temporary PENDING marker deliberately
fails admission; it is not a digest and must not be shipped. Run the ordinary
check-program-baseline gate after sealing. Commit the coherent reviewed producer
source before capturing fixture provenance; --create-current refuses dirty
tracked sources. This authoring step does not grant a program-surface change
under an old identity or waive kernel/host/normal validation.

Then run once from that clean source, inside its normal development shell:

```sh
scripts/dev-shell.sh python3 scripts/build-program-baseline.py --create-current
```

The script ensures the normal wasm32 musl core, builds each named C source with
sdk/bin/wasm32posix-cc using the declared flags, instruments six new outputs with
scripts/run-wasm-fork-instrument.sh, then stamps only newly compiled outputs with
that producer's xtask. raw-fork is freshly compiled/stamped but not instrumented.
The resulting manifest records the exact clean producer commit, source hashes,
contract digest and measured seven output identities. Existing destinations are
refused instead of overwritten. Review/commit manifest.json after a real build;
generated Wasm remains ignored. No manifest or binary has been synthesized here.

Subsequent ordinary setup/test preparation uses:

```sh
scripts/dev-shell.sh python3 scripts/build-program-baseline.py
```

It verifies/reproduces the active56 pinned cohort, then the immutable archived55
negative-control cohort using each one's own producer. It never treats55 as a
supported fallback. All actual Node/browser/native/normal ABI gates remain
required. This workflow has been prepared source-only and has not run yet.
