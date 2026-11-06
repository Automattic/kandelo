ReadFileJob's native output has a logical result length and a separate actual
allocator request capacity. The read-file-buffer.h owner records successful
malloc/realloc capacity in the native ledger, including growth, retained small
slack, optional shrink failure and the one-byte allocation for an empty result.
Failed realloc retains the old pointer/capacity; read errors free that storage
and remove its payload credit. Its deallocator always follows the actual data.
These are requested-allocation and concrete-owner records, not RSS or allocator
usable-size measurements.

The worker holds a real ReadFileBuffer allocation capability. Resize/Clear are
private to its sole mutable native-work phase; pool completion publishes those
fields before JS result preparation. The ordinary existing USER_OWNED backing
transaction exposes an ArrayBuffer with the logical result length while
retaining this same allocation and its real capacity. Commit freezes the owner;
future retained spans and JS/clone owners keep the same allocation alive. No
payload copy, logical-size replacement charge, script metadata or borrowed-root
retention is used to hide allocation slack. The existing shared immutable
backing-store implementation and WriteFileJob input ownership are unchanged.

This producer owns its allocator from its creation; it is not a borrowed raw
allocation supplied to the generic Prepare factory. Before publication it can
abort/free natively. Existing InstallUserOwned commits its immutable published
phase only after creating the real JS backing owner. Failure leaves the native
job responsible. USER_OWNED content is native-accounted in the existing engine;
this private producer rejects an engine-accounted owner policy instead of
counting one payload twice. It is nonshared, so shared raw-buffer JS-owner
synchronization is not part of this allocation's owning contract.

Each actual owner/span has native claims for its own metadata and the one real
allocation record. Context retirement can move projection to another actual
claimant or the process pool. Last native-span release can free bytes off the JS
thread without calling JSAPI or retaining a context/realm. GC projection remains
an owning-thread operation through the existing native ledger balance.

Focused portable controls compile the actual allocation owner and the exact
worker Run body with explicit allocator/syscall/scope dependencies. They cover
capacity versus logical length, allocator failures, errors, descriptor handoff,
prepared owner rollback, aliases, account retirement and off-thread last free.
Native Node26.13.0 controls establish unchanged logical result/error/fd reference
behavior only. The actual SpiderMonkey JSAPI class integration, GC pressure,
realm/transfer/clone/teardown and all four guest hosts still need validation.
The existing PrepareResult conversion/OOM callback policy is not established
as matching Node by these ownership controls. No complete filesystem or public
memory-metrics compatibility claim follows from this source slice.
