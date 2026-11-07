# Actual SQLite status owner control

owner.cpp compiles the production sqlite-store.h and generated metadata
against the exact Node26.13.0 SQLite3.54 object and declared recipe defines.
Use scripts/dev-shell.sh and the include paths/defines from the immutable
owner capsule compile receipt. This is native libc/SQLite ownership
validation, not guest JSAPI or four-host conformance. It reads real
sqlite3_stmt_status values, never expected literal measurement counts.

The sealed capsule separately retains native-dependent frontend cases and
the whole unchanged test-sqlite-statement.js, filtered only to its two
stat/resetStats suites. Their exact source identity, filter,15tests/2suites
and native dependencies are recorded; no other upstream suite is claimed.
