# Retained native Server listener prerequisite

Ordinary Server listeners now return one opaque native capability, owning the
actual admitted listening descriptor. The same owner controls address/ref/close
and rooted accept watchers. A numeric _fd is diagnostic only; it is not accept,
reference or cleanup authority. Reentrant close marks the actual native owner
closed before returning; native dispatch retires/cancels its original watched
Promise without accepting a later descriptor reuse. Context shutdown removes
its watches and closes its owners without user callbacks. Foreground GC closes
only unrooted resources; pending accept roots prevent dangling native state.

The owner does not manufacture TCPWRAP identities, init/destroy hooks, trigger
frames, callback scopes or a public _handle facade. Those full native Server
AsyncWrap/provider/close semantics remain implementation gaps. Existing accepted
TCP ownership is reused unchanged. Native component TCPWrap dependencies and a
portable owner compile do not establish guest JSAPI/realm/GC/fatal/four-host
conformance or absence of all ordinary Server lifecycle gaps.

Public listen({fd}) remains explicitly unimplemented. Target createHandle first
classifies a real TCP or Pipe descriptor, initializes its actual server wrap,
then open(fd) performs loop-duplicate admission/nonblocking/stream transfer.
Successful open transfers the supplied descriptor (no silent dup). Post-open
listen failure closes that transferred descriptor; pre-open classification or
EEXIST failure must leave caller ownership intact. Native bound/listening TCP
references confirm supplied-fd close and reused-fd safety; regular-file input
fails asynchronously with EINVAL and remains live. Real PIPE/Unix-path owners,
exact getters/error/async init/reentrant-open chronology, loop fd registration,
full native provider and public overload integration remain next prerequisites,
not accepted exclusions or passing unsupported tests.

The portable Owner::Admit primitive is consumed only after actual ordinary
socket/bind/listen success and all fallible native allocations. It must not be
used as a numeric public fd-admission API without the checks above. Descriptor
ownership assumes callers honor the same POSIX transfer contract as Node;
external close/reuse of an already transferred fd is not a retained kernel-OFD
capability proof. No ABI/syscall/OS identity change is introduced.
