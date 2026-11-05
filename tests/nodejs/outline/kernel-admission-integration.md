# Current kernel admission and focused environment execution

The earlier zero-case engine100 preparation failure was caused by the retained
kernel, not a tested Node API result. Static inspection of that exact ABI55
artifact found two missing required exports: `kernel_initial_exec_commit` and
`kernel_spawn_exec_target_prepare_handle`. Its SHA256 was
`0e6e314268222186f1efe0833ff97eea50faaee026cc9e78db68779b7bacd4b5`.
The current resolver rejected it. No rejected kernel was instantiated or
restamped to bypass admission.

The first canonical `./run.sh build kernel` attempt stopped during graph
planning at `unclassified registry root "node-cares"`, before kernel Wasm
compilation. All six newly registered Node dependency libraries were missing
from `packages/sets/local-supported.toml`: node-cares, node-codecs, node-llhttp,
node-ncrypto, node-simdjson and node-sqlite. They are now classified as platform
packages, matching the existing library roots. They are not source-only
packages, so the set's dependency-only classification would be incorrect.
The graph validator is unchanged.

The second canonical targeted build succeeded and produced an accepted kernel:
2,581,970 bytes, SHA256
`f5abc0afcb7f025c33eb35e7ce21e2321d2ad8a39153f5ca2765d565bab01f69`.
The normal resolver admits it with no kernel artifact-policy failures. This
build refreshed only the kernel target and its prerequisites, not the full
product. Normal publication removed stale packages from the local projection;
the old kernel and earlier projection metadata were preserved before building.

## Identified runtime evidence

Three same-source native/Node-host guest controls directly exercise public
`process.env` in fresh processes. They do not construct a substitute Object
through the currently incomplete environment prototype constructor.

| Control | Native26 | Actual Node-host guest |
|---|---|---|
| Non-Proxy environment, live mutation and ordinary independent clone snapshot | Pass | Pass |
| Inherited receiver writes, symbol get/membership, descriptor rejection and refused non-extensibility | Pass | Pass |
| Private transfer/clone marks, unchanged reflected keys, permitted snapshot before clone denial | Pass | Pass |

All three guest processes exited zero with matching fixed result markers:
3 pass, 0 fail/skip/unsupported/timeout/harness error. The sources never print
the environment or snapshot contents. These results use engine107 SHA256
`41fec54aba999ce2766d98e988f396ae67e0e18c520776fcce687bbc52090431`,
the newly admitted kernel, and the retained shell image SHA256
`83293c21fa6c4d290420aa8a30dca93266eafe90a5e05aa911477e305012e362`.
The exact native reference remains SHA256
`533bd644c5ae0e0ea3a80e433aad16b817447ccba1e1eea701875eac80cb75d4`.
Sources, identities, stdout/stderr, timings and per-case outcomes are retained
in `.context/node26-environment-guest-controls/report.json`.

The directly resolved engine107 artifact lacks a program contract digest stamp.
The host's existing rollout policy admitted it with a visible warning on each
launch. This does not establish stamped package/image consumer admission.
No stamp was manufactured. Kernel admission, execution of these three cases,
and a complete canonical product closure are separate claims.

The earlier native addon's custom-class snapshot failure remains a failed
fixture case. These actual guest passes supply separate runtime evidence;
they do not rewrite that result. Full environment prototype/constructor,
integer-key ordering, warnings/TZ/permissions, worker/shared-store behavior,
GC/cross-realm/JIT/OOM/lifecycle and browser conformance remain open.

Overall suites and the full product rebuild remain deferred. No module family
or individual API is certified complete by these controls.
