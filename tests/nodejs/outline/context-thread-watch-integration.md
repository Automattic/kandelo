# Context-thread native watch registry ownership

Source198 changes the actual generic native watch-list declaration to thread_local.
It preserves current197collector and195resource routes. Audited pins and ABI55 stay
unchanged. All four hosts execute this guest source; no current artifact behavior
on any host is inferred from this source correction.

The list stores JSContext, PersistentRooted Promise/terminal owners and callbacks.
All constructors, poll/unlink/cleanup calls execute on the calling runtime thread.
Worker contexts run/finalize on their own native threads. The old process-global
list allowed concurrent parent/Worker access to another runtime's JS roots.
Making only a context filter stricter would not repair that list ownership.

The immutable handoff README and references enumerate every actual consumer:
connect/accept/read/write, terminal leases, child waits and old TLS watches;
Worker creation/loop/join/context destruction and shared shutdown are traced.
Independent pending TLS changes use a separate thread-local registry and do not
duplicate this declaration. No external runtime defect is alleged.

Current exact forward/reverse patch replay, complete bootstrap syntax,865-input
closure, unchanged Mozilla checker and14package checks pass. Existing consumer
references,197collector and195native resource routes remain intact. No runtime
control, tiny compiler, engine/kernel/product build or overall suite ran.

Thread locality does not drain every outstanding numeric fd Read/Write Promise at
context teardown. Complete callback-free drain, actual async/provider identity,
descriptor/ref/error/cancellation and new TLS/TTY lifecycle remain separate owning
gaps. Production JSAPI/concurrency/GC/Worker/realm/shutdown evidence across all
four hosts remains required. No finding/family closes; accepted173is stale. Full
product rebuild/overall suites stay deferred; nested guest Wasm stays in scope.
