# Disk maintenance at source222

User-authorized cleanup removed only inactive/reconstructible private artifacts.
Current source, immutable audit evidence, accepted/executed binaries/libraries,
frozen fixtures/sysroots, pinned references and the separate Claude/npm/Bun
remainder remain. All2,212protected source identities match after cleanup.

| Removed scope | Size accounting | Recovery/protection |
| --- | ---: | --- |
| Old private UDP incremental cache,703files |1.022GiB logical | Compiler cache only; outputs/dependencies/fingerprints remain |
|59old expanded staging payloads,130,735regular files |3.438GiB logical;3.701GiB allocated estimate | Exact preserved archive bytes/modes;8,145directory skeletons retained |
| One clean inactive linked worktree |0.231GiB allocated estimate | Exact commit/tree pinned by non-branch Git ref; admin metadata saved |

This is about4.7GiB logical/copy volume, or5.0GiB using mixed allocation estimates.
It is not a measured physical5GiB delta: APFS and concurrent work affect free
space. The precise observation and result/report hashes are in
[disk-maintenance222.json](disk-maintenance222.json).

All73other private worktrees contain changes or extra files and were retained.
Shared cacheGC skipped its in-use lock; no cache/lock bypass occurred. Native
object files referenced by retained executable debug maps remain. Other native
object/metadata candidates were not admitted without complete consumer proof.

Old stage files were verified against immutable sourceSnapshot archives before
unlinking; every directory skeleton/mode remains. Historical source/style/native
verifier reruns need the exact indexed members restored to the original paths
first. Never extract whole old archives over current source. Restore indexes,
archive identities and instructions remain under
.context/node26-old-stage-retirement-audit222 and
.context/node26-old-stage-retirement-extension222. The clean worktree restores
with the command in its result; its exact Git objects and admin data remain.

No runtime test, compilation, overall suite or product rebuild was run for this
cleanup. Earlier source220administrative native freshness build is not counted
again. Compatibility remains incomplete and current four-host evidence is still
required; this maintenance establishes no API/family conformance.
