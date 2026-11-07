# PerformanceNodeTiming lifecycle owner

Audited observability O-008/O-009 remain partial. The unchanged pinned public
PerformanceNodeTiming getters now consume actual native lifecycle marks rather
than absent measurements. This source does not establish guest conformance.

| Field | Actual owning event |
| --- | --- |
| nodeStart | Native guest program entry captured after real process clock origin initialization, before PreInit |
| environment | Main or Worker ShellContext registration before self-hosted/global/bootstrap work |
| bootstrapComplete | Actual JS bootstrap builtin/global/setup completion, before Worker LOAD deserializers or first user main/eval |
| loopStart | Existing real per-context EventLoopClock.Enter; no replacement or guessed timestamp |
| loopExit | Final native loop drain after beforeExit restarts, before natural exit callbacks; no mark on explicit/stopping exit |
| v8Start | Real unset state: this guest engine never performs V8 initialization, so pinned unset sentinel -1 remains |

Each timestamp uses existing CLOCK_MONOTONIC/process origin. Main and Workers
share that immutable process origin but have independent environment/bootstrap/
loop ownership. Default -1 is derived from unrecorded phase state; a recorded
zero-relative timestamp remains a real measurement. No host V8 timestamp or
SpiderMonkey-as-V8 identity substitution participates. Native clock/phase errors
propagate; there is no zero-statistics fallback. Existing ELU/idle ownership and
loop start are retained. Marking does not create timers/handles or keep a loop
alive. Public startTime remains the unchanged pinned entry's specified0.

The bootstrap marker deliberately does not occur after native bootstrap
Evaluate returns: that would already be after synchronous CJS or Worker user
code. Natural loop exit is marked only at outer main/Worker finalization, not
intermediate nested job drains. Explicit process.exit/stopping paths leave an
uncompleted loop exit unset, including when the loop already started.

## Concrete remaining Worker chronology gap

Pinned native Node Worker reference records bootstrapComplete before loopStart.
Kandelo's existing Worker owner enters its loop clock before the entire JS
bootstrap, which immediately handles LOAD/user execution. The new truthful
pre-LOAD bootstrap mark therefore follows that existing Worker loopStart. This
ordering mismatch is preserved as a real Worker LOAD/loop separation prerequisite,
not concealed by moving measured timestamps or marking bootstrap ready early.
Full persistent Worker startup/phase parity remains incomplete.

The legacy v8Start=-1 is a concrete physical engine boundary (no guest V8 init),
not a claim that V8 initialized or a reason to close the whole API/family. The
Node host's V8 instance and browser host engines are separate embedding systems;
the guest never borrows their lifecycle measurements. GC event type/flag policy
remains separately unresolved; this change does not activate GC observations.

## Evidence scope

One tiny native program compiled the actual portable clock header and passed its
real POSIX clock/phase/unset/idempotence/independent-thread assertions. Separate
four pinned Node reference subjects cover natural beforeExit restart, immediate
explicit exit, timer-driven explicit exit, and natural Worker exit/shared origin.
They are references and a portable component, not execution of new guest JSAPI.

Normal private core/bootstrap generation and three valid JS parser subjects
passed. The first raw adapter-prefix parse failed with expected EOF because it
is intentionally an open prefix; original receipt/source script are preserved,
and actual normal composition with suffix parses. New native JSAPI/engine hooks
remain uncompiled and unexecuted. Real guest GC/realm/Worker/lifecycle/fatal/clock
fault and four-host evidence remain required. No complete NodeTiming, perf_hooks,
GC, CPU/memory/uv metrics or API-family conformance is claimed.
