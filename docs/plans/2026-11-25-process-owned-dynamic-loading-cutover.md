# Process-owned dynamic loader SDK cutover

The cutover starts at `origin/develop@d4b37e705`. New SDK executables
link the guest loader on demand. The host still supplies the engine
mapping primitive and attaches the copied module graph after a fork.
Already-built ABI-56 artifacts that import the host loader use the
same compatibility path.

The base ABI and host-adapter ABI stay at their existing versions.
Named loading requires the separately versioned
`kandelo.loader.v1` extension. An older kernel rejected a new
executable at `posix_spawn` with `ENOEXEC`. The same executable ran
after the kernel was rebuilt with that extension. The SDK rejects
links that mix the old imports and the new loader. Existing direct
loaders can rebuild their executable and side modules together.
The new loader rejected a pre-cutover side module and a wrong-width
side module before their constructors ran. The guest reported each
path, expected architecture and loader version through `dlerror`.

## Runtime validation

- The final default-SDK run passed 144 Node tests for the loader,
  archive, host imports, baseline artifacts and program policy.
  Chromium, Firefox and WebKit passed 21 focused loader and
  process-exit tests between them. The runs included a filesystem
  `posix_spawn` of a loader-capable executable and lookup in the
  fresh instance.
- The dependency fixture forks in plugin A, calls plugin B through
  both a direct import and a saved function pointer, and checks B's
  data address. The lifecycle fixture forks in a constructor and a
  destructor, exercises a nested open, and races loader operations
  across pthreads. The constructor case initially failed in the child
  and passed with the inherited transaction stack restored. Four
  memory64 loader tests passed on Node and Chromium. The wasm32
  run covers the frozen ABI-56 compatibility case.
- The compatibility run loads immutable ABI-56 executable and plugin
  bytes and calls the plugin after fork on both hosts. The Node
  supported-program baseline also passed its nine checks, including
  artifacts from before the cutover and the rejection of ABI 55.
- Four unchanged upstream Sortix loader cases passed in the standard
  Node runner against canonical rootfs after the runner prepared its
  side-module fixtures. The same four passed in Chromium with a
  minimal VFS. Five upstream libc-test cases and four Open POSIX
  signal cases passed in Node. The libc-test `dlopen` case also passed
  in Chromium. It exercises promotion from local to global scope,
  data and function lookup, and `dlsym` of C's `main`. The last
  assertion caught a missing alias for Clang's `__main_argc_argv`.
- The source-only browser-memory checks passed seven page boundary
  tests and 1,429 host tests. The prepared grouped-memory boundaries
  passed 19 checks on the refreshed kernel. The standard teardown
  command passed three Node and seven Bun tests against a freshly
  built canonical rootfs. An earlier minimal-VFS run passed five
  reclamation and heap-safepoint checks on each engine.
  The audio activation helper and worker exit specs passed 12 checks
  across Chromium, Firefox and WebKit with required mode enabled.
  A source-built partial shell with fbDOOM passed the real audio
  gesture on all three engines after the local test observer was
  extended to see DOM insertions. The first partial-image attempt
  timed out waiting for the activity signal in Chromium. The
  release-image gesture still needs its original test run.
- The ordinary C and C++ SDK suite passed eight checks, including
  `-rdynamic` with no `-ldl` and an executable that loads a plugin
  without retaining `kernel_fork`. A plain build called the plugin in
  Chromium, Firefox and WebKit. When both the mapping import and
  thread creation survive linking, wasm-ld retains the continuation
  support for the existing table replication. A pthread calling the
  parent's plugin pointer passed on Node and all three browsers.
  The final loader matrix passed 16 wasm32 and eight memory64 cases
  on Node, 24 wasm32 cases across the three browsers, and eight
  memory64 cases in Chromium.
