# Worker threads source audit

State: **complete source review with substantial implementation gaps**.
The full family report is [worker-contracts.md](worker-contracts.md).
All 147 original discovery obligations (73 document sections and 74 saved
descriptor observations) have been reconciled, with additional returned,
inherited and source-discovered contracts. This does not mean the APIs
are implemented or validated.

The active adapter starts real shell threads, but the child receives a
minimal prelude instead of the Node environment. MessagePort.postMessage
and start do nothing; MessageChannel endpoints are disconnected;
Worker.postMessage throws. workerData uses JSON or one shared mailbox;
terminate synchronously joins all shell workers and reports exit 0.
Options, loader, parentPort, environment data, stdio, identities, resource
limits, profiling, locks and most messaging controls remain missing or
partial. R-001–R-013 and R-015 identify the specific contracts and owners.

The review traces actual clone/thread/mailbox/native reference ownership,
pthread/TLS/CTID and kernel threads, outer host channels/generations,
thread slot allocation, exit coordination and memory reclamation. Node
awaits a termination barrier; the browser source requires guest quiescence
before freeing a slot. The shared guest factory gaps apply on all four
hosts by source inference. No new four-host runtime difference has been
observed, and no blanket worker API exclusion is justified (R-016).

R-014 preserves explicit target questions about profiling rejections and
fractional options, already-stopped terminate results, cross-environment
lock query visibility and pending-abort/environment cleanup progression.
Those require exact native controls later; the audit changes no target,
assertion, implementation or historical result.

`worker-requirements.json` records per-member requirements, original
capture descriptors, all document section identities and source hashes.
`worker-validation-candidates.json` records unchanged future source files
and their flags/helper roles. Catalog file counts are not an executable
case/subtest/variant denominator. No runtime tests, probes, compilations
or builds were run. Current-candidate conformance remains unestablished
on Node, Chromium, Firefox and WebKit. Implementation and new runtime
validation require separate explicit authorization.
