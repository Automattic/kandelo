# Rust shared-group reclamation measurements — 2026-11-23

This receipt covers a normal canonical-shell Sway/Foot workload on an Apple M5 Max (18 CPUs, 48 GiB), macOS 27.2.1, Chromium 153.0.8010.12. It does not establish broad benchmark or release acceptance.

The candidate is `751967cbc3d777e9a714b240f10c6bdfd1c007f9` plus the three-file Rust reclamation patch (binary git-diff SHA-256 `34f063f1af98118e49f34d2c5a4150dccf86aefb02dd3cebacfd63115264e954`). The normally built kernel SHA-256 is `bd9ed02a3eb3b0208a102201bc604a0cd8d113f9bb656a44455f74f7f8821ed8`. Guest SDK/program packages were unchanged. Native runtime-core tests passed (3,982 unit, one integration, six doc tests); normal browser preparation passed 315/315 nodes and 11/11 products.

## Method and results

Both controls are serialized by the normal image writer from the canonical shell; only Sway's image-owned `runtime.executionBackend` differs. Inventories, lazy references and remaining metadata are checked. Each arm uses three fresh Chromium parent processes, with balanced order. No profiler, runtime probe, forced collection or concurrent owned build ran during these measurements.

| Measure | Ordinary | Grouped | Difference |
| --- | ---: | ---: | ---: |
| CPU seconds for 15 physical shell commands plus fresh Inspector reads, median | 14.108 | 16.810 | +19.2% |
| Trusted keydown to captured Foot glyph, median of three run medians | 32.275 ms | 32.445 ms | +0.170 ms |
| Browser-family physical footprint, one visible terminal, median | 2,461.125 MiB | 2,622.328 MiB | +161.203 MiB |
| Two fully rendered tiled terminals | 2,631.142 MiB | 2,755.329 MiB | +124.187 MiB |
| Terminals on separate observed workspaces | 2,669.392 MiB | 2,773.751 MiB | +104.359 MiB |
| Two terminals retiled | 2,644.345 MiB | 2,772.564 MiB | +128.219 MiB |

CPU is whole owned browser-process inventory CPU, not kernel-only time. Footprint uses macOS's multi-PID, shared-region-adjusted total, including graphics/utility processes; it is not unique guest allocation accounting. All six resource cases proved full title/prompt/lower-body geometry, both workspaces, 15 guest-created file contents, native desktop exit and normal computer replacement. All six glyph cases used actual trusted keys, exact rendered glyphs, three no-input controls and a deliberate 50 ms delay control. Glyph times include frame capture/readback; they are not physical input-to-photon or native GPU timings. Fifteen samples within a parent are correlated.

Earlier accepted runs on the unoptimized revision measured ordinary/grouped glyph medians of 31.995/66.440 ms, CPU of 14.399/18.305 seconds, and one-terminal extra footprint of 118.390 MiB. These used different fresh parents; they are retained historical comparisons, not paired before/after samples. Earlier incomplete-window and partial-resize measurements were withdrawn and are not pooled here. The first optimization's single-pair screening is also retained separately.

## Implementation and limits

Profiling identified repeated Rust reclamation calls through the foreign-memory atomic-load boundary. Reclamation now skips peer scans when there are no proposed frame returns, and reads its own already-locked page table in bounded 4 KiB chunks. Peer reads remain atomic, and peer aliases still prevent returning private frames. Regressions cover empty returns, peer aliases, a final partial chunk and failed reads without freeing pages or retaining the root lock.

Material CPU and memory costs remain open. A separate memory diagnostic's global Chromium dump failed and omitted the largest guest renderer; its partial allocator trace cannot establish complete attribution. A subsequent native mapping diagnostic passed for both arms and retained category/region reports. Neither instrumented run supplies accepted timing results. Large WebKit child/pthread stress remains intermittent (two passes, one timeout); a separate prior full browser-memory gate passed all 18 cases. Those browser-memory results precede this candidate and must be rerun for final acceptance.