- The SDK's 17 integration tests, Rust driver and artifact-policy
  tests, ABI snapshot comparison and host typecheck passed.
  The normal Clang package completed. Its in-guest Clang and wasm-ld
  compiled a PIC object and linked a side module with a 44-byte
  index. A targeted relink of the guest wasm-ld with the C entry
  alias follow-up assigned `main` and `__main_argc_argv` the same
  slot. The alias probe ran before post-link optimization.

## Explicit named-loading opt-in

The review branch incorporates `origin/develop@6b6904b30`. An explicit
`-ldl` retains the executable's fork entry when the mapping import is
live after archive extraction, LTO and section liveness analysis. An
ordinary named load still works without `-ldl`. A lookup-only program
or a program with an unused loading archive member gains neither the
mapper nor the fork import from `-ldl`. After both core sysroots were
built, the SDK suite passed all 45 checks with the patched wasm-ld.
That covers both CMake targets, the LTO archive and the executable
lookup probe. The Rust SDK driver suite passed all 147 checks.
With the source-built kernel, the ABI snapshot, host typecheck and
real Node worker test passed. The test linked the main program with
`-rdynamic -ldl`, called `fork` from an instrumented plugin and checked
the plugin's live frame in both parent and child.
The same executable and plugin passed in Chromium, Firefox and WebKit
through the minimal browser runner, using the source-built kernel and
the retained image writer binaries from unchanged sources. The full
release-image browser-memory gate remains pending local review.

## Package cost of explicit -ldl

Each pair used the same objects, archives, SDK and export policy. The
SDK used its ordinary finish path for each arm. Sizes are bytes for
individual Wasm payloads before and after compression at zstd level 3.

| Program or plugin | Plain Wasm | Fork-capable Wasm | Plain zstd | Fork-capable zstd |
| --- | ---: | ---: | ---: | ---: |
| LADSPA `applyplugin` 1.13 executable | 86,358 | 141,962 | 38,360 | 56,221 |
| LADSPA amplifier side module | 3,141 | 10,377 | 1,571 | 4,685 |

LADSPA's `applyplugin` is an upstream audio utility outside Kandelo's
registry. Its Makefile normally includes `-ldl`. The application
sources were unchanged. The port uses the Kandelo SDK and maps the
amplifier's ELF `_init` and `_fini` to Wasm constructor and destructor
attributes. The ordinary main imports the mapper and has neither
`kernel_fork` nor `kernel_clone`. Adding `-ldl` retains the fork
entry, so the application and the plugin both receive the usual
fork preparation. Combined zstd payload size grew by 20,975 bytes.

Twenty alternating Node pairs followed one warmup per arm. Each timed
invocation used a fresh guest. Launch-to-usage wall time was 126.17 ms
without the flag and 132.16 ms with it. Launch, gain processing of a
45-second mono WAV through the amplifier, and exit took 243.85 ms and
252.22 ms respectively. The median paired differences were +5.05 ms
at startup and +13.27 ms for the full command. Individual runs varied
and the ranges overlapped. Both arms produced the same 4,320,044-byte
WAV in every run. These timings include the Node harness and exclude
network delivery.

ScummVM's upstream Linux plugin configure branch adds `-ldl`. A
captured link recipe with the retained SCUMM experiment's objects
and export set included exactly one `-ldl`. Both arms retained the
mapper, fork and pthread creation. Their pre-instrumentation modules
differed only in the Wasm name section. Re-running the instrumenter
produced 28,737,722 bytes without `-ldl` and 28,737,718 with it.
Zstd sizes were 7,008,948 and 7,005,768 bytes.

In eight alternating Node pairs after warmup, median fresh-guest
`--version` wall times were 743.48 ms without the flag and 742.83 ms
with it. The same retained SCUMM engine loaded and ran in each
arm. Median guest engine-open times were 426.41 ms and 428.37 ms.
Timing ranges overlapped. The minimal `--version` runs emitted the
same XDG runtime-directory and absent-config warnings in both arms.

### Transitive link flags

