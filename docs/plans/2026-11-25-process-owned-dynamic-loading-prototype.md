# Process-owned dynamic loading prototype

The first milestone runs on `develop@af25e6e57300`, which includes
#1748 and the fork facts fix from #1778. The prototype uses a patched
wasm-ld 23.1.3 and the experimental `kandelo.loader.prototype.v1`
extension. The program ABI stays at 56.

## Verified paths

- A single SDK link emits a sorted executable symbol index and assigns
  canonical table slots, including an export whose address is never
  taken in source. The lookup-only program has no legacy loader imports.
  The compiler-facts plan includes its fork caller and the installed
  capability byte is `0x04`. Its guest checks a function alias, data
  address, stale main handle, and consumption of a pending error.
- The plugin links a module-relative index into a side artifact.
  Libc resolves direct imports, `GOT.func`, and `GOT.mem` from the
  executable index and passes one vector to the adapter. Libc also
  handles lookup, scope, and reference counts for the one mapped object.
  The fixtures check equality of pointers obtained through each route,
  `RTLD_LOCAL` exclusion, fork after loading, and fork within a plugin
  activation that resumes and returns to its main-program caller.
- During child reconstruction, the adapter needs native function
  references before the process table has been restored. The guest
  vector carries the exact provider export along with the slot.
  The adapter binds the fresh export, then the existing fork machinery
  restores the table overlay and activation frames. This is why a
  table index alone was insufficient in the initial fork attempt.
- Node passed both prototype fixtures and all three existing facts
  regression cases. Chromium passed both prototype fixtures. Host
  type checking and the ABI snapshot, program extension, supported
  baseline, and test inventory checks passed. The stock linker
  rejected the experimental libc object and named its missing index
  symbols. The frozen ABI-56 and ABI-55 fixtures were reproduced and
  verified by the test setup.
- An additional resolver-driven kernel rebuild compiled the kernel but
  failed source-only authority finalization while the worktree inputs
  were changing. The ABI checker subsequently built a matching kernel
  for snapshot verification and passed. The runtime fixture runs used
  the resolver's available ABI-56 kernel plus the prototype host source.

Rebuild and run the fixtures using [the SDK prototype guide](../../sdk/lld/README.md).

## Synthetic 1,024-import comparison

The paired fixture uses 1,024 direct function imports and exercises both
eager open and a child calling the loaded module. Both arms use LLVM
23.1.3, the same main and plugin sources, the same host checkout and
ABI-56 kernel, and the facts instrumenter with fully conservative side
entry. The legacy arm uses the stock linker and existing SDK loader.
The guest arm uses the patched linker and explicit prototype libc
object. There was one warmup per arm, six alternating pairs, and four
legacy repeat controls per host. The Node harness used sparse fork
copy. Timings are guest wall-clock measurements.

| Operation | Node legacy | Node guest | Chromium legacy | Chromium guest |
| --- | ---: | ---: | ---: | ---: |
| Fresh-process eager open | 27.00 ms | 28.26 ms | 24.73 ms | 28.53 ms |
| 20,000 executable lookups | 30.87 ms | 1.86 ms | 21.62 ms | 1.90 ms |
| Fork, child plugin call, and reap | 136.14 ms | 140.33 ms | 77.69 ms | 81.62 ms |

The four legacy repeats spanned 26.05–26.50 ms for Node open and
24.24–25.05 ms for Chromium open. Open is slower in this run despite
using one inspection compile and batched bindings. The new adapter
retains the inspected module for initial instantiation. Fresh workers
still recompile and attach their own engine objects. Phase-level
timing is needed to attribute the open and fork differences.

The five SDK links per arm used precompiled objects. Median final
link wall time was 528 ms for legacy and 540 ms for guest. Each
instrumentation pass took 311 ms. The linked executable grew from
381,970 to 428,305 bytes. The instrumented executable grew from
111,611 to 151,890 bytes. Its index is 35,319 bytes for 1,086
entries, with 17,927 bytes of name strings. The instrumented side
module went from 84,032 to 84,233 bytes. Both mains carry the
side-code fork role. These sizes describe an export-heavy plugin
host and give no estimate for the lookup-only SDL2 binaries.

The synthetic comparison gives a bounded measurement of the protocol.
Package timing and link time at clang and rustc scale remain unmeasured.

## ScummVM engine comparison

The two arms use the verified ScummVM 2026.3.0 source and the Kandelo
package configuration with one runtime engine, SCUMM including the
v7/v8 subengine. They share the application objects, dependencies,
Clang 23.1.3, ABI-56 kernel, and host checkout at `515c596b6`.
The legacy arm uses the SDK loader from `develop@af25e6e57300` and
stock wasm-ld. The guest arm links the prototype libc object, the
versioned mapping extension, and the patched wasm-ld for both images.
The executable uses the package's `--export-all` policy. Both main
images run the facts instrumenter with the conservative side-entry
policy. The pinned develop base keeps the compiler and package inputs
matched as develop advances.

