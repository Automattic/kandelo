# Async audit findings: validation, metadata and cancellation

Source work addresses bounded requirements from A-002, A-003, A-005 and
A-010. The family, scheduler, resource integration and four-host conformance
remain incomplete. The exact Node 26.13.0 source/native pin is unchanged.

| Finding | Source implementation | Remaining scope |
|---|---|---|
| A-002 | AsyncHook validates trackPromises with the shared actual validator and rejects false together with promiseResolve using the pinned error and validation order | Hook activation, exception/fatal policy, Promise/job/resource integration and guest conformance |
| A-003 | The public frozen null-prototype provider map contains the complete declared non-crypto and OpenSSL provider IDs in target order, generated from the same pinned native declarations used by owners | Enumeration does not implement the corresponding resources. Missing provider lifecycle/instantiation remains a gap |
| A-005 | EventEmitter removal uses the exact pinned indexed-shift/pop helper rather than consulting Array.prototype.splice | Broader EventEmitter/domain/context/error and guest integration. The target still consults list.pop; no blanket primordial-hardening claim |
| A-010 | Cancellation clears callback/argument slots for Timeout object, numeric/string IDs, close and disposal. Already-fired owners retain their original delay while releasing slots without duplicate retirement | Full timer/context/native-loop/worker ownership, interval/refresh/error ordering and four-host lifecycle conformance |

`host/test/node-async-audit-gaps.test.ts` executes the actual candidate
constructor, provider export expression, EventEmitter and timer/scheduler
source. Shared candidate validators/errors are real; native Node supplies
engine/error inspection and AsyncResource task boundaries. The timer clock
is controlled; it does not validate browser scheduling or guest JSAPI.
Strict native comparisons retain provider property order/descriptors and
the already-fired timer delay. The final r3 run passes ten controls with
zero failures/skips, including an exact native-version check. These are
scoped controls, not ten closed public APIs or four-host evidence.

The first run retained seven passes and two failures: the event fixture
omitted its actual values dependency, and the timer implementation changed
the delay when canceling an already-fired owner. The dependency is supplied
and the implementation now preserves the native delay; assertions were not
weakened. Inputs remain in `.context/node26-async-gaps-r1-inputs`; logs are
`node26-async-gaps-controls-r1.log`, `-r2.log` and `-r3.log` under `.context`.
The second run passed the original nine controls before adding the complete
provider-map comparison. None of these runs executes a guest product.

Recipe revision 63 includes the changed generated bundle and bootstrap.
There is no target, syscall, host import or wire ABI change. All four hosts
select these shared guest algorithms; their runtime behavior is unvalidated.
The full product rebuild and overall suites remain deferred.
