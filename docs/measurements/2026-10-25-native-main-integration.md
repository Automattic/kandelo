# Native instrumentation integration with ABI 53 main

The verified source is `d2aaebe3a48919f52d6ee82f4b98690986d5de97`.
Its merge commit, `77bda22b9009db3b36785ece81d8a3dd61eba691`, combines
native-only source `89945d25cf` with main at
`f6b329f4d9621fe133207e16cda37a6306c1d879`. Main advances the application
binary interface (ABI) from 50 to 53, so earlier runtime artifacts were
rebuilt before this integration was accepted.

## Conflict resolution

Main's pthread fix keeps the host function-table index argument as `i32`
and widens it unsigned for a table64 call. Memory width and table width
are independent. The native entry emitter already implements this rule;
the public regression now covers all four width combinations. The retired
Walrus emitter and its implementation-specific test file remain deleted.

Three hand-written fresh-worker fixtures on main still declared ABI 52.
The first Node run passed 22 checks and correctly rejected those three
inputs before execution. Their WAT sources now declare ABI 53. The shared
GC byte fixture was regenerated from its WAT with the pinned Rust `wat`
crate; only the version constant changed, at byte offset 208. All 25 Node
checks then passed. The three affected Chromium replay checks also passed.

## Fresh artifacts and results

Commands ran through `scripts/dev-shell.sh`. Rust used the explicit
`aarch64-apple-darwin` target, two build jobs and one workspace test thread.
Node and browser suites used one worker. Both musl sysroots passed their
normal freshness checks. The normal builder installed the native tool,
built the kernel and side modules, completed the selected 20-node
`platform-rootfs` closure, and refreshed `host/wasm/rootfs.vfs.zst`.
The ordinary Node resolver selected bytes identical to the new published
rootfs. Builds used the normal resolver, cache-key and admission rules.

| Check | Result |
| --- | --- |
| Workspace Rust, excluding xtask | 3,089 passed across 87 groups; zero failed or ignored |
| xtask build tools | 792 passed across four groups; zero failed or ignored |
| Five focused Node integration files | 25 passed; zero failed or skipped |
| Native process browser fixture | 57 passed across Chromium, Firefox and WebKit; zero failed or skipped |
| Chromium exception and GC-state replay | Three passed; zero failed or skipped |
| Real Bash/Gawk/Coreutils process probes | Four passed |
| Selected libc conformance | Seven passed |
| Selected Open POSIX signal/raise/kill conformance | Eighteen passed |
| Selected Sortix process/signal/I/O conformance | 113 passed; two existing skips; zero failures, build errors or timeouts |
| ABI snapshot/version, standalone resolver bundle, Vitest inventory | Passed; inventory covers 588 test files |
| Instrumenter normal dependency closure | No Walrus dependency |

The Rust sources are unchanged since the successful merged-source checks;
the subsequent fixture repair changes only test inputs. The two Sortix
skips concern implementation-defined `signal()` restart behavior in
`ppoll-block-raise` and `ppoll-block-sleep-raise`. Guest deadlines were
unchanged. The 57-case browser matrix retains two explicit WebKit native
stack-boundary assertions and positive allocation-recovery cases.

The real-package probes check Bash child state and waiting, a
Bash/Coreutils/Gawk pipeline and command substitution, Gawk `system` and
pipe `getline`, and Coreutils `timeout` preserving child exit status 7.
The native tool, kernel and image-writer hashes stayed unchanged between
the browser run and rootfs publication. Exact artifact identities, commands
and result counts are in the [machine-readable record](2026-10-25-native-main-integration.json).

## Scope

This run validates the main integration and fresh ABI 53 artifacts. It does
not repeat the full package registry, full host-runtime suite, full
application benchmarks, generated-program fuzzing, or original large Codex
capacity transform. The earlier [native-only removal](2026-10-25-native-only-instrumenter.md),
[default rollout](2026-10-25-native-default-rollout.md) and
[paired performance](2026-10-25-native-instrumentation-comparison.md) records
identify their earlier sources and artifacts. Timing and memory were not
remeasured during this integration.