A shared scratch probe runs through ScummVM's plugin discovery and its
SDL provider with a minimal kernel-owned VFS containing `libscumm.so`
and the plugin path configuration. The probe skips video initialization
because the packaged SDL2 has no dummy video driver. It loads and runs
the actual engine's plugin initialization and checks that its
`MetaEngine::getName()` returns `scumm`. It measures
`SDL_LoadObject`, 20,000 repeated `SDL_LoadFunction` calls on the
already loaded `PLUGIN_getObject` symbol, and the time to fork, call
the engine in the child, and reap it. Every repeated lookup must return
the first pointer. The lookup loop is a microbenchmark for the
app's symbol and path, with more calls than a normal engine load.

The timings are guest monotonic wall time on an Apple M3 Max running
macOS 27.2.1, Node 24.22.1, and Chromium 153.0.8010.12. Each host
gets one warmup per arm and six alternating pairs, each in a fresh
guest. Node uses sparse fork copying. Time in the host's VFS build and
the main executable startup occurs before the clocked operations.

All 24 measured runs opened and executed the engine and verified that a
forked child could call it. The six-pair medians are in milliseconds.

| Operation | Node legacy | Node guest | Chromium legacy | Chromium guest |
| --- | ---: | ---: | ---: | ---: |
| Load the SCUMM engine | 422.15 | 432.23 | 400.92 | 413.58 |
| Look up `PLUGIN_getObject` 20,000 times | 12,442.35 | 2.83 | 8,242.43 | 2.58 |
| Fork, call the engine in the child, and reap | 726.94 | 730.02 | 594.26 | 597.76 |

Guest open medians were 2.4% higher in Node and 3.2% higher in Chromium.
The open ranges overlapped on each host. The ranges were 394–586 ms
for legacy and 407–565 ms for guest in Node, and 390–418 ms for legacy
and 401–459 ms for guest in Chromium. Fork medians were within 0.6%,
with overlapping ranges. Legacy `DynamicLinker.symbolAddress` scans
the function table on every call. The guest resolves a handle lookup
from the already loaded engine's sorted symbol index. A typical
ScummVM engine load does a handful of symbol lookups.

### Guest open profile

A separate run with timers in libc and the adapter used the same
instrumented engine bytes. Five measured opens per host followed a
warmup. Medians are in milliseconds.

| Phase | Node | Chromium |
| --- | ---: | ---: |
| Open and read the file | 14.85 | 8.76 |
| Inspect, compile, and write batch metadata | 16.94 | 7.59 |
| Resolve 747 guest bindings and retain the index | 4.22 | 1.83 |
| Map and activate the module | 516.12 | 423.63 |
| Engine instance construction, included in map and activate | 8.44 | 3.52 |

Map and activate includes adapter preparation, engine instance
construction, initializer calls, and recording the mapped engine for
fork. That phase accounted for 94–96% of profiled open time. Resolving the batch and constructing the engine instance each
took single-digit milliseconds. The profile does not attribute the
difference between the two loaders to an individual phase.

### Image size and export selection

| Artifact | Legacy bytes | Guest bytes | Growth |
| --- | ---: | ---: | ---: |
| Linked executable | 95,533,011 | 96,924,415 | 1.5% |
| Linked engine | 3,779,678 | 4,202,989 | 11.2% |
| Instrumented executable | 27,343,513 | 28,729,129 | 5.1% |
| Instrumented engine | 5,880,212 | 6,303,523 | 7.2% |

Both main images carry fork flags `0x06`, including the conservative
side-loading role. The instrumented engine has 785 imports and the
guest batch resolves 747 application bindings, including 83 GOT
function-pointer and 43 GOT data bindings. Those bindings use 733
distinct names and all resolve in the executable index. The same index
encoding would take 40,243 bytes for those names alone. That estimate
excludes any additional part of the executable's public lookup scope
and the exports needed by other engines. An earlier read-only inspection
found 185 imports in the cached DreamWeb engine.

The executable's full index takes 1,359,696 bytes for 24,176 entries,
including 972,864 bytes of strings. The side index takes 417,391 bytes
for 6,706 entries, including 310,079 bytes of strings. Those two
indexes account for most of the measured growth.

### SDK relink time

Six warm relinks per arm used the same retained application objects.
The SDK link and make overhead together had a median of 1.637 s
for the legacy executable and 1.596 s for the guest executable.
The engine relink medians were 0.639 s and 0.646 s, respectively.
Both sets of ranges overlapped. These times exclude application
compilation and fork instrumentation.

## Remaining validation

The prototype maps one distinct wasm32 module per process. Libc owns
the scope and handles, and the existing archive still retains engine
attachment recipes and activation state. Final close withdraws the
guest handle. Engine resources stay live until process exit. General
dependency closure, side-originated loading, destructor handling,
unmapping, and racing loader operations across pthreads remain open.
The in-guest wasm-ld package was also outside this build.

The real-app comparison is outstanding for CPython, waybar, gtk3_smoke,
and the SDL2 outputs. ScummVM gameplay and other engines remain
outside the headless engine comparison. The clang and rustc link
timings need matching relocatable link inputs. The conformance,
browser-memory, full Node and browser benchmark suites, and canonical
image integration remain pending. The package comparisons and the
shipping ABI decision remain gates before full implementation.
