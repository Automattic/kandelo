# Native-default rollout validation — 2026-10-25

The CLI, library and SDK/package build wrapper now select native fork
instrumentation by default. Walrus remains a temporary, explicitly selected
comparison oracle, intended for removal. Native errors never invoke Walrus.
Discovery reports use original function identities rather than generated
helper names. The Vec-returning library convenience API copies the final
artifact; the production CLI retains file-backed output.

The production change is `1db42bf6f56b77d79e6ced707d188eb6d543cbe0`.
`f74fd96b85` refreshes the detached fuzz workspace lockfile without changing
production code. All commands below ran through `scripts/dev-shell.sh`, with
two Cargo build jobs. This report records the completed rollout checks and
their scope.

## Completed checks

| Check | Result |
|---|---|
| Rust workspace, excluding xtask | 3,207 passed across 92 result groups; no failures or ignored tests |
| Instrumenter subset | 674 passed across 76 groups, included in the workspace total |
| Package automation, xtask | 724 passed across four groups; no failures or ignored tests |
| Focused Node runtime | 28 passed across five files; no failures or skips |
| Browser process matrix | 57 passed across Chromium, Firefox and Playwright WebKit; no failures or skips |
| ABI | Snapshot, version and generated contracts passed |
| Random-WAT fuzz gate | 10,000 runs; both backends, independent wasmparser validation and Walrus reparsing; no findings |
| Builder | External-working-directory and stale-source-stamp checks passed |
| Artifact closure preflight | No incomplete or failed closures; unbuilt unrelated packages remain listed separately |
| Real-package execution | All four probes below passed through the new source-only rootfs |
| Selected libc conformance | All seven selected cases passed |
| Selected Open POSIX conformance | All eighteen signal, raise and kill cases passed |
| Selected Sortix conformance | 113 passed; no failures, build errors or timeouts; two documented upstream skips |

Workspace tests used one test thread; the instrumenter-only preparation checks
used two. The Node selection covers default SDK-built process probes, native
file publication, fresh-worker exception/reference restoration and real
side-module forks. Browser probes build through the SDK without selecting a
backend, on both pointer widths. Two WebKit deep-recursion cases explicitly
observe its documented native-stack boundary; the wide-frame cases verify
allocation-failure recovery. These checks do not establish native Safari
desktop behavior.

The retained Walrus helper-layout assertions name the oracle explicitly.
Behavior and ABI checks use the default native backend; native emission and
replay also retain their dedicated differential suites. Nested filtered
subprocess checks are excluded from the xtask total to avoid double counting.

## Fresh normal package builds and execution

The normal `platform-rootfs` selection built its 18-node closure: sixteen
program/library packages, the rootfs package and its image product. The current
kernel was also built and published through `./run.sh build kernel`. No backend
override or cache-key substitution was used.

Execution uses the normal `source-only-v1` resolver policy and its published
projection. The probe checks that the resolver-selected rootfs hash equals the
new publication before booting the kernel. It exercises:

- Bash child variable state, shared-file visibility and `wait`.
- Bash command substitution and a Coreutils `seq` → Gawk pipeline.
- Gawk `system()` and pipe `getline`, including child close status.
- Coreutils `timeout` forking Bash and preserving the child's exit status.

| Published artifact | SHA-256 |
|---|---|
| Rootfs | `9fc049b478d98d1899633ab29999dfdbb46b5c479688a36ec0b0475c12532ac7` |
| Bash | `76f8fa8b1a4df3ac90a7de6385adfc6be0f38349f4b77286018d4e7de04eb524` |
| Gawk | `9bcdf91738ae0577153eb7f56f14bddca2e40b01f318fbde37d36b1bdb6fd762` |
| Coreutils | `5dc5b7e252c167e02118b252bad28b9b0dfb1a76c619a50c43a6a25f30b3551a` |