Raw commands, reports, controls, source, screenshots and failed experiments are retained in workspace `.context/shared-memory-kernel-migration-1365/`, notably jobs 1502, 1506–1517. Reproduction harnesses are retained there rather than installed as product code. Current conformance, broad Node/browser benchmarks, production-app and longer sustained ownership gates remain outstanding. No merge, deployment, memory-saving or full browser-support claim follows from this receipt.

## Retired allocator and fork experiments

Two subsequent changes were tested locally and removed from the candidate because neither established a material desktop footprint saving. Their patches, source, kernels and failed hypotheses remain retained; they are not product code.

| Experiment | Checks | Grouped extra footprint, one/two tiled terminals | CPU overhead | Ordinary/grouped captured glyph |
| --- | --- | ---: | ---: | ---: |
| Skip redundant zero writes only for pages just added by locked Wasm growth | 3,985 runtime tests plus integration/docs, normal kernel/canonical builds, 12 matched Chromium cases pass | +144 / +149 MiB | +21.6% | 32.160 / 32.345 ms |
| Add bounded sparse private-fork copying to that allocator experiment | Full native workspace, `xtask` (915 unit/11 integration), ABI/frozen baseline, normal kernel/canonical builds and 12 matched Chromium cases pass | +165 / +159 MiB | +18.6% | 32.230 / 32.030 ms |

Both comparisons used the same method above and three fresh parents per arm. They used different parents from the published reclamation result; these are not paired before/after samples. Tests proved fewer explicit native writes and byte-preserving private copies, including read-error containment. Those mechanism results did not translate into an established desktop memory benefit. The underlying per-process virtual allocations, group backing extent, generated code and browser/graphics heaps remain distinct costs; the native mapping report alone does not identify every Wasm allocation. No causal allocation attribution or net memory-saving claim follows from these experiments.

Raw runs 1518–1525 and the retired patch are retained in the same workspace evidence directory. Final acceptance returns to the published reclamation implementation; native/browser results for the retired combined implementation do not replace its final gates. The supported contract has no fixed performance threshold: usable interaction permits disclosed overhead, while capacity value, bounded ownership, relevant conformance and release validation remain required.

## Current runtime validation

The runtime returned to the published reclamation implementation after those experiments were removed. Revision `139318b22938ca2e2e84939aa687caca033af846` has identical runtime source to `65a0f3ed7a9c2aed10ff76659b72d12c48b3847b` and the exact measured `bd9ed02a…` kernel above. Normal kernel/browser preparation passes 315/315 cached nodes and 11/11 products.

| Gate on that runtime | Result |
| --- | --- |
| Native workspace and `xtask` | Pass; runtime-core 3,982 unit tests, `xtask` 915 unit and eleven integration tests |
| ABI and frozen programs | Program 56/host adapter 27 consistent; frozen baseline unchanged; normal pinned cohort preparation passes |
| Host and Node | Build/strict types pass; 174 cases across seven files pass, including nine unchanged ABI-56 cases; no skipped or unloaded cases |
| Real SDK browser suite | 126 pass across Chromium, Firefox and WebKit; no skipped, flaky, unexpected or report errors |
| Browser-memory gate | 1,424 host, fifteen real-kernel boundary, three Node and seven Bun teardown cases pass; all eighteen browser cases pass, including four same-page constrained-budget full switching cycles per engine |

The browser-memory command took 29m05s. A private Firefox test-home cleanup reported a macOS `Documents` ACL `EACCES`; the raw warning is retained separately from guest/runtime results. This is not a native Safari run or proof that the larger live WebKit cohort is reliable.

The shared-file C probe was then strengthened to seed nonzero data outside its first offset mapping. It verifies descriptor reads immediately after that first slice, before a later full alias could mask lost data. The selected probe passes through the normal SDK on Node and all three browsers, for both unlinked tmpfs and memfd objects. Its Node run intentionally filters the other 37 cases; it is additional targeted evidence, not a rerun of the complete inventory. Runtime source is unchanged. Raw records are retained as jobs 1526–1530.

Relevant libc/POSIX conformance, production-built app, longer sustained desktop, current larger-cohort and broad Node/browser target comparisons remain open. The PR remains draft; nothing merges or deploys automatically.
