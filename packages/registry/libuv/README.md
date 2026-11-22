# libuv loop backend

This initial wasm32 library builds the exact libuv 1.52.1 sources in the
verified Node.js 26.13.0 archive through upstream CMake and Kandelo's normal
SDK/resolver/cache. The SpiderMonkey embedding's native Node timer backend
uses this library for its loop and timer/check/idle handles. Wider Node I/O
integration remains incomplete; see the upstream runtime evidence ledger.

The standalone libuv 1.52.1 release differs from Node's copy in
src/unix/fs.c, src/uv-common.c, src/win/fs-event.c and src/win/tcp.c.
The recipe therefore selects deps/uv from the pinned Node archive, keeping
its existing patch set. The added patch selects upstream posix-poll.c and
posix-hrtime.c for CMAKE_SYSTEM_NAME=Kandelo. It never defines __linux__.

Revision 4 makes the installed static pkg-config paths relative to the pkg-config
file. The revision 3 and revision 4 runtime archives are byte-identical; relocated
CMake and pkg-config tracing consumers pass on Node. See
[v8-tracing-component-check.json](../../../tests/nodejs/upstream/v8-tracing-component-check.json).

Consumers must use the installed CMake target libuv::uv_a or
pkg-config --cflags --libs libuv-static. Both supply
UV_PLATFORM_KANDELO=1, which selects the matching public uv_loop_t layout.
Omitting it creates an incompatible layout; it is a required compile flag.
The explicit Kandelo selector takes precedence over ambient legacy OS macros
in embedding translation units. The library itself builds as Kandelo without
Linux identity flags.

The thread-entry patch replaces upstream's incompatible function-pointer
cast with a real pointer-returning pthread wrapper. A successful creation
transfers the allocated callback/argument pair to the child, which copies
and frees it before calling the original void callback. Creation failure
frees the pair in the caller. This is a C callback-signature portability
fix, not an engine or kernel workaround.

Filesystem event watching uses upstream's no-fsevents.c: initialization
returns UV_ENOSYS. Process-title get/set also return UV_ENOSYS rather than
upstream no-proctitle.c's successful no-ops. No title/argument storage is
allocated. These are explicit gaps, not implemented functionality.

Revision 5 also selects the complete unchanged upstream `procfs-exepath.c`.
`uv_exepath` reads the guest kernel's actual `/proc/self/exe`, including its
executed-image identity independently of `argv[0]`; it keeps upstream buffer
validation, truncation and termination behavior. This requires no kernel change.
See [libuv-exepath-engine-check.json](../../../tests/nodejs/upstream/libuv-exepath-engine-check.json)
for current identified-artifact evidence, separate from the earlier loop receipt.

