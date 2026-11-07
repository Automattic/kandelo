# Partial public tracing owner

This source introduces the unchanged pinned Node 26.13.0 `trace_events` public
wrapper over a real classic trace category/file owner. It is an implementation
prerequisite, not complete tracing, diagnostic reports or runtime acceptance.

`tracing-owner.h` owns one process-wide category multiset, mutex and descriptor.
Each private native CategorySet holds an immutable sorted UTF-8 snapshot and
removes only its own category references. Main and Worker producers share the
same native owner; per-realm private console subscriptions remain independent.
The unchanged public wrapper rejects Worker imports through actual process-state
ownership. It retains enabled public controllers and their original category
arrays using the pinned algorithms, including getter/error/descriptor behavior.

Existing pinned console counter/timer producers publish their actual phases,
labels, IDs and arguments. The native owner reads executing guest `getpid()` and
musl `gettid()`, and the real monotonic clock in microseconds, at publication.
The libc thread identity is distinct from a worker ordinal. Native Mac controls
use the real `pthread_threadid_np` owner instead; that is a reference-platform
branch, not an embedding-host identity path in production Wasm builds.

The sink opens `node_trace.1.log` lazily with actual mode 0644 and close-on-exec,
serializes writes under its process mutex, handles EINTR and short writes, and
closes its owned descriptor exactly once. The engine teardown hunk closes only
for the actual main ShellContext after Workers join and other native producers
retire. Closing from an early JS exit listener would lose later exit-listener
or Worker events. Native/guest engine integration has not been compiled or run
for this slice; passing portable controls do not establish that shutdown order
executes correctly in any guest host.

The classic serializer consumes the existing pinned producers' escaped label
bytes and JSON argument snapshots. It does not invent CPU timestamps, V8
metadata, hardware information, durations, worker IDs or absent operations.
The generated file is a partial classic trace event stream. Complete schema,
metadata producers, time-domain evidence and numerical/encoding edge coverage
remain separate work.

Failed-open behavior remains a nonpassing differential: the exact native
reference prints its diagnostic and times out, while this candidate prints its
diagnostic and retires without an open descriptor. Native source has a failed-fd
flush/completion wait path consistent with that observation; no formal upstream
defect or accepted boundary is declared. Diagnostic text consumes the existing
pinned generic UV error table, compiled against actual target errno values.
Write failure remains an actual error with sticky owner state and unconditional
owned-fd cleanup; its complete public exception/fatal chronology is unvalidated.
No hang is manufactured to make the negative observation match.

Still missing or unvalidated:

- `process.report` configuration/backend/schema, loaded objects, real CPU/RSS/
  heap/resource/worker/native-stack fields and report file/error lifecycle.
- Trace CLI/NODE_OPTIONS activation, file patterns, rotation, permissions,
  inspector sessions, Perfetto and complete category/client ownership.
- Native async/job/fs/DNS/net/HTTP/VM/module/performance/rejection/engine producers
  and genuine metadata. These are not passing unsupported cases.
- CPU-time/duration fields, full classic schema, exotic strings/JSON/error
  chronology and retained-native-allocation accounting.
- Guest JSAPI/realm/GC/fatal/fault/worker/exit ownership and identified-artifact
  validation on Node, Chromium, Firefox and WebKit.

Focused source/native controls live in `tests/tracing`. Native Node supplies
explicit engine, stream, inspection, loader, process and async dependencies in
those controls; no native-host production passthrough is introduced. The public
wrapper and audit target/source/native pins are unchanged. The original audit
remains historical and is not rewritten as implementation or conformance closure.
