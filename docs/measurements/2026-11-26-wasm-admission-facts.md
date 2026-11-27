# Reusing Wasm artifact facts during worker startup

Each process Worker applies the artifact policy before executing a guest.
The check needs export names for legacy Asyncify and fork detection, import
declarations for required extensions, and custom-section names for fork
descriptors and relocatable objects. Grouped artifacts use both extension
and fork-contract checks. They previously decoded the detailed type,
import, function, global, table, export and descriptor facts twice during
one check. The candidate reuses the successful decode and the declarations
used by the other checks within that invocation.

## Matched desktop runs

The source baseline was develop at `e58ab40d00a94313d2bb7a4cfedc8a41307137ea`.
The recording-sized test used a frozen grouped Sway desktop stack based on
`dffcfca5325666d5e02cacdef03d4f14893a4584`. The artifact parser source was
identical to develop before the patch. Both arms used the same partial
shell (`abce61e1fc4a1a942c40fbcc39426c1c41ff2bbc7710db5efb46c617800a1149`)
and kernel (`cfb4182f96851ae5a3f5f116e12db31b8223e264edfdd74df79f0161b7fcd208`).
The packaged process Worker recorded a small set of timestamps before
and after policy checking, module instantiation, and continuation replay.
The sole source difference between the arms was the artifact-policy change.

At 2634 × 1806 and DPR 2, each run started with one usable terminal. Tests
issued four trusted Alt+Return presses, checking the fitted backgrounds and
visible prompts of all expected tiles, including resized peers. Each engine
ran in control, candidate, candidate, control order. Each arm recorded
eight shortcuts and 16 fork children, one from Sway and one from Foot per
shortcut.

| Median | Installed Firefox control | Firefox candidate | Playwright WebKit control | WebKit candidate |
| --- | ---: | ---: | ---: | ---: |
| Artifact policy per fork child | 11.37 ms | 6.17 ms | 11.27 ms | 8.23 ms |
| Child entry to instantiation | 28.21 ms | 20.64 ms | 28.12 ms | 24.52 ms |
| Shortcut to all fitted prompts | 1855 ms | 1601 ms | 1513 ms | 1171 ms |

Firefox candidate endpoints ranged from 1276 to 2143 ms, and WebKit
candidate endpoints ranged from 1022 to 1346 ms. The ranges overlap the
controls. Host load varied across runs, and the Worker instrumentation
was enabled in both arms. The policy measurement establishes a reduction
in repeated parsing. The total launch measurements include other process,
compositor and display work and cannot isolate the impact of this change.
The 100 ms launch target remains open.

## Validation

The normal host build passed. The four targeted Vitest files covering
artifact parsing, ABI contract digests, fork GC types, and grouped Worker
initialization passed 89 tests. Two existing prepared-product cases skipped
because the SpiderMonkey product and compatible cached Dash objdump inputs
were unavailable. The desktop tests exercised real SDK artifacts and fork
replay on installed Firefox and Playwright WebKit. This comparison did
not run native Safari or measure steady-state allocation.