- Cached target pkg-config metadata emits `-ldl` through Cairo's
  public link flags. This propagates through GTK 3, gtkmm, pangocairo
  and librsvg. The `rsvg-convert` recipe uses the static system-deps
  path with that Cairo dependency.
- Static pkg-config expansion adds `-ldl` from libcurl, libepoxy
  and the Node libffi package. Cargo's recipe selects static libcurl
  metadata. The SpiderMonkey Node recipe supplies static libffi
  metadata and has a direct target-only `-ldl` in its GYP patch.
- ScummVM gets the flag from upstream configure. PHP's main link,
  Git's HTTP helper link and the curl build also pass it directly.
  Kandelo's CMake platform leaves `CMAKE_DL_LIBS` empty. Recipes that
  list archives directly may bypass the library's pkg-config flags.

A read-only scan of 2,490 cached Wasm artifacts across the local
program stores found 103 with named-load imports, across 24 distinct
filenames. All 103 also imported `kernel_fork`. Five already used
`kandelo.loader.v1` and imported `kernel_clone`. The other 98 used
the old loader imports. This is an inventory of cached artifacts.
It cannot identify every final command that uses `-ldl` or predict
what a complete rebuild with the cutover SDK would retain.

## Application measurements

Size is in bytes. The LÖVE baseline uses the earlier pinned develop
arm with the same app objects. The GTK comparison uses
`develop@d4b37e705`, the same `gtk3_smoke.o`, and identical GTK and
graphics dependency archives. CPython's baseline is a retained package
artifact, as is Waybar's. Their sizes are compatibility comparisons
across builds.

| Executable | Baseline raw | Cutover raw | Baseline instrumented | Cutover instrumented |
| --- | ---: | ---: | ---: | ---: |
| LÖVE | 67,490,683 | 67,513,373 | 9,254,482 | 4,002,914 |
| `gtk3_smoke` | 108,663,902 | 108,692,200 | 26,311,535 | 26,322,285 |
| Waybar | — | — | 34,101,427 | 34,104,654 |
| CPython | — | — | 12,579,994 | 12,552,999 |
| ScummVM executable, export-all | 95,533,011 | 96,945,544 | 27,343,513 | 28,737,715 |
| ScummVM SCUMM engine | 3,779,678 | 4,202,989 | 5,880,215 | 6,303,526 |

The LÖVE headless physics test alternated six pairs on each host,
with one warmup per arm and four repeats of the baseline. The checksum
matched across arms. The 1,200-step median went from 386.06 ms to
264.09 ms in Node and from 253.19 ms to 154.53 ms in Chromium. Node's
baseline controls ranged from 266.77 to 1,908.79 ms under load, so the
Node run supports the image-size result more strongly than the exact
timing change.

Both GTK arms initialized GdkWaylandDisplay, drew a frame, and exited
on Node and Chromium. A repeat after relinking with the final SDK
showed the same behavior. The cutover executable still imports thread
creation, fork and the mapping extension.

The Waybar package built with the normal SDK after provisioning its
sysroot graphics archives. Both artifacts carry the side-loading
fork role. The fresh artifact imports only the mapping extension for
dynamic loading. Both mapped a 1,920-by-34-pixel layer-shell bar in
Node. The full workspace-switch test timed out at `HYPR_LISTENER`
with both artifacts after the bar appeared. Rebuilding the compositor
from the current tree yielded the same geometry and timeout in both
arms.

CPython's packaged interpreter mapped a C extension, called its
initializer, and reaped a forked child in Node and Chromium. The
initializer deliberately returns NULL and imports no CPython API.
The package's normal export policy exposes none of those API symbols.
The test verifies the loader path. Extensions that call the CPython
C API remain unverified.

ScummVM loaded and called the real SCUMM engine, returned the same
pointer for 20,000 lookups, and called it again in a fork child on both
hosts. For each host, the two arms used the same objects and refreshed
kernel. The baseline was relinked on `d4b37e705`. Six alternating
pairs followed one warmup per arm and preceded four baseline repeats.
The timings are guest wall-clock medians in milliseconds.

