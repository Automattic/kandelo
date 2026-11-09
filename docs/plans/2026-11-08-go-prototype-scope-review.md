# Experimental Go prototype: scope and patch review

This review records the size of the proposed Go capability before extracting
a Go-only implementation PR. It enables no runtime behavior. The existing
[implementation draft, #1492](https://github.com/Automattic/kandelo/pull/1492),
remains separate and includes substantial application work.

**The prototype is not a small patch set.** Removing FrankenPHP and
WordPress would simplify the Kandelo review, but the external Go fork
still contains more than ten thousand added lines beyond its upstream
wasm32 architecture baseline.

## Pinned inputs

| Input | Commit |
| --- | --- |
| Kandelo main | `df8cf7461f23a6d11d4250aadd3c4ddd4789e81e` |
| Existing implementation draft | `540355f0a017e26d4a54894361eca1e5ebc49c94` |
| Selected Go fork | `f60530600f70a5ea905a907ac311ec8bd2ae8ac4` |
| Upstream wasm32 review-stack head | `5e196a61a223f2590d576909992bea8803d770f9` |
| Upstream before the wasm32 review stack | `6c49ac311e5642fa5399b46c736295a9dc4eeec9` |

Kandelo counts use the PR's three-dot comparison with the pinned main ref.
Go counts compare the named commits directly. Measurements are pinned
here because the implementation draft can continue moving independently.

## Actual size

| Surface | Files | Added lines | Removed lines |
| --- | ---: | ---: | ---: |
| Kandelo draft #1492, including application work | 382 | 30,965 | 628 |
| Kandelo changes in selected Go beyond upstream wasm32 | 264 | 10,835 | 342 |
| Upstream wasm32 review stack carried by the compiler | 285 | 3,720 | 676 |
| Whole selected compiler delta before upstream wasm32 | 528 | 14,519 | 982 |

The last row combines the two compiler layers; do not add it to those
rows again. File counts overlap between those layers. The Kandelo repo
and Go fork are distinct review and maintenance surfaces.

The Kandelo-specific compiler delta has 69 new files. Of its existing
modified files, 172 have four or fewer changed lines, commonly target
selection/build constraints. The raw file count therefore overstates the
amount of substantive code, but the runtime and linker work remains large.

### Selected Go fork beyond upstream wasm32

| Classification by source path | Files | Added | Removed |
| --- | ---: | ---: | ---: |
| cgo and linker | 20 | 3,754 | 71 |
| Syscalls, I/O, net and os | 125 | 3,518 | 104 |
| Runtime and atomics | 64 | 2,633 | 68 |
| Target registration and other standard library | 52 | 510 | 57 |
| Shared regexp algorithm and tests | 3 | 420 | 42 |

The regexp change contains 129 added/42 removed production lines in
`compile.go`, plus 291 added test lines. It changes a shared library
algorithm, independently of the OS target. Its deep-pattern compilation
cost and equivalence evidence belong in its own review; this audit makes
no performance claim.

### Existing Kandelo draft

These path groups explain the current broad PR. They are not a selected
dependency closure or a promised size for a future Go-only PR.

| Group | Files | Added | Removed |
| --- | ---: | ---: | ---: |
| Documentation and archived evidence | 28 | 12,613 | 48 |
| Go probes/browser tests, including some application fixtures | 131 | 7,779 | 0 |
| Applications, images, browser UI and measurements | 110 | 6,683 | 204 |
| Platform tests and fixtures | 49 | 2,199 | 56 |
| Kernel, ABI, host, libc and SDK compiler | 40 | 1,258 | 313 |
| Other build/test integration | 16 | 246 | 7 |
| Go package/toolchain integration | 8 | 187 | 0 |

The eight integration files alone are not a working Go port. They select
the external compiler/runtime fork and depend on compatible host/kernel
support, the normal SDK and package build path, and matching ABI artifacts.

## Compiler patches to review

The three compiler layers can be reviewed separately:

1. [Upstream wasm32 review stack](https://github.com/kandelo-dev/go/compare/6c49ac311e5642fa5399b46c736295a9dc4eeec9...5e196a61a223f2590d576909992bea8803d770f9)
   ([download diff](https://github.com/kandelo-dev/go/compare/6c49ac311e5642fa5399b46c736295a9dc4eeec9...5e196a61a223f2590d576909992bea8803d770f9.diff)).
2. [Kandelo target before regexp](https://github.com/kandelo-dev/go/compare/5e196a61a223f2590d576909992bea8803d770f9...a0b048e19e1b183db33f52d26c08d1c63b4f1c1d)
   ([download diff](https://github.com/kandelo-dev/go/compare/5e196a61a223f2590d576909992bea8803d770f9...a0b048e19e1b183db33f52d26c08d1c63b4f1c1d.diff)).
3. [Shared regexp traversal and tests](https://github.com/kandelo-dev/go/compare/a0b048e19e1b183db33f52d26c08d1c63b4f1c1d...f60530600f70a5ea905a907ac311ec8bd2ae8ac4)
   ([download diff](https://github.com/kandelo-dev/go/compare/a0b048e19e1b183db33f52d26c08d1c63b4f1c1d...f60530600f70a5ea905a907ac311ec8bd2ae8ac4.diff)).

The [patch manifest](2026-11-08-go-prototype-patches.json) records exact
endpoints, sizes and SHA-256 hashes for locally exported Git patches.
GitHub's diff downloads may format patch metadata differently. Recreate
the hashed exports in a checkout of `kandelo-dev/go` with:

```sh
git diff --binary 6c49ac311e5642fa5399b46c736295a9dc4eeec9 5e196a61a223f2590d576909992bea8803d770f9 > 01-upstream-wasm32-review.patch
git diff --binary 5e196a61a223f2590d576909992bea8803d770f9 a0b048e19e1b183db33f52d26c08d1c63b4f1c1d > 02-kandelo-go-target-without-regexp.patch
git diff --binary a0b048e19e1b183db33f52d26c08d1c63b4f1c1d f60530600f70a5ea905a907ac311ec8bd2ae8ac4 > 03-shared-regexp-change.patch
```

The audit applies all three exports, in order, to a private Git index
initialized at the upstream baseline. Its resulting tree exactly equals
the selected Go source tree:
`d64bb6f4b997c3ccfccabc6abbd047df105d73db`. The compiler checkout is
unchanged. This verifies patch completeness, not runtime correctness.

## Scope of a future Go-only implementation PR

Retain and validate the dependency closure for:

- Declared compiler/bootstrap sources, SDK wrapper and `go-hello` recipe.
- Host/kernel support for startup, shared memory, runtime threads,
  syscalls, signals and retirement on Node and browsers.
- Focused pure-Go runtime, filesystem, networking and subprocess tests.
- General cgo support/tests, if cgo remains in the chosen prototype.
- A concise quickstart, support matrix and known limitations.

Defer FrankenPHP/Caddy recipes and their dependency forks, PHP patches
and embedding fixtures, WordPress images/services/UI/cache/cron work,
application benchmarks, and the long chronological investigation log.
Some general platform fixes discovered by those applications may remain
prerequisites; choose by behavior and dependency, rather than path alone.

The PHP iterative CFG patch remains present in the broad draft as a file,
but current recipes do not apply it. It does not belong in a Go-only PR.
Additional application dependency forks need separate patch review if
those consumers ship later; they are outside this Go-target audit.

## Integration and validation boundaries

Current main declares guest ABI **56**. The existing implementation draft
still declares ABI **55**, matching the selected compiler's marker. A fresh
implementation PR on main needs a coordinated compiler update, immutable
repin, artifact rebuild and Node/browser validation. Copying the wrapper
or restamping old binaries would not establish compatibility.

Historical evidence includes standard-library cross-builds, runtime/cgo
Node and three-engine browser checks, and selected normal package builds.
No full Go conformance, current-main ABI-56 integration, canonical product
build or performance suite was run for this source audit. Historical
passes do not validate a newly extracted implementation. This review
changes documentation only.

## Decision

If proceeding requires a small external patch set, this prototype does
not meet that condition today. Separating application work will improve
the Kandelo review without turning the compiler/runtime port into a
small patch.

Review the OS/runtime and cgo/linker changes, decide whether their size
and maintenance ownership are acceptable, then extract and validate a
coherent Go-only implementation. Preserve the broad draft as evidence;
do not describe it as a small Go-only change.
