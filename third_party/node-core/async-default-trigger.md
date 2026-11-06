The default trigger override is a numeric owner separate from the captured
execution/continuation state. The native environment/context initializes it
to -1; a nonnegative override wins over the current execution ID, while -1
uses that ID. The private swap accessor validates safe numeric IDs, returns
the previous raw override, and does not coerce values or call user getters.

The public pinned AsyncResource algorithm, TickObject construction and generic
owned task construction all consult that same native accessor. The internal
defaultTriggerAsyncIdScope mirrors pinned Node's try/finally restoration,
including nested, undefined, zero, clear and throwing scopes. It does not set
or copy a defaultTriggerId property into async-context state.

Engine JSContext owns the value; VM realms on that context share it and new
worker contexts initialize their own value. Promise parent identity takes
precedence over the default. Root promises and native jobs with no parent use
the accessor. Promise frames/job host data and execution-ID push/pop omit the
override, so a later callback receives its own execution identity instead of
a captured temporary default. The existing parent reset around promise-init
hook reentry is preserved. Numeric state needs no GC trace or JS rooting.

Native FS/DNS/codec constructors consume the same accessor without replacing
their current providers, frames, async init/retirement or callback scopes.
The separately sealed, not yet integrated UDP source consumes it too; queued UDPSENDWRAP init additionally holds
a real native RAII default scope over its UDP owner ID, matching the pinned
UDPWrap::Send DefaultTriggerAsyncIdScope, including nested hook allocations.
A separate future delta covers the sealed ELD provider source. Both provider
deltas remain pending integration; they are not present in source133.

The engine patch adds the exact async-default-trigger.h owner as
vm/KandeloDefaultTrigger.h and a JSContext-owned instance; test/patch identities
must keep these bytes identical. Native accessors/private functions and the
Promise fallback need actual SpiderMonkey compilation and execution. Focused
NAPI controls exercise the identical numeric owner and current public adapter
through the existing Node ALS/AsyncResource fixture; that fixture does not
implement the guest Promise metadata/activation, numeric destroy queue, realm
security or engine worker lifetime. Its after-Promise execution ID remains the
fixture's own ID, not a claimed match to native Promise identity.

Native baselines and controls cover nested restore, native/JS reentry, VM calls,
init hooks and noncapture after Promise/tick callbacks. A separate NAPI worker
checks per-environment numeric-state isolation. These are host controls, not
Node/Chromium/Firefox/WebKit guest conformance. Original queued-view leases,
RAB transfer/resize backing ownership and broader async provider gaps remain
separate work; this default-trigger owner does not establish them.