| Operation | Node develop | Node cutover | Chromium develop | Chromium cutover |
| --- | ---: | ---: | ---: | ---: |
| Open one engine | 437.28 | 467.14 | 443.75 | 454.73 |
| 20,000 lookups of `PLUGIN_getObject` | 15,677.77 | 3.67 | 9,151.93 | 3.66 |
| Fork, engine call, and reap | 743.43 | 753.56 | 820.07 | 769.23 |

Node open and fork differences are within the repeat spread. Chromium
open was 10.98 ms slower in the paired medians. Its four later
baseline opens ranged from 424.85 to 434.76 ms. The lookup result
measures repeated resolution on an already opened handle. One normal
ScummVM startup makes far fewer such lookups.

A separate build with 761 export requests taken from the SCUMM
engine's import list reduced the instrumented executable from
28,737,715 to 20,155,338 bytes with the same engine. Its index went
from 24,176 entries and 1,359,696 bytes to 736 entries and 40,334
bytes. It passed the engine-and-fork probe in both hosts. This export
set serves that engine alone. The all-engine package needs the union
of its engines' required executable symbols. The LÖVE and GTK
cutover indexes were 86 and 107 bytes respectively.

## Compiler link costs

These are real Clang 23.1.3 and Rust 1.97 compiler relocatables from
the package recipes. Each pair uses the same input objects and
archives and invokes each checkout's SDK. One warmup per arm
preceded six alternating pairs. Times are wall-clock seconds for the
final SDK invocation, including loader glue. The forced export
links add `-rdynamic` and keep `dlsym` live to measure the
export-heavy case. Rust's forced export links use the same
`errno_location` adapter on both arms because retaining otherwise
dead code exposed that unresolved symbol.

| Compiler link | Develop median | Cutover median | Develop raw bytes | Cutover raw bytes | Cutover index bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| Clang, package export policy | 4.973 | 3.416 | 982,023,164 | 982,051,560 | 107 |
| Rust, package export policy | 4.305 | 4.798 | 550,486,598 | 550,516,176 | 107 |
| Clang, forced dynamic exports | 4.542 | 3.823 | 997,976,649 | 1,005,265,460 | 7,095,662 |
| Rust, forced dynamic exports | 3.871 | 3.872 | 636,442,394 | 680,782,157 | 43,829,732 |

The Clang forced-export index has 70,776 entries and 5,963,230 bytes
of names. Its Rust counterpart has 176,933 entries and 40,998,788
bytes of names. Both ordinary links added less than 30 KB of raw
image. Link timings overlap across arms under concurrent machine
load. The measured runs establish the cost of retaining broad
export sets in the image and give a bound for the one-pass link on
these inputs.

## Coverage limits

The full browser-memory gate requires provisioning the release browser
products. Its dry run found 306 nodes to run and 18 cache hits, with
a 7,837-second build estimate before the browser tests. Planning
only the two products used by the specs, `browser-main-shell` and
`browser-wordpress-family`, found 308 nodes to run and no cache hits
from the final SDK, with a 7,940-second estimate. Clang and Rust
remain on the critical path. The release-image machine switch and
DOOM audio gesture specs remain pending.
The resolver rejected a pre-cutover release projection during Vite
preflight because its package index format predates the current
schema. The machine-switch test did not start with those images.
The full Sortix, libc-test and Open POSIX suites were outside the
targeted runs. On the earlier cutover branch, a focused build-image
fixture using the updated guest SDK passed Libtool, CMake and Meson
workflows. Each executable used the new mapping import and ran its
plugin. The complete release build-image rebuild remains pending.

The [prototype report](2026-11-25-process-owned-dynamic-loading-prototype.md)
retains the earlier SDL2 cohort, ScummVM, and synthetic timing runs.
