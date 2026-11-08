# SQLite authorizer ownership

Database.setAuthorizer consumes a real sqlite3_set_authorizer registration on
its existing native Connection. The callback remains installed after close/open,
can be replaced/cleared, and actual SQLite invokes it during prepare/reprepare.
SQLITE_DENY and SQLITE_IGNORE retain real SQLite query semantics. Five arguments
are native action plus nullable UTF-8 names; no SQL is emulated.

The Connection scopes both callback and authorizer depth, catches C++ exceptions
before returning through SQLite, and restores/rethrows them outside its C frame.
The existing traced database callback registry holds the JS callable, with a weak
connection link and immutable creating context/thread. No JS root crosses to a
worker; backup steps operate on source B-tree pages, not compiled source SQL.
The callback bridge rejects entry from a different thread rather than touching
JSAPI there. Pinned source does not authorize SQL in backup_step; one actual
worker-backup control also observed no source-authorizer invocation.

Same-connection prepare/exec/registration/serialization/session/limit-mutation/defensive
and statement/iterator execution check authorizer depth. Busy statement close
remains prohibited, idle statement close and unrelated connections remain usable.
Close/deserialize retain their existing callback-depth policy. Metadata-only
operations, including real cached limit reads during authorization, retain their target admission, and drained iterators do not gain
a false SQLite operation. The existing tag-store and extension implementations
remain unavailable; their initial authorizer admission does not implement them.

JS callback failures preserve their original pending exception over SQLite AUTH.
Callback result validation is noncoercing semantic int32: negative zero is rejected
as in pinned V8 IsInt32, and only SQLITE_OK/DENY/IGNORE are accepted. Invalid type
and invalid integer produce uncoded TypeError/RangeError with pinned messages.

Evidence is scoped: the actual private portable Connection header is compiled
against a retained exact SQLite object; public frontend controls use native
Node SQLite/error/callback/stream dependencies. The new guest JSAPI registry,
error factory, context/realm/GC/OOM/cancellation/fatal/Worker behavior remains
uncompiled and unexecuted, and no four-host conformance is claimed. This is NI-002
partial implementation, not complete SQLite, extension/tag-store/virtual-table
support or a boundary excluding them.