The first image assembly correctly refused cache-identity drift: cargo-fuzz
created empty default output directories under the crate while the package
build was running. The normal retry reused thirteen nodes and rebuilt three
early packages before assembling the image. Cached bytes and identities were
not overridden. An early conformance attempt failed host artifact resolution
before guest execution while publication was incomplete; that attempt was
stopped and retained separately. The package probe also rejected an older
legacy rootfs, required publication of the current kernel, and corrected its
initial Coreutils multicall command to use the normal `/usr/bin/timeout` alias.

Private evidence lives under `.context/native-default-runtime/`,
`.context/native-default-package-smoke.log`,
`.context/native-default-closures.json.log` and the recorded `scripts/agent-job`
workspace, fuzz, rootfs and kernel jobs.

## Pinned transform and original Codex capacity

The immutable source snapshot contains 208 files with an empty source patch.
The host compilation profile is `instrumenter`:

| Binary | SHA-256 |
|---|---|
| Raw transform measurement executable | `57b22a4dfaa72a595c3ffbacc8ff0ddeec5a54ec645be861cf09bfc507d58006` |
| Installed/default CLI | `021f22d9cc097ea3c52092d0232520fac4e1c586301938f338f70af346cc9f47` |

The selected conformance run passed 138 cases in total, with two existing
Sortix upstream skips concerning the implementation-defined `signal()`
`SA_RESTART` choice. Guest deadlines and expected results were unchanged.
These selected groups do not establish complete conformance-suite coverage.

On the 18-core Apple M5 Max Mac with 48 GiB memory and macOS 27.0.1, the
exact original 284,605,220-byte Codex input completed with compiler facts,
serial WebAssembly validation and atomic publication. The result is
byte-for-byte identical to the [previous successful native output](2026-10-24-native-codex-lexical-transform.md),
including its ABI descriptor and unchanged-data fingerprints.

| Original-input transform | Elapsed | Peak physical memory | Outcome |
|---|---:|---:|---|
| Historical Walrus attempt | Did not complete | Exceeded 16 GiB guard | Stopped during analysis |
| Current native | 517.623 s (8m38s) | 518.59 MiB | Validated and published |

Requested Rust allocations peaked at 430.94 MiB. The automatic specialization
cache reached its 64 MiB allowance: 1,114,850 hits, 362,066 misses and 86,862
evictions. Its allowance is allocated on demand and is not a reservation.
The complete output is 246,465,071 bytes with SHA-256
`a0310b790bb90acc1661cff69bc75fbf138ce5675da780e8e29d1d9db1188e0f`.

The [machine-readable capacity record](2026-10-25-native-default-codex-capacity.json)
includes input, executable, output and contract fingerprints, guard settings
and exact counters. Raw traces, input/output and the copied runner remain in
`.context/native-codex-default-20261025/`.

The run used the authorized 16 GiB physical-memory guard and 30-minute deadline
without a guard event. It ran after the other builds/tests, with no Binaryen,
independent Node compilation, browser or guest/Codex execution. Ordinary
apps/services remained active; macOS indexing used about 1.2 CPU cores at
preflight. This is a capacity observation, not a paired throughput benchmark.
The earlier successful native run recorded 1,029.337 seconds and 484.97 MiB
physical peak in a separate source/profile session. These observations do not
isolate a causal effect of cache sizing or establish a completed-transform
Walrus timing ratio. Physical footprint differs from RSS; requested Rust
allocations exclude SQLite/C allocations, stacks and allocator overhead.
Temporary disk storage is additional. The output remains a private diagnostic
artifact and was not executed, admitted or shipped as a Codex package.

The [paired package measurements](2026-10-25-native-instrumentation-comparison.md)
and [cache-sizing measurements](2026-10-25-native-cache-sizing.md) precede this
default-dispatch change. They remain the performance evidence: native uses
roughly 36–38 MiB raw physical peaks on these three inputs, while throughput
still trails Walrus for Gawk and Coreutils. This rollout does not claim a new
timing comparison or full runtime-suite coverage.
