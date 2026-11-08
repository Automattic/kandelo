# Timeout primitive ID ownership

The shared timer consumer uses the actual async task's `async_id_symbol`, installed
by `createTask` before init callbacks. It does not allocate a second timer counter.
A private `kHasPrimitive` flag and null-prototype known-ID dictionary follow pinned
Node 26.13.0 `lib/timers.js` and `lib/internal/timers.js`.

First coercion registers even after expiry. Already-expired cleanup retains the
original delay and finds the retained callback/arguments through that alias.
Refresh uses a new actual task ID but retains the primitive flag: it must neither
invent a new known alias nor delete a legitimately registered old alias. Normal
expiry deletes the captured entering ID; callback-side unenrollment does not
retire/delete it a second time. Registration commits the flag before ordinary
ToPropertyKey conversion, including abrupt conversion and Symbol keys.

The A-012 ordinary prototype methods and private inspection owner remain intact.
The retained timer component fixture exposes its existing actual hook registry so
controls compare primitive IDs with real init callback IDs. No timer-ID sequence
is synthesized by the test.

Focused evidence uses the actual private bootstrap block with native monotonic
scheduler, AsyncResource, ALS, inspection and event dependencies. One unchanged
upstream primitive test executes with genuine subject global timer functions.
This is not guest native frame/GC/realm/Worker/four-host conformance. Two original
native timeouts involving cancellation inside an init hook remain unresolved;
the separate passing init-observation/caller-cancellation control does not pass
that case. A-022 Promise hook activation and other timer/fatal/phase/metadata
obligations remain open. No API/finding is closed by this source slice.
