# WASI four descriptor owners

Partial actual guest WASI four-descriptor import ownership only:29source owners/17missing, distinct from existing outer host WASI shim. No nested backend activation, API/family closure or guest/four-host conformance.

Source245actualWASI four-fd owner and current generated JS over explicit native V8/NAPI/memory/POSIX dependencies:16native/16candidate fixturegroups plus6portable fd groups/80allocation trials. New guest JSAPI/realm/GC/fatal/Worker/backend/fourhost behavior remains uncompiled/unexecuted; all other native-integration gaps stay open.

Actual current source checks:902declared inputs,8commands exit0; public16native==16candidate groups, portable6fd groups/80allocationtrials(26cleanedfailures54successes),14packageinputcases. These are scoped native-dependent controls, not API or four-host conformance.

Actual fd_allocate,set_times,renumber,readdir owners and their real descriptor/rights/memory/error/cleanup contracts are described in third_party/node-core/wasi-owner.md.29source owners and17missing are inventory counts only. No fake advice or backend support flag was added.

The8missing-environment setup failures remain zero-credit; historical directWasm native-import ABI actual28versus expected61 remains nonpassing. Valid missing behavior is not a platform boundary. NativeCtor/V8/NAPI/current-memory components do not execute guest SpiderMonkey bindings.

Two historical tiny compilers are counted once337→339lowerbound with4oldunknown dependency attributions/history preserved. Root newcompilers0, accepted239history retained; ledger167andall19familiespartial.

Remaining:

- Compile and validate actual guest native-wasi/actual Memory brand/security/realm/GC/OOM/callback/fatal/Worker owners on identified artifacts across all four hosts
- Implement17missing imports:fd_advise,path10,poll,signal,four sockets; no success veneer over kernel advice stub
- Implement genuine nested guest WebAssembly execution backend in final phase; deferred last, required and not a platform exclusion
- Implement remaining raw-name/preopen/path capability/permission/resource ownership and guest kernel/VFS/libc behavior; native portable fixture is not guest conformance
- Resolve historical directWasm signed-i32/u32 native-import dispatch provenance actual28 versus61 without spoofable caller or assertion weakening
- No full WASI API/module/family closure, overall suite or full product rebuild; prior25source owners are not reaudited by these four imports
