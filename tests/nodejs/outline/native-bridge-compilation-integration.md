# Native bridge compilation checkpoint

Normal job node26-engine199-1107-032352-01c0 failed exit1 after6m36s. Preflight
selected exactly9nodes,8cached and only SpiderMonkey to build. Native C++ compilation
was reached; no kernel/rootfs/app/full product rebuild or overall suite ran.
All frozen source identities were unchanged throughout. Exact audited pins and
ABI55 remain unchanged. No new engine artifact was accepted.

## Actual errors and source200 corrections

The first error is missing operator* on the actual transit Root used by destination
peer detection. Root now exposes that operation without changing storage/lifetime.
A redundant second anonymous namespace in native-ports.cpp left the fragment scope
open, so later js::shell registry declarations became anonymous::js and shadowed
real engine symbols. Removing that opening restores shared histogram/port forward
identities and the actual global FFI registry type; no unwrap/access check weakens.
The real140JS_InitClass parameter order and explicit DynamicLibrary name replace
an old API call, and PropertyKey::Symbol replaces a removed macro.

Current normal staging/pinned bootstrap syntax/unchanged Mozilla checker and866
input closure pass. One fresh portable compile over current graph headers passes9
ownership groups/100publication races; all compiler input identities are recorded.
Twenty-five affected checks pass (14package,11port wrappers over native boundaries).
These controls do not prove complete SpiderMonkey bridge behavior or convergence.

## Durable failure identity and limits

.context/node26-engine199-failed-r1 preserves raw output, first diagnostics, normal
plan/preflight/terminal and a reconstructed normal native unity file from frozen
input staging. The resolver deleted its failing work tree; the reconstructed
unity is not mislabelled as the retained actual compiler input. Source200 normal
engine retry is still needed. The prior compiler hit its error limit; further
errors may be exposed. No upstream/runtime defect or workaround is inferred.

All old semantic/API gaps, component ALS/frame nonpass, skips and historical
four-host outcomes remain. Selected compilation/link/cache acceptance is separate
from artifact materialization and actual four-host runtime conformance. No finding
or family closes;173remains last accepted engine. Full product/overall deferrals
remain in force, nested guest Wasm backend remains in scope for the final phase.
