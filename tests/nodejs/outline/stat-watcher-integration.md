# Native watchFile and StatWatcher integration

Source145 replaces watchFile/unwatchFile no-ops with unchanged pinned public
algorithms over an actual native metadata poll owner. The returned StatWatcher
uses actual asynchronous POSIX stat,negative status transitions,one-shot native
timers,ref/active state,stop/close and request ownership. The exact fs-poll.c and
uv__to_stat algorithm bodies are retained in a private native port,not a libuv
binary ABI substitution. Seven complete reference files match the Node26.13.0
archive. Only the derived conversion include's final separator LF is normalized;
its selected body/hash and the complete upstream source are unchanged.

The native STATWATCHER class has real async IDs/trigger/frame state,owned path/
work/material claims,weak inactive objects and strong active request roots.
Callbacks resolve onchange before scope entry. Context stop precedes native work
shutdown; close draining follows worker retirement. Foreground GC can transfer
inactive state to an intrusive close queue without JS resurrection. Existing
retained-memory accounts own real requested allocations;opaque allocator overhead,
physical GC pressure and current guest projection are not inferred from controls.

Root review corrected a shared clock issue in the proposal. Pinned watcher start
reads uv_now without refreshing it. A native addon observes that watchFile startup
leaves the actual libuv cache unchanged after a blocking interval;explicit
uv_update_time advances it. The new watcher context now reads existing ELD cached
time and start does not refresh it. Normal native clock updates sample once and
update both owners. Node bootstrap initializes that real clock before exposing
native bindings. This proves the reference policy and source wiring,not current
SpiderMonkey execution or complete global timer phase/order.

Six native/component public/ref/worker processes pass,as do actual allocation/
lifetime/rollback controls and the native cached-clock observation;all eight are
bounded/reaped. Four current host helper compile commands pass. An initial two
commands included one real compile failure because the root harness put the
private port uv.h ahead of Node's actual uv.h. That harness error is retained;
separate include scopes fix it. Thus root compilation accounting records6attempts,
not4. Normal source/header/unity staging and affected metadata/performance/package
checks pass. Public assertions and audited target/source/native pins are unchanged.

Original missing-addon/compile/HandleScope/Date failures remain retained. Root's
initial shared-recipe rebase and generated trailing-newline gate failures are
also retained;additive rebasing and deterministic boundary normalization fixed
them without changing algorithm bodies. The shared Date return correction was
already integrated at141. FS-014's distinct unlink/rmdir routes were independently
confirmed as already implemented;that reconciliation adds no runtime change.

Implementation still lacks complete native HandleWrap/AsyncWrap prototype and
binding-global aliased-stat-array interoperability,global timer phase/order,
shared uncaught-exception recovery/after-hook ownership,notification FSWatcher/
fs.watch/promises.watch,enabled VFS provider routing and backend metadata/permission
closure. Actual JSAPI/class/GC/realm/activation/OOM/reentry/worker shutdown and
four-host execution remain unvalidated. The callback recovery source gap is a
shared implementation dependency,not merely an unrun test or accepted limit.
No engine/package/kernel/product build,overall suite or full rebuild ran. No
program/kernel-host ABI change or API/family closure is claimed;all19 remain partial.

See [stat-watcher.md](../../../third_party/node-core/stat-watcher.md) and
[stat-watcher-finding-progress.json](stat-watcher-finding-progress.json).
