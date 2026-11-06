# Statement close/dispose ownership slice

The public frontend now implements Statement.close() and idempotent
Statement[Symbol.dispose](), including the target's receiver failure,
function names and enumerable/writable/configurable descriptors. The native
Statement owner retires its actual sqlite3_stmt pointer before finalization can
invoke aggregate callbacks. Explicit close rejects an already-finalized VM;
disposal succeeds repeatedly, including after database close.

Actual native step/reset scopes bar reentrant close of the executing VM.
The frontend additionally covers the entire parameter-getter execution phase.
Other statements on the same connection remain usable/closable. Existing
iterators observe actual native finalized state rather than a separate fake
closed flag. Connection teardown drains weak statement-observer batches so a
finalizer can extend that vector without invalidating an active iterator or
leaving its newly prepared VM hidden after close. Native JSAPI close/finalize
routes return failure when an aggregate callback leaves a pending exception;
they do not overwrite the original JavaScript failure or return success with
an exception pending.

`owner.cpp` compiles the actual portable owner against an identified existing
object of the exact pinned Node-vendored SQLite library. It exercises native
callback reentry and pointer-retirement ordering and separately asserts that a
statement created during connection close is retired. Those raw SQLite aggregate callbacks are explicit lower-level stress inputs,
not Node public aggregate result callbacks: Node and Kandelo skip JS result
callbacks after window xValue during cleanup. The raw reentry/drain assertions
are not claims of native Node public behavior for those scenarios.

`control.cjs` runs identical case bodies in isolated pinned native/candidate
children with bounded timeouts. Candidate frontend dependencies are actual
native Node SQLite connections, callbacks, encoding classes and process.
`parameters.cpp` prepares against a real serialized snapshot of that fixture
connection's schema and registered callback signatures, collecting SQLite's
actual parameter metadata without executing its placeholder callback bodies.
Neither the product nor fixture parses SQL or simulates SQL result sets.
This native serialization dependency does not implement the missing Kandelo
Database.serialize/deserialize APIs.

`upstream.cjs` compiles the whole unchanged upstream Statement test file with
native VM/test/common dependencies and supplies the actual frontend for its
node:sqlite dependency. The native runner's name filter selects only the close
and disposal suites. Full-file identity, static declaration inventory, filter,
selected/runtime/filtered counts and full native/candidate TAP remain in the
sealed evidence. Filtered tests are not passing compatibility.

These checks do not compile the guest SpiderMonkey binding or validate guest
GC, filesystem, exception paths or four-host conformance. Authorizer/busy
policy, complete reset/iterator semantics, other method receiver/descriptors,
Database disposal error suppression, serialization/deserialization, tag-store,
backup/extension owners and remaining audited SQLite APIs stay open. No
implementation gap is accepted as an engine/platform boundary by this slice.
