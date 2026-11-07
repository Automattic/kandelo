# TCP owner and HTTP Agent component controls

The production candidate owns TCP descriptors, queued and admitted read
material, native connect/write request records, close completion, and
per-environment teardown. The socket adapter consumes unchanged selected
Node 26.13.0 stream-delivery and socket-option algorithms. The HTTP adapter
consumes the pinned Agent module and selected ClientRequest admission,
free-socket, proxy and cancellation algorithms.

These controls deliberately distinguish the layers they exercise:

- `ownership-control.cc` compiles the actual portable `socket-owner.h` and
  retained-memory ledger. It uses actual local socketpair and INET loopback
  descriptors to check transactional adoption, partial writes, read
  admission, EOF, descriptor reuse, allocation failure and retirement. It
  does not execute SpiderMonkey classes, roots or callback scopes.
- `adapter-surface.cjs` evaluates the actual production adapter object over
  an explicitly recording native boundary. It checks that private TCP
  methods are forwarded with their original arguments/results; it proves
  no native socket behavior.
- `native-callback-reference.cjs` observes the exact native Node target's
  reset/read-stop/destruction-before-read ordering. The destruction mode
  currently exits 1 when unchanged `onStreamRead` raises `ERR_OUT_OF_RANGE`
  after the before-hook destroys its stream. That outcome remains a
  nonpass; it is not an accepted platform exclusion.
- `host/test/fixtures/node-socket-async-controls.cjs` drives the candidate
  JavaScript hook registry with actual native TCP resource IDs and reset
  events. It checks the entering callback ID and dynamically replaced
  public execution-resource alias, not production SpiderMonkey behavior.
- `host/test/fixtures/node-http-agent-controls.cjs` compares candidate
  Agent/client algorithms with the native target over real local TCP
  requests. Its socket, stream, async and parser dependencies are supplied
  by native Node, explicitly. This does not validate the new native TCP
  embedding or its combination with candidate dependencies.

Production C++/JSAPI compilation, GC/realm/OOM behavior, native-loop callback
recovery, engine-specific execution and four-host conformance are unrun.
Queued scalar and buffer-vector native writes retain their actual original
allocation, offset and initial count through the real backing capability. The
normal public Writable vector dispatch and mixed string-vector encoding owner
remain separate gaps; private mixed-string vectors fail explicitly. The server listener/accept path,
legacy TLS watches and public HTTPS Agent/session/CONNECT ownership also
remain outside this slice. No family or public API is complete from these
component checks alone.

The JS and native stream-state layouts are generated together from the exact
pinned StreamBaseStateFields enum (five fields, including the async flag).
Original-write ownership and state publication have focused native reference
and portable-factory evidence; the production JSAPI submission path remains
uncompiled and is not runtime conformance evidence.
