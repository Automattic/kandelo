# SQLite database image ownership

This source slice implements public Database.prototype.serialize() and
Database.prototype.deserialize() over the existing SQLite connection and
statement owners. The target remains Node.js 26.13.0, commit
18b32a3b1552e199a01f1a8d9fd64aa756d3b75b, whose node-sqlite dependency is
SQLite 3.54.0. The standalone sqlite 3.49.1 recipe mentioned by the original
NI-006/NI-009/NI-010 audit is a distinct historical reference; this change
neither changes that audit nor substitutes the standalone package.

The public algorithms follow src/node_sqlite.cc:2562–2703. serialize returns
an intrinsic Uint8Array containing the real selected schema image. A temporary
SQLite allocation owns the serialized bytes until they are copied into actual
engine storage, then frees them. Returned storage remains independent of the
database and subsequent imports; it is not a wrapper around a borrowed pointer.

The import path checks actual receiver/open/callback state before buffer or
options validation. It requires a genuine Uint8Array (including Buffer), captures
its intrinsic length before the single dbName getter, then rechecks connection
openness before allocation/copy. It copies the original length from current
storage after getters. Shrink/detach rejects, expansion copies only the captured
prefix, and shared bytes use actual relaxed atomic loads. No caller-provided
byteLength, constructor, species or numeric index getter supplies this metadata.

Connection::FinalizeStatements retains the existing close owner's reentrant-safe
observer loop. Import finalizes existing statements before attempting replacement,
also on a failed SQLite replacement. Real callback depth forbids deserialization
from SQL callbacks. SQLite owns the sqlite3_malloc64 allocation after entry to
sqlite3_deserialize with FREEONCLOSE|RESIZEABLE: exact 3.54 documentation and
implementation free it on failure as well as eventual successful close/replacement.
The caller must release its deleter before that call. No guessed file-header
validation precedes SQLite's real behavior.

The same methods have target names, zero formal parameters and writable,
enumerable, configurable descriptors. Illegal receivers throw the native
Illegal invocation TypeError without a fabricated error code. Backend allocation
failure uses the target ERR_MEMORY_ALLOCATION_FAILED RangeError. Existing public
aliases and factory routing are unchanged.

## Focused evidence and limits

The sealed sqlite-serialization-owner-agent capsule identifies every input,
command, output, failed attempt and binary. root-controls.py accepts --repo and
--output; run it through scripts/dev-shell.sh with the exact pinned Node binary.
Its candidate executes the selected repository's normal generated core, the
actual portable Connection/Statement/Image owners and exact existing SQLite3.54
object via a tiny N-API fixture. It never delegates candidate SQL/image behavior
to native node:sqlite. Native V8/N-API, util brands, encoding, worker clone marks,
VM/common/test and node:test are explicit fixture dependencies. Empty constants
are an unused fixture input for this selected surface, not a production claim.

The final candidate and native reference agree across 14 groups (including real
read-transaction SQLITE_BUSY, schema failure and post-error usability). All 21
cases in unchanged test/parallel/test-sqlite-serialize.js pass in both subjects.
Eight portable controls exercise real allocator fault/free/realloc tracking,
statement retirement, writable growth, attached schemas, repeated import,
callback rejection, reentrant window-finalizer statement creation and balanced
SQLite requested-allocation bookkeeping after shutdown. This accounting is not
RSS. Initial control and source-fixture failures remain nonpasses in the capsule.

No guest JSAPI translation unit, engine, kernel, product or overall suite was
compiled by this slice. The new native bridge's realm/security/GC/OOM behavior
and guest SQLite/VFS/allocator behavior need compilation and four-host runtime
validation. SQLite internal heap allocations are not newly integrated into the
process retained-memory ledger. Real authorizer admission remains a prerequisite
if that currently missing public feature is implemented; serialize's authorizer
prohibition must then be connected to its actual owner. Extensions/permission,
virtual tables, tag-store, remaining binding/callback/transaction/lifecycle and
other SQLite gaps remain open. No finding or module is closed by these checks.

Current root242integration preserves FD241bootstrap/0174 and uses actual current-parent normal generator. Native-dependent evidence and the new guest bridge remain distinct. V1 binding limits two SDK++ paths and36historical private Git administrative members; complete external before/after guards remain required. All prior failures and compilation uncertainty persist.
