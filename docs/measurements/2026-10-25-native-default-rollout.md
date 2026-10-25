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
two Cargo build jobs. This report distinguishes completed checks from the
remaining rollout work.

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

## Pinned transform and remaining checks

The immutable source snapshot contains 208 files with an empty source patch.
The host compilation profile is `instrumenter`:

| Binary | SHA-256 |
|---|---|
| Raw transform measurement executable | `57b22a4dfaa72a595c3ffbacc8ff0ddeec5a54ec645be861cf09bfc507d58006` |
| Installed/default CLI | `021f22d9cc097ea3c52092d0232520fac4e1c586301938f338f70af346cc9f47` |

Sortix process, signal and I/O conformance is still running. The current-source original
284.6 MB Codex capacity check remains pending. It will run serially after other
builds/tests finish, with the authorized 16 GiB physical-memory guard and
30-minute deadline, without Binaryen, browser or guest execution.

The [paired package measurements](2026-10-25-native-instrumentation-comparison.md)
and [cache-sizing measurements](2026-10-25-native-cache-sizing.md) precede this
default-dispatch change. They remain the performance evidence: native uses
roughly 36–38 MiB raw physical peaks on these three inputs, while throughput
still trails Walrus for Gawk and Coreutils. This rollout does not claim a new
timing comparison or full runtime-suite coverage.
