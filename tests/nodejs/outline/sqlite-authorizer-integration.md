# SQLite authorizer callback ownership

Source259 connects actual sqlite3_set_authorizer to existing Connection/Statement/Session ownership, traced database callback registry and post-SQL exception_ptr/abrupt handoff. Separate limits correction permits real readonly cached limit access and guards actual mutations before value validation. Normal910inputs/19sourcechecks/8commands pass, correctedportable8/nativeLimit3/frontend12native+12candidate selected observations and package14 independent. Native backend/error/Values/parameter-free SQL dependencies do not execute new guest JSAPI bridge. Two historical helpers count once363 to365; zero root compiler, no engine patch/full SQLite or guest closure.

Actual authorizer callbacks retain registry through Connection while registry keeps a weak native Connection edge. Database trace owns JS callback edges; child handles retain database, foreground teardown retires callbacks. exception_ptr catches exceptions inside SQLite C trampoline and rethrows after SQL returns. Private abrupt marker preserves pending original exception or uncatchable false without manufacturing SQLITE_AUTH. These new guest mechanisms remain source-only.

ROOT-SQLITE-AUTH-001 was a real readonly-limit overrestriction. The separate correction permits live cached limit reads and guards Assign/SetLimit mutations before validation. Original passing portable read-reject assertion establishes old candidate behavior only, not target agreement; corrected regression retains ten actual blocked mutations and adds real read/unchanged-value assertions.

Native11/12 negative-zero expectation, author syntax failure and old source bytes stay immutable. Corrected portable8/native3phase and frontend12+12 are explicit native SQLite/error/Values/parameter-free SQL dependencies, not new guest callback/realm/GC/fatal/uncatchable execution. No unchanged authz file run is claimed. LoadExtension remains unavailable and its permission-before-authorization target order is not established by initial guard work; deserialize general InCallback matches target and is unchanged.

Completed selected V1 binding/imports/actual receipts are retained. Two historical successful tiny helper attempts counted once363 to365 lower bound; four unknown subjects/history, ledger178/unlinked208/all19partial, reconciled mainb764 and stale accepted239 retained.

- New guest JSAPI callback/root/realm/GC/worker/fatal/OOM/interruption behavior uncompiled/unexecuted; native frontend fixture uses actual pinned Node SQLite callback/error backend
- Portable test proves exact header/backend ownership; native frontend dependency checks do not execute new native callback result/error/abrupt bridge
- Tag stores/extensions/virtual tables/modules and other SQLite gaps remain unavailable or partial; authorizer initial guard is not implementation of those features
- Existing generic SQLite receiver/cross-realm admission and full callback/Statement parameter/iterator/backup boundaries not claimed closed
- Unchanged upstream authz file examined/pinned but not executed; no whole-file, overall or four-host support claim
- Preserve pinned deserialize general InCallback policy. LoadExtension permission flags precede authorizer in target, while extension owner stays unavailable; initial guards do not implement it.
