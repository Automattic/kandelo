# Scoped synchronous VM deadline integration

Source174 connects unchanged pinned public VM option validation to a real
C++ steady-clock watchdog and context-qualified invocation owner. Positive
validated milliseconds are forwarded as an own object-literal property;
inherited timeout setters cannot consume that field. Untimed calls retain
their existing path. The existing compileFunction body is byte-identical.

The watchdog requests the actual engine interrupt callback without entering
JavaScript. Cancel notifies and joins before its context/frame retires.
Normal expiry keeps requesting until joined, preventing an embedding interrupt
callback from consuming one request and then hiding indefinitely in JS.
The JS-thread-owned frame chain selects the outermost triggered invocation;
foreign/outer termination remains uncatchable across inner VM boundaries.
Only the owning invocation translates after execution unwinds and its thread
joins. Pinned native controls establish that this Error belongs to the target
VM realm, with the real configured timeout and observed code descriptors.

The source preserves actual shell/worker quitting, exit, independent service
interrupt, OOM/recursion and forced-return ownership. A real active VM timeout
is not reclassified as a global shell EXITCODE_TIMEOUT. No interrupt bits or
callback lists are cleared to cancel a local scope. Thread/resource/wait
failures remain real errors rather than fabricated timeout success.

## Identified focused evidence

The actual portable owner/header is byte-identical to its sealed compiled
component. Ten current native thread/frame groups pass. Eight current public
VM deadline groups and eleven validation comparisons match exact native
26.13.0 over explicitly supplied native VM contexts/scripts/watchdogs. The
whole unchanged upstream test-vm-timeout.js passes in both processes; SHA
08a5bc166264ccdb776270c98b59a328cd3c5fd4af7069f5e0d3b8654165ddc0.
These frontend controls do not execute the new SpiderMonkey interruption.
Eleven affected host component checks and fourteen existing package checks
pass; the combined report retains all25cases and their actual file identity.
Normal source staging,789declared inputs, generated bootstrap syntax, exact
engine patch replay and the unchanged Mozilla include checker pass.

Three earlier tiny compiler attempts are accounted here: portable native
owner success, initial SDK missing-dependency failure, then SDK object success
with the actual declared libcxx headers. Root reuses the exact native binary
and object; no new engine compilation occurred for174. The setter-dropping
source failure and both SDK/component fixture setup failures remain preserved.
The accepted173artifact predates this slice and is stale for174.

## Remaining implementation and validation

The real condition-variable wait-failure catch currently sends only one
interrupt, unlike normal expiry's repeated requests. A reentrant embedding
interrupt callback could consume that request. This remains an unresolved
source edge, not a passing case or accepted platform boundary.

Actual production174JSAPI compilation/execution, JIT/interpreter/GC/realm,
OOM/forced/foreign interrupt precedence, blocked guest execution and worker/
context retirement are unvalidated. Per-context microtasks/afterEvaluate,
module evaluate timeout scopes, breakOnSigint, debugger/cache and dynamic
import remain separate implementation gaps. Cooperative engine interrupt
points do not imply preemption of arbitrary blocking native code.

No API/finding/family is closed. No guest or four-host runtime conformance,
overall suite or full product rebuild is claimed. See the
[scoped ledger](vm-execution-deadline-finding-progress.json).
