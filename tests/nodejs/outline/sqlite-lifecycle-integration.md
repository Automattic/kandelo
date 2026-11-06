# SQLite statement lifecycle integration

Source154 adds actual Statement.close and idempotent Symbol.dispose over the
existing native statement owner. Active execution/binding phases reject a close
of that statement while unrelated statements remain closable. Native pointer
retirement precedes sqlite3_finalize, so reentrant finalizers cannot finalize
the same VM twice. Database close drains observer batches safely across native
callbacks, including statements they create. JSAPI close/finalize paths preserve
pending JavaScript exceptions instead of reporting success with one pending.

All10 nongenerated source images match the sealed reviewed proposal. The bundle
was regenerated over current CJS hooks, preserving that separate implementation.
Current bundle/input/bootstrap checks cover718 inputs;14 package-source tests
pass. Twelve fresh native/frontend comparison groups match. The whole unchanged
upstream Statement file was rerun for six close/dispose tests in two suites on
both subjects: pass6/fail0/skip0. The other89 test and20 suite declarations were
filtered and unrun, rather than counted as passes.

Actual C++ owner/helper evidence is reused by exact current header/test and
binary identity. Its raw SQLite finalizer stress differs from public Node window
aggregate cleanup: Node and Kandelo JS owners skip the result callback there.
The raw pointer-retirement/vector-drain assertions are portable owner evidence,
not matching public callback behavior. This distinction and all earlier failed
fixture/descriptor/reset/combined-comparison attempts remain preserved.

Native SQLite/VM/encoding/process and the prepare-only exact-SQLite metadata
helper are explicit frontend test dependencies. Neither the helper nor these
checks execute Kandelo's JSAPI, GC, VFS or current four-host guest runtime. No
new compilation/product setup/overall suite ran. Database disposal suppression,
serialization, authorizer/busy/trace/virtual-table callbacks, complete method
semantics, backup/extensions and accounting remain open. No NI-002/API/family
closure or new engine/platform boundary follows.

Exact evidence: [sqlite-lifecycle-finding-progress.json](sqlite-lifecycle-finding-progress.json).
