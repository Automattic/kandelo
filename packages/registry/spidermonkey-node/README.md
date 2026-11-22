# Upstream Node runtime build

The `node` and `spidermonkey-node` recipes now invoke the pinned original Node
configure/GYP build. `spidermonkey-node-features` adds the original experimental
QUIC and DTLS configure flags in its own build/output identity. Each build uses
the complete enabled source graph and original registration and startup code.
Compiler and linker diagnostics are uncapped; make continues independent work
to collect the complete failure set. No shell executable is copied as Node.

**This runtime is not ready.** The normal recipes consume the actual shell-free
SpiderMonkey core, native bridge and portable tracing/platform libraries. The
preflight verifies engine/archive/header identities and the private sysroot
copies, then generates the flags consumed by Node's original external-engine
configure path. Missing interfaces fail in the complete compiler/link build;
input validation does not certify SDK completeness or runtime behavior.

The complete default and feature builds now compile, link and publish through
the normal package pipeline. Installed development commands execute JavaScript
and default TypeScript on the Node host, Chromium, Firefox and WebKit, with
ordinary exit and acknowledged process/thread retirement. These observations
are not formal CLI acceptance or complete native cleanup qualification. The
latest full CLI development run passes 45 of 47 variants. Both ESM variants fail
in synthetic-module evaluation; native parser diagnostic controls also expose
two missing distinctions. The related source fixes are applied but unbuilt.
The earlier four-host development results do not qualify these new sources.
Generated build files retain external headers on runtime targets, system-header
warning classification and one guest libuv in the executable dependency closure.

The generated `node-engine-inputs.json` retains the producer's incomplete status,
actual dependency identities and remaining work. No shell dependency, copied
shell executable or fabricated complete-SDK metadata is used. Original owners,
remaining consumed engine APIs, native Amaro/FFI, providers and integrated
qualification remain required before acceptance.

The source patches add truthful Kandelo/wasm32 configure choices and retain
Node's portable simdutf dependency with an external engine. Native Amaro keeps
the original lazy loader and complete upstream wrapper; its approved availability
check recognizes the real native binding. The original enabled registrations
remain present, with that binding added. The native retirement patch replaces the
reviewed destructor's empty-script mechanism; other engine-specific native
adaptations remain work. Old packaging source and artifacts are preserved as
historical evidence. They cannot satisfy these new recipes.

Additional guards retain complete original bodies while omitting the separate
V8 cppgc process cage, its Abseil deadlock-detector suppression, startup-snapshot
rehashing and optional V8 statistics dumping on SpiderMonkey. Kandelo follows
Node's existing no-execinfo path for native symbol diagnostics, as other musl
targets do. JavaScript error stacks use the real engine stack adapter; public
heap metrics and normal error/exit policy are not disabled by these guards.

Provider preparation retains Node's original OpenSSL Configure/GYP generation,
with a wasm32/Kandelo target, portable C, pthreads and dlfcn support. Its core,
helper and FIPS source partitions remain upstream-owned. The no-assembly path
does not require x86 assemblers; optional documentation generation is omitted
because the Node archive lacks those OpenSSL build inputs. Cryptographic
algorithms and Node's provider policy stay unchanged. c-ares configuration comes
from its original CMake checks using the SDK; function checks must link rather
than accept unresolved calls in static test archives.

Native build tools use native dependencies and regular host archives. Guest
libraries and include paths stay on the target toolset; the guest libuv remains
the separately declared Kandelo build. These build settings preserve the full
runtime registration and source graphs.

The current private feature-profile build compiles 23 native provider library
targets and the original ICU/JavaScript data tools. These are unpublished build
products; runtime behavior, separate default-profile artifacts, provider modules
and helper executables remain unqualified. FFI, native Amaro, complete engine
interfaces and original runtime ownership are still required for the full build.
