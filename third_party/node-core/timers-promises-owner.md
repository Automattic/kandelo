# Shared Promise timer algorithms and insertion owner

Public timers/promises now consumes complete unchanged pinned lib/timers/
promises.js (Node26.13.0) through the existing real timer/resource owner.
The adapter supplies actual shared validators/errors, resistant EventTarget
listener state and captured Promise primordials; no native-host production
module delegation is used. Validation getter/error chronology, cleanup in the
returned Promise reaction, interval return/abort backlog and Scheduler methods
come from the pinned source rather than local output matching.

Timeout construction owns the real AsyncResource but does not insert a task.
Classic setTimeout/setInterval explicitly insert once. Promise source passes
its actual idle duration to a private insert(timer,msecs), which captures the
real current monotonic origin, truncates delay with the captured MathTrunc,
and schedules through existing native timer dispatch/ref/cancel owners.
Immediate retains real constructor insertion. Refresh/repeat/native retirement
remain owned by the shared scheduler; no fake completion/ref state is added.

Native-dependent component evidence does not establish actual guest JSAPI,
Promise-hook activation/frame/fatal/rejection ordering, per-host scheduling,
GC/OOM/worker teardown or all timer lifecycle/metadata behavior. Other async
and timer findings remain open. Overall suites/full product build stay deferred.
