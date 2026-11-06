# Native default-trigger integration

Source133 implements one numeric override in each real JSContext. -1 uses the
current execution ID;0 and positive safe IDs override it. Swap validates before
mutation,returns the prior raw value and does not coerce inputs. The same header
implements native RAII restoration and is embedded unchanged by engine0107.
Captured frames,execution stack and queued job metadata never contain override
state. Promise parent identity takes precedence over fallback lookup. A worker
context starts with its own -1;VM realms on one context share the owner.

Pinned AsyncResource default construction,TickObject and generic tasks read
the native accessor. Internal scopes use try/finally. Existing FS/DNS/codec
constructors preserve their real provider/frame/lifecycle owners and consume
the same default. UDP queued-init RAII and ELD deltas are sealed separately,
not integrated by this checkpoint. This does not close full provider mapping.

The production _nodeNative adapter explicitly forwards both native operations.
Review caught those missing links in the private proposal. A new test executes
the complete production prefix and checks return values,argument identity and
native validation exception propagation. The old adapter lacks those functions.
No fallback or duplicated JavaScript override authority was added to production.

## Evidence and limits

Root22 focused frontend groups pass(1new forwarding group,21affected);12 package
input/source checks pass. Two native helpers compile:the actual numeric owner
through NAPI and its standalone RAII scopes. Native controls cover nesting,
throw/invalid/clear restoration;actual public adapter/native-owner controls cover
undefined/zero/default/reentry/VM/init-hook and override noncapture after real
Promise/tick callbacks. A separate NAPI worker checks environment isolation.
Five compiled NAPI headers match the exact pinned Node source archive.

The shared dependency fixture now loads the current generated production async
adapter directly;no copied pre-integration adapter or replacement algorithm
is used. Default tests inject the compiled native numeric owner. Existing
registry tests resolve their fixture execution ID and reject override mutation
unless that native owner is explicitly supplied. No guest behavior is inferred.

The actual native callback reentry fixture still reports candidate execution
ID0 while real native Node has a nonzero callback ID. The failed stronger check
and exact source/log/status remain preserved in the sealed private handoff.
Final controls assert default77 separately and report both IDs. That distinction
is not hidden or accepted as callback compatibility. Promise activation,parent
metadata,GC/destroy/fatal/teardown,VM security and worker JSAPI require real engine
execution;the combined117–133engine has not successfully compiled.

Root verification also preserved three harness nonpasses:initial frontend run
collected zero tests under the wrong root;the next frontend and first package
run failed configuration resolution. Absolute configuration paths plus explicit
host root corrected invocation;no runtime assertion was weakened. The corrected
22/12results are separate artifacts. Overall suites/full rebuild remain deferred.

Exact source/evidence identities and prior nonpasses are in
[the finding ledger](async-default-trigger-finding-progress.json). All19families
remain partially implemented;this is a shared prerequisite,not API closure or
four-host conformance. Program/kernel/host ABI,wire formats,memory ceilings,
source/target/native-reference pins and accepted artifacts were not changed.
