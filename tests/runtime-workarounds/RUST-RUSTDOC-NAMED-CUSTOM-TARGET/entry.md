# Rustdoc's named custom target lookup

## Defect

The pinned rustdoc resolves a doctest executable's suffix with
`Target::expect_builtin` when the target was specified by name. A valid
custom target found through `RUST_TARGET_PATH` or the sysroot panics there.
The compiler's normal `Target::search` supports those named custom targets.

## Why Kandelo is affected

The guest compiler's host is `wasm32-unknown-kandelo-std`. Its matching
standard library is built for that named target and its specification is
installed under `/usr/lib/rustlib/wasm32-unknown-kandelo-std/target.json`.
A JSON path is a different target identity and cannot replace the name
without rebuilding the standard library. `cargo doc` generates HTML, but
`cargo test --doc` reaches this panic before compiling its example.

## Workaround and its cost

`packages/registry/rustc/source-patches/0002-rustdoc-custom-target.patch`
uses `Target::search` with rustdoc's sysroot and unstable-options setting
when choosing the executable suffix. A lookup failure reports a compile
failure. It does not invent a suffix or change target identity. This adds
one target lookup per doctest compilation and a small maintained patch.

## Evidence

On macOS with Rust 1.97.0-nightly (ca9a134e0 2026-04-26), the standalone
reproduction's built-in-target control passed (exit 0), while its named
custom target produced the `built-in target` compiler panic (exit 101).
Node and Chromium guest tests reached the same panic after successfully
formatting code, enforcing Clippy lints and generating HTML documentation.
The patched guest compiler package was rebuilt through the normal resolver.
The shared Node, Chromium, Firefox and WebKit workflow then passed, including
a real positive doctest reporting one passed test and zero failures.

## Why this is not a Kandelo defect

The reproduction copies the native host's target specification using
`rustc --print target-spec-json`. It invokes native rustdoc on a Markdown
file with a `compile_fail` example. It imports no Kandelo code and uses no
Kandelo artifacts. The built-in-target control verifies the example and
native rustdoc can run. The custom-target case panics before compiling it.

## Draft upstream report

Title: rustdoc doctests panic for named custom target specifications

With the matching rustc and rustdoc on PATH, run `bash repro/run.sh`.
Expected: both a built-in target and the same specification found by name
through `RUST_TARGET_PATH` handle the compile-fail example normally.
Actual: the named custom target panics in `Target::expect_builtin`, called
from `librustdoc::doctest::add_exe_suffix`. The standalone script prints a
self-judged verdict and both command outputs. No report has been filed.

## Removal criteria

Remove the patch when the pinned upstream rustdoc resolves named custom
targets for doctest executable names, the standalone reproduction reports
`not-reproduced`, and the guest Node/browser doctest acceptance passes.
