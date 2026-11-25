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

## ScummVM and remaining validation

Read-only inspection of one existing ABI-56 ScummVM cache generation
(`571128ab509838d1` prefix) identified 785 imports in `libscumm.so`
and 185 in `libdreamweb.so`. The former includes 83 `GOT.func`,
43 `GOT.mem`, and 649 `env` function imports. Every application
import checked in the two engines has a name in that generation's
executable export section. That result establishes the need for both
GOT binding kinds and identifies a feasible subset for the next real
prototype pair. The cached engine files predate the prototype side
symbol index. The executable and engines need matching relinks for
a real A/B.

The prototype maps one distinct wasm32 module per process. Libc owns
the scope and handles, and the existing archive still retains engine
attachment recipes and activation state. Final close withdraws the
guest handle. Engine resources stay live until process exit. General
dependency closure, side-originated loading, destructor handling,
unmapping, and racing loader operations across pthreads remain open.
The in-guest wasm-ld package was also outside this build.

The real-app comparison is outstanding for ScummVM, CPython, waybar,
gtk3_smoke, and the SDL2 outputs. The clang and rustc link timings need
matching relocatable link inputs. The conformance, browser-memory,
and full Node and browser benchmark suites were outside this first
milestone. No canonical image was built. The package comparison and
the shipping ABI decision remain gates before full implementation.