Revision 6 adds the Kandelo memory API boundary. It is source work pending the
joint startup batch build and runtime validation. `uv_get_constrained_memory`
uses the complete upstream resource-limit helper and the guest's actual
`RLIMIT_AS` and `RLIMIT_DATA`; changes to those limits are queried on each call.
Those allocation constraints do not measure physical free or resident memory.
The guest currently exposes no genuine physical-memory capacity/free service,
so `uv_get_total_memory` and `uv_get_free_memory` return libuv's documented
unknown value, zero. `uv_get_available_memory` follows the free-memory result.
`uv_resident_set_memory` returns `UV_ENOSYS` without changing its output; a null
output pointer returns `UV_EINVAL`. The original Node RSS/memoryUsage functions
therefore retain their error path rather than receive a fabricated measurement.
Process and thread `uv_getrusage` queries likewise return `UV_ENOSYS` without
writing their output, instead of forwarding the kernel's simulated zero records.
The Kandelo guard retains every original statement of the upstream query body
for other platforms. These errors remain implementation gaps in resource
accounting; no process CPU/memory measurements are claimed.
No kernel/libc semantics, ABI, resource limits or host memory service are changed.
The current `getrusage`, `sysinfo` and procfs RSS placeholders cannot provide
these measurements, and mapped ranges or file-cache pages are not substitutes.
See the [libuv memory contract](https://github.com/libuv/libuv/blob/v1.52.1/docs/src/misc.rst)
and the startup batch's source/runtime evidence distinction.

This is an initial event-loop backend, not complete libuv support. OS-specific
physical-memory/resource/CPU/network-interface reporting remains incomplete.
The revision-4 target-header AST and archive-symbol
inventory found 318 declared public functions and ten missing definitions.
Revision 5 supplied `uv_exepath`. The five memory declarations have definitions
staged in revision 6; source presence is not link or runtime evidence.
`uv_cpu_info`, `uv_interface_addresses`, `uv_loadavg` and `uv_uptime` still lack
definitions. The previous nine-missing-symbol inventory remains historical until
the joint batch rebuild repeats the target-header/archive comparison.
Symbol presence is not runtime conformance evidence. Process spawn,
signal behavior, socket operations, DNS, cancellation, fork recovery, OOM and
full teardown still need focused validation. No product image includes this
library, and it is not in the local-supported build set. No generated upstream
man pages are shipped; the pinned Node bundle omits libuv's Sphinx API sources,
which upstream publishes separately.

The next unbuilt link batch adds interface enumeration using the complete
upstream `bsd-ifaddrs.c`. Its address filtering, allocation and copying remain
upstream; a Kandelo branch obtains hardware addresses through `SIOCGIFHWADDR`
instead of BSD `AF_LINK` records. Both IP and hardware addresses come from the
existing shared libc/kernel interface table. Failures retire the whole output
allocation. No host or kernel interface is added.

That batch also implements `uv_uptime` through the guest's `CLOCK_BOOTTIME`,
propagating clock errors and retaining subsecond precision. The platform's
documented monotonic-equivalent boot-clock boundary still applies: this source
addition does not establish suspend accounting or a qualified guest boot epoch.
Neither addition has been built or runtime-qualified. CPU information and load
averages remain outstanding implementation work; the kernel's current constant
`sysinfo` records must not be treated as measured data.

The self-judging test/backend-controls.c uses real guest clocks, descriptors,
threads and files. Executable-path controls compare real procfs bytes, test
invalid/small/exact buffers, and execute a real copy of the guest image under a
new VFS name with an unrelated `argv[0]`. Its CMake consumer checks public ABI layouts and exercises
empty loops, timers/ref/close, prepare/check phases, cross-thread async wakeups,
thread-pool work, pipe polling and async filesystem effects, plus explicit
unsupported boundaries. Results and artifact identities belong in the upstream
Node evidence ledger; this source alone is not proof that any host passes.
The pending memory controls check unavailable physical/RSS results without
overwriting an RSS sentinel, and real constraint changes through guest
`getrlimit`/`setrlimit`. They have not yet run for revision 6.

## Focused checks

Run these from the repository root. The build script resolves the declared
library, builds a static guest executable, and applies the normal fork
instrumenter. These checks use an empty guest filesystem, not a partial or
canonical product image. The browser fixture explicitly disables canonical
/etc seeding and historical ABI-fixture provisioning; it retains the real
BrowserKernel, workers, syscalls and image writer.

```bash
scripts/dev-shell.sh bash packages/registry/libuv/test/build-controls.sh "$PWD/.scratch/libuv-controls"
scripts/dev-shell.sh node_modules/.bin/tsx scripts/run-libuv-backend-controls.ts \
  .scratch/libuv-controls/libuv-backend-controls.wasm .context/libuv-node-controls.json
scripts/dev-shell.sh bash -c '
  export KANDELO_LIBUV_CONTROLS_WASM="$PWD/.scratch/libuv-controls/libuv-backend-controls.wasm"
  apps/browser-demos/node_modules/.bin/playwright test \
    --config tests/nodejs/upstream/libuv-browser/playwright.config.ts \
    --project chromium --project firefox --project webkit
'
```

The browser runner needs the normal image-builder helpers. If absent, build
them with `scripts/dev-shell.sh bash crates/kandelo-image-module/build-wasm.sh`.
It does not need a canonical rootfs image. Current identified-artifact results,
failed attempts and limits are in
[libuv-backend-engine-check.json](../../../tests/nodejs/upstream/libuv-backend-engine-check.json).

The next unbuilt batch compiles the complete upstream Linux source under guards
that select its portable CPU/load procfs readers only, alongside the existing
Kandelo loop. It does not define `__linux__` or add a second event loop. The CPU
reader's single allocation is paired with its original matching free policy.
The CPU reader returns the real file/query error when `/proc/stat` is absent;
unchanged Node maps missing CPU information to an empty array. The load reader
uses `/proc/loadavg` and preserves the upstream leave-output-unchanged behavior
when no measurement can be obtained. The simulated `sysinfo` fallback is not a
measurement source. An unchanged, initially zero Node load-average buffer does
not prove a measured idle machine. Kandelo currently supplies neither procfs
statistics file: genuine guest CPU/load accounting remains implementation work
for the full port. This defines real queries and their failure paths; it does
not qualify statistics, startup, or module conformance.
