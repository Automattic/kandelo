# Asynchronous SQLite backup integration

Source175 connects the unchanged pinned public SQLite module to a real
sqlite3_backup owner and fresh per-batch native work. This is a partial SQLite
implementation contribution, not full native-integration compatibility.

The public frontend checks a genuine private database owner before pathname
or options getters, snapshots raw pathname bytes, reads the URL href once,
uses the real requested URI/schema/rate and rechecks source state after getters.
The public function has genuine callable/constructible name/length/prototype
behavior. Explicit undefined options retain the pinned distinction from omission.

The portable owner captures a shared actual source connection, destination,
name buffers and SQLite backup pointer. Real total/remaining pages and SQLite
status govern progress and completion. Open/init/finish/close belong to the
creating thread; only sqlite3_backup_step executes on a worker. Actual BUSY/
LOCKED/errors are retained. Source close_v2 permits a real zombie connection
until backup finish; source callback graph roots survive that interval.

Each batch owns public/native source roots, progress callback and its actual
Promise. A fresh job is allocated/rooted before moving state into the queue;
the queue retires each completed job. Allocator/deallocator pairing, rollback
and destruction order keep native cleanup before root retirement. Progress
uses the actual Promise realm and null receiver; the original thrown value
rejects only after cleanup. Requested-capacity accounting measures real owner/
name/job storage, not SQLite internals, allocator overhead or fabricated RSS.

## Backend identity and focused evidence

The engine already resolves node-sqlite with exact Node26.13.0 SQLite3.54.0.
The separate generic SQLite3.49.1 recipe mentioned in the original audit is
not this engine dependency. No target or library pin was changed by this slice.
The actual production owner checks sqlite3_threadsafe and the source mutex;
missing serialization is an unmet prerequisite, not compatible unsupportedness.

One fresh tiny native helper compiles the unchanged sealed control/owner
against current portable headers and the identified existing SQLite3.54object
(db90a8247caef56d39d129ae628f712a6b517cfdabfcb07ffff35d89f64b778d).
Eleven current real native owner cases pass: threaded page work, progress,
source changes/zombie finalization, schemas/errors/cleanup and allocation
accounting. Five actual allocation failures and four later successful positions
remain separate. Source UDF finalization occurs on its actual owner thread.

Thirteen current public frontend comparison groups match exact native Node
SQLite with only generated per-run directory prefixes normalized. The candidate
frontend delegates to native SQLite explicitly; this does not execute its new
production JSAPI queue. Fourteen package contract checks,791input closure,
normal current bootstrap/unity generation and unchanged Mozilla checker pass.
Three earlier tiny private helper compiles plus this one fresh compile are
accounted; no SQLite library, engine, kernel or product build occurred.

## Preserved failures and remaining scope

The first private public comparison exposed real constructor metadata drift;
the final named function fixes it. Initial source-fixture path mismatch remains
preserved. The isolated plain-object native sourceDb probe still crashes with
SIGBUS(-10). That is an unresolved reference nonpass, not a pass, accepted
platform boundary or established upstream defect. The candidate safely rejects
an unbranded owner; exact error equivalence to a crashing reference is unknown.

Production175JSAPI compilation and Promise/GC/realm/error reentry, multi-job
queue cancellation/termination, guest SQLite mutex/VFS/file-lock behavior and
all four hosts remain unvalidated. Dedicated contention/external-connection
restart controls and SQLite internal allocator accounting remain open.
All other SQLite/FFI/WASI/addon/embedding obligations remain separate. The
accepted173artifact predates174VM and175backup. No overall suites or full
product rebuilds ran. See [ledger](sqlite-backup-finding-progress.json).
