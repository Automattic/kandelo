# Owned terminal output and stdio methods

Source161 integrates pinned stdio output cursor/color/window methods and an
actual native output descriptor owner. Verified slave terminals reopen the
same terminal into an independent open-file description, preserve the public
stdio number through real dup2/dup3 initialization and own only an extra fd.
Setting blocking status on that independent description does not reflag the
inherited stdin alias. Native full writes finish before Writable's callback;
Writable still owns backpressure/drain/encoding/error scheduling. No method
fabricates a handle, queue size or write return value.

Native terminal leases retain actual descriptors through GC/context lifetime
and close the extra descriptor before releasing state. Checked/rooted actual
lease/view admission preserves denied-wrapper errors and owner lifetime before
view authority work. Public nonallocating data access runs in the actual view
realm under no-GC. The original public view accessors were already wrapper-
aware/nonallocating; no crypto raw-helper defect is alleged for them.

Normal source/bootstrap/header/unity and752 guarded-input checks pass. Ten
existing fd-stream/readline checks and14 package-source tests pass, no skips.
The original12-group PTY assertion file, including its HWM=1 assertion, remains
byte-identical. Identified existing native evidence matches12/12 slave-PTY and
7/7 descriptor/OFD groups using the actual production header through an
explicit N-API bridge. The earlier11/12 backpressure failure remains saved.
Those checks do not execute production JSAPI or the Wasm dup3 branch.

The strict real master-terminal fallback comparison STILL FAILS: native write
returns true at HWM=1 while the retained actual borrowed async path returns
false. Both children exit normally; that does not make the comparison pass.
Unreopenable/shared alias paths remain actual implementation gaps. No public
TTY constructor or complete Socket/TTYWRAP/ref/close behavior is supplied by
stdio mixins. Partial/EAGAIN write queues, externally changed flags, zero/read-
only/interrupted/cross-thread cases, private SIGWINCH activation and full
readline/REPL/history/permissions remain open. The same-number reopen source correction below does not establish every
arbitrary-fd/concurrent-close case or broader public constructor behavior.

Four earlier tiny native helper compilations are accounted for (one original
window bridge and three actual output-owner controls); current integration and
realm source correction compile nothing. Existing TCP/Agent timeout-policy,
crypto, SQLite/Locks/Body/X509/loader and other source remains preserved.
There is no accepted current engine or guest/four-host conformance. Overall
suites and full product rebuild remain deferred; all nineteen families partial.

Exact evidence: [tty-output-finding-progress.json](tty-output-finding-progress.json).

The captured-owner followup routes native size queries through the same actual
OutputHandle as synchronous writes. A private output-object WeakMap retains the
opaque lease; no numeric-fd owner map or public fake handle is introduced. The
unsupported borrowed fallback still uses its borrowed fd and remains a gap.
Four genuine two-PTY native/component groups match the pinned reference after
closing/reusing public fd1, resizing each separate terminal, mutating public
`fd`, writing to both terminals and closing the actual captured owner. Their
assertions preserve changed-only resize and real EBADF/cache behavior.

The original twelve-group failure-injection setup closed public fd1 only for
the component, versus the actual native handle for Node. That old setup now
correctly leaves the component owner alive and fails its previous expectation;
its raw failure is preserved. Only the setup is corrected to close the actual
native lease in both modes; all existing assertions, including HWM=1, remain
strict, and twelve groups match. Seven ownership groups also match. The strict
master fallback still fails and is not passing compatibility.

An actual same-number reopen is promoted to a separate descriptor before
initializing the supplied number, avoiding dup3(fd,fd)/EINVAL and preventing
teardown of the public number. A tiny native production-header control forces
that real close/open interleaving: the prior header closes the supplied number
on teardown, while the candidate keeps it open and retains real size/write
operations. This controlled interleaving does not prove all concurrent-close
races or public constructor compatibility. Production JSAPI, the Wasm dup3
branch and four-host conformance remain uncompiled/unrun for this followup.

Source163 integrates that captured-owner followup over current162 signals and
all earlier source.757 guarded inputs and24 existing fd/readline/package
checks pass, no skips. Five earlier tiny native compile attempts succeeded;
this root integration adds no compilation. Native controls remain explicitly
separate from uncompiled production JSAPI/guest dup3 and four-host evidence.
