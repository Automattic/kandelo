# Generic net.Server receiver and listener ownership

Source177 fixes the generic public constructor's actual receiver. A plain
call constructs a Server; a subclass or inheriting Server.call(receiver)
initializes that receiver and returns undefined. The previous wrapper
returned a separate instance, leaving consumers such as HTTP uninitialized.

The generator verifies the complete pinned net.js and exact constructor,
then inserts unchanged public option/validation/field segments into the
owning adapter. Actual EventEmitter/prototype chains, current stream
high-water-mark defaults, BlockList branding, method descriptors and the
getter-only listening property use their real shared owners. Missing native
_handle/Worker/resource metadata is not fabricated.

## Actual listener ownership

A native control establishes that reinitializing a listening Server resets
its public current binding while the old actual native listener remains
active on the same receiver. Private per-listener records now retain each
real fd, generation and ref state for its pending accept closures. New
current state cannot redirect those accepts. Stale DNS results are rejected
before bind. Records do not pass through overridable public helper methods.

Existing actual accepted-owner capabilities, native listen/accept/close/ref,
original socket adoption and option algorithms remain the transport owners.
High-water marks, noDelay/keepAlive and paused read state are initialized
before connection publication. Unpublished setup failure retires the actual
adopted owner and preserves the original exception.

These JS records are a concrete ownership improvement, not a complete native
opaque listener model or proof of fd ABA/fork safety. The real clone owner
continues denying transfer; unsupported Worker transfer is not advertised.

## Focused evidence and limits

Fresh current-source controls pass10native-reference and11candidate groups,
including7actual accepted native TCP connections. The existing accepted-owner
regression passes4scenarios/12connections with all identity/drop/poisoned-then/
getter-error assertions retained. Its native fatal-getter reference also
passes; candidate Promise rejection is still a semantic difference.

The component executes actual extracted candidate values/constructor/Server
owner/adoption/socket-option code over identified pinned native EventEmitter,
Duplex, TCPWrap and DNS. It uses paused real accepted sockets and does not
implement payload transport. It is not production SpiderMonkey, guest kernel,
async-init/Promise-fatal/GC/Worker/fork or four-host evidence.

Fourteen package checks,797declared input checks, combined bootstrap/unity
source generation and the unchanged pinned Mozilla checker pass. No compiler,
engine/kernel/product build or overall suite ran. Accepted engine173predates
current177combined source. Private34source checks and original failures are
preserved in the sealed handoff; the parent fixes the real missing adapter
input declaration rather than treating the failed private closure as passing.

Full listen overloads, arbitrary borrowed receivers, native async identity,
Worker transfer, hidden old-listener cleanup, connection counters across
active reinitialization, abort/close/relisten races and public lifecycle
remain open. Full HTTP Server/admission/ConnectionsList/synchronous parser
ownership remains separate work. No finding or family is closed.
