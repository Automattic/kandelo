# Retained codec storage component

Generate contexts with the normal generate-codec-contexts.py, preserving exact
pinned excerpt hashes. For this host-only component, replace only the four
Mozilla mutex/assert header includes with host-mutex-boundary.h, retaining all
actual generated class/method/allocator bytes. That boundary uses real native
std::mutex and fatal assertions; it is not a SpiderMonkey compile substitute.
Copy the unchanged codec-owned-capacity.h to the include name
kandelo-node-codec-owned-capacity.h beside the generated component header named
native-codec-contexts.h. Compile addon.cpp once as a low-debug shared NAPI module
against exact Node26.13 NAPI, zlib/Brotli/Zstd headers; the pinned Node executable
exports the real corresponding C codec functions. No library builds or native
host codec implementation is substituted for candidate algorithms.

Run control.cjs under declared devshell with exact Node26.13 and explicit
CODEC_CAPACITY_COMPONENT path. It performs no setup/build, returns actual native
owner observations and asserts seven groups. Positive library/context cleanup,
reserved dictionaries/params, SSO and external strings, post-thread error storage,
reset/close and genuine invalid-parameter initialization are covered. This does
not inject allocator failure or validate JSAPI/associated-GC-hook/finalizer/error
identity/guest libcxx/four-host behavior. Record exact artifacts/dependency files
and every failure; no performance or heap-snapshot claim.
