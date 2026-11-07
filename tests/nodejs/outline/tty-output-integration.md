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
readline/REPL/history/permissions remain open. Arbitrary-fd same-number reopen
also needs explicit dup3(EINVAL)/ownership review before broader constructor
claims; process stdout/stderr use the separately protected public fd1/fd2 path.

Four earlier tiny native helper compilations are accounted for (one original
window bridge and three actual output-owner controls); current integration and
realm source correction compile nothing. Existing TCP/Agent timeout-policy,
crypto, SQLite/Locks/Body/X509/loader and other source remains preserved.
There is no accepted current engine or guest/four-host conformance. Overall
suites and full product rebuild remain deferred; all nineteen families partial.

Exact evidence: [tty-output-finding-progress.json](tty-output-finding-progress.json).

A concrete followup remains in window metadata: getWindowSize/_refreshSize
still query the borrowed public fd, while writes retain the separate actual
output owner. Closing/reusing that public number can therefore query the wrong
object. Size/resize must route through the captured owner. This source-visible
implementation gap is recorded separately from unrun runtime questions.
