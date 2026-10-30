# ABI 54 persistence integration acceptance

## Scope

This records the persistence branch after integrating main `f6b329f4d`
(ABI 53). The combined kernel and rebuilt products use ABI 54. Runtime
source is `c0cb61f7e`; subsequent documentation and browser-test repairs
do not change those native artifacts. This is desktop acceptance evidence,
not a production release, physical-phone result or device power-loss test.

The normal `setup --all`, standalone guest-fixture and browser product
builds pass. The frozen application candidate is checkpoint 1.36. Site
and native-artifact audits pass after application validation. Private
receipts are under `.context/persistence-main-20261025/`.

Main subsequently advances to `cbce65bcc`, replacing the fork instrumenter.
Its integration and rebuilt-guest acceptance are not included in this
receipt; see the [current plan](../persistence-plan.md) for that next batch.

## Native and Node evidence

- Rust workspace excluding xtask: 3,630 passes, including 3,046
  runtime-core cases. xtask separately passes 795 cases. The positioned
  image-module feature separately passes 75 native unit cases.
- The 26-file Node cohort passes all 501 cases with no skips. It includes
  actual MariaDB mixed writes, fixed and resizable journals, compaction,
  strict recovery, logical capacity and bounded-memory pressure.
- Raw images above 32 GiB mount and recover under a 64 MiB kernel ceiling.
  Both checked-image policies read above the 32-bit offset boundary and
  recover guest tail writes under their separate 768 MiB kernel ceiling.
  These approximately 32 GiB containers are sparse host fixtures with less
  than 512 MiB allocated disk each, not incompressible 32 GiB payloads.
- Generic image composition preserves the exact input namespace. Only
  kernel boot adds runtime mount directories. Replacement-namespace tests
  still use their original admission limits and deadlines, accounting for
  those real directories within their original 512-inode fixture boundary.

## Application results

Checkpoint 1.36 passes six WordPress SQLite/MariaDB visual-editor,
post/upload and source-free recovery cases across Chromium, Firefox and
WebKit. Chromium crashes and relaunches its browser process; Firefox and
WebKit reload the page. No image checkpoint is used in those six cases.
All three shell checkpoint/reload cases and both constrained-profile
WebKit mixed workloads also pass, without retries or skips.

The default-profile mixed workload passes five of six cases. WebKit's
maintenance case verifies post/media after checkpoint and again after a
source-blocked reload, but its subsequent terminal never produces a prompt.
The captured OPFS files, trace and diagnostics are retained. A subsequent
audit finds the diagnostic helper ignored v6 manifest references and did
not capture the separate active journal namespace. This is not a complete
computer archive and cannot establish that journal's integrity. The helper
and its real-OPFS regression are corrected for the next native-main cohort.
This remains a release
failure, not proof that file data is corrupted or that an outside runtime
is defective.

Single-run MariaDB application-ready observations from the six UI cases:

| Engine | Initial installation | Recovery lifecycle and saved boot |
| --- | ---: | ---: |
| Chromium | 14.10 s | 7.37 s, browser-process crash and relaunch |
| Firefox | 15.41 s | 4.55 s, page reload |
| WebKit | 12.88 s | 4.23 s, page reload |

All recoveries make zero source-image requests. These are not alternating
baseline/candidate measurements or a claim of speedup over an older demo.
They include normal application startup, not just storage mount latency.

## Filesystem and conformance evidence

The current three-engine OPFS storage cohort passes 114 cases covering
creation, both checking policies, demand reads, metadata allowances,
pressure, streamed snapshots and strict reopen. Generation authority,
ownership and quota coverage passes 74 cases; four browser quota-protocol
cases are intentionally unsupported on Firefox/WebKit. Those skips are
not unexecuted cases after an early failure.

Strict persistent-reboot Sortix validation passes the same 70 selected
filesystem/FIFO cases under each checking policy, with no failures or
skips. The persistent POSIX fsync/munmap selection passes eight cases under
each policy, with the same two existing expected failures for Wasm page
revocation in each run. ABI freshness, the 623-file Vitest inventory, host
declarations and the final native-artifact audit pass afterward.
These are selected conformance cohorts, not the entire libc/POSIX suite.

The broad compaction cohort exposes two stale fixture assumptions. Its
8192-block case still verifies intact recovery, but a later recomputed
index/seal must be refused when independent activation controls no longer
match. The revised assertion requires refusal, an unchanged index digest
and unchanged bounded file inventory, not silent authority replacement.
The orphan fixture must also count the browser's actual TLS certificate
payload separately from its 8192 data blocks and one held orphan block.
Production recovery and compaction checks are unchanged. The full selected
three-engine recheck passes all 93 cases, without retries or skips. It
includes physical >4 GiB OPFS export/reboot, interrupted live compaction,
8192-block recovery, both orphan cases, snapshot-owner shutdown and
termination recovery. Source and native-artifact audits pass afterward.

## Liveness follow-up and remaining scope

A private bounded constructor/I/O observer does not reproduce the same
terminal failure. Its maintenance case instead reaches HTTP 502 after
checkpoint. The latest observed memory constructor completes and the
active kernel answers independent echo messages at the end. Earlier
transient constructor pressure does not establish the cause of that 502.
The same capture-helper limitation applies to this diagnostic archive.
Native stack sampling refuses to proceed because it cannot positively
identify a run-owned WebContent process; no stack is claimed. Probe unit,
private-source and frozen-artifact audits pass. This diagnostic failure
does not close the original application failure or justify changing budgets.

Remaining release work includes application-liveness attribution and repair,
repeated ownership turnover and the combined
memory/lifecycle release audit in the [plan](../persistence-plan.md#goal-completion-criteria).
The complete browser-memory regression gate and full libc/POSIX suites
are not run in this integration batch. The scoped browser typecheck still
reports two unchanged-main diagnostics in WebGL query casting and terminal
exit-policy narrowing; no clean whole-browser typecheck is claimed.
The [durability contract](../persistence-durability.md) retains browser quota,
eviction, sync acknowledgement and power-loss boundaries.
