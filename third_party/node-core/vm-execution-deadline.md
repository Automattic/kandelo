# Scoped VM execution deadline owner

The public VM frontend retains unchanged pinned Node26.13.0 validation. A
positive validated timeout reaches the native VM invocation as an own property;
an inherited timeout setter cannot drop it. Untimed calls keep their existing
execution path. breakOnSigint, first-line debugging, per-context microtask queues,
module evaluate timeout scopes and dynamic-import ownership remain separate gaps.

`vm-execution-deadline.h` owns a real steady-clock watchdog thread for each timed
execution. It only requests the engine's thread-safe interrupt callback; it never
enters JS, dereferences realm objects or throws a catchable JS exception. Cancel
notifies and joins before its native invocation/context may retire. Expired
watchdogs re-request while armed, so an embedding interrupt callback which
reenters JS cannot consume the only request and then hide indefinitely.

A JS-thread-only, context-qualified frame chain identifies the outermost triggered
invocation. The SpiderMonkey interrupt path returns false without a pending
catchable exception, unwinding catch/finally blocks. Inner or untimed native VM
boundaries propagate another invocation's termination unchanged. Only the owning
boundary translates its timeout, after its watchdog joins and the running script
unwinds. Pinned native Node controls show that the Error belongs to the target
VM realm; it is then wrapped back to the caller like other VM exceptions. Its
code is ERR_SCRIPT_EXECUTION_TIMEOUT and its message reports the configured
milliseconds, not a fabricated elapsed-time measurement.

The shell callback still handles its own serviceInterrupt request and worker
quitting/status. A shell JS interrupt callback aborted by a VM deadline does not
turn that local deadline into a global shell EXITCODE_TIMEOUT. Normal engine
GC/compilation interrupts are unaffected; existing OOM/recursion/forced-return
and pending exception states retain their owners. The generic shell terminated
warning is omitted only for an actual active owned VM deadline, which is instead
reported as its real coded Error; unrelated termination/warnings remain visible.
No interrupt bits or global callback registrations are cleared to cancel a VM
scope. Late requests see the retired scope absent and cannot time out a later
invocation by themselves.

This is a source implementation slice, not complete VM/engine compatibility.
Actual SpiderMonkey binding compilation, JSAPI/GC/OOM and concurrent foreign
interrupt behavior, worker/context shutdown and all four guest hosts remain
unvalidated. Cooperative engine interrupt points are not a promise to preempt
arbitrary blocking native code. No new engine/platform exclusion is established.
The complete isolated native/component evidence and retained negative/setup
results are identified in the implementation handoff.
