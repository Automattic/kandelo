# ABI 55 persistence integration acceptance

## Scope

This records the persistence branch integrated with main `7dfe4b501`
(ABI 54). The combined contract and rebuilt products use ABI 55. Merge
commit `c85a3ceaa` preserves both histories. Checkpoint 1.38 is a frozen
production browser build of the combined runtime, not an older demo with
new source served alongside it. Documentation-only updates do not alter
those artifacts.

Subsequent host commit `67c95b4bf` preserves bounded-read failure details.
That diagnostic change is validated separately below; it is not retroactively
included in checkpoint 1.38. The Rust kernel and image modules remain
byte-identical. Normal browser preparation subsequently rebuilds the host
JavaScript and product projection before the later Node workload.

Checkpoint 1.39 is the final frozen production build, including those current
host diagnostics. Its normal build succeeds and all six shell/MariaDB cases
pass across Chromium, Firefox and WebKit, without retries, skips or failures.
Posts and uploaded media survive source-free restart without checkpointing;
the shell additionally exercises optional checkpoint recovery. Frozen-site,
kernel, image-module, lamp and host-bundle hashes pass afterward. Earlier
computers and frozen checkpoints remain unchanged. The infrastructure goal
is complete within the supported bounds below; the draft PR is not merged
and this record is not a native-phone or device power-loss certification.

Validation runs through `scripts/dev-shell.sh` on macOS 27.0.1 arm64.
Playwright uses Chromium 153.0.8010.12, Firefox 155.0 and WebKit 26.6.
The user preview and automated tests use separate origins. Saved user
computers, frozen older previews and current failure archives are preserved.
Private receipts are under `.context/persistence-main55-20261025/`.

This is current desktop evidence, not a production release, a measured
phone result, native Safari validation or a device power-loss guarantee.
The broader completed selections and their boundaries are recorded below.

## Build and native evidence

- Normal consumer `./run.sh setup`, production browser products and all
  fifteen required SDK guest fixtures build successfully. Full
  all-supported-package acceptance is not implied by consumer demand.
- Rust workspace excluding xtask: 3,722 passes, no failures or ignored
  cases. xtask: 795 unit cases and six integration cases pass.
- Real Wasm ABI regeneration, comparison against ABI-54 main, standalone
  resolver checks and all fifteen storage imports pass. Host declarations
  and the 631-file Vitest evidence inventory pass.
- Focused source-only host lifecycle: 53 passes. Source ownership audit:
  97 passes. Neither cohort substitutes for built-guest acceptance.
- Independent bounded read-only review finds no concrete corruption
  defect in native activation/recovery and their immediate host handoff.
  Its missing target-only acknowledgement scenario is now exercised by
  sixteen new cases using real native transactions. While predecessor
  retirement is pending, each case synchronizes a marker absent from the
  predecessor, injects owner loss, flush/close failure or concurrent stop,
  and verifies fresh recovery retains that marker in the new target.
  Flush-only and write-through storage models cover both unsealed-source
  and obsolete-sealed-generation retirement. All 26 cases in the complete
  crash-test file pass. The modeled disk is not an operating-system crash
  or a physical flush test.
- An initial xtask run made before ABI regeneration has 785 passes and
  ten failures. Its receipt is retained separately; the corrected passing
  run regenerates the snapshot before running xtask.

## Application acceptance

All eighteen application cases pass with one worker, zero retries, no
skips and no unexpected or flaky outcomes:

| Cohort | Cases | Covered behavior |
| --- | ---: | --- |
| WordPress SQLite/MariaDB | 6 | Visual editor, published post, media upload and source-free recovery in all three engines |
| Default-profile MariaDB mixed workload | 6 | Live and optional-checkpoint recovery in each engine |
| Constrained-profile WebKit | 2 | Both mixed recovery modes with the unchanged constrained profile |
| Shell | 3 | Guest-created state, checkpoint and reload in all three engines |
| WebKit turnover | 1 | One maintenance workload followed by eight source-blocked reloads, verifying application and guest state each time |

The mixed workload updates database content, retains one uploaded image,
deletes another, renames 512 directory entries and verifies 32 MiB of
distinct guest payload. Recovery verifies file contents, removed names,
database content and retained/deleted media. Each recovery rejects source
image requests and observes none. The editor cases do not use an explicit
image checkpoint. Chromium crashes and relaunches its browser process;
Firefox and WebKit reload the page. The mixed and shell cases use their
documented reload/checkpoint lifecycle, not a browser-process crash.

The prior ABI-54 WebKit initial-installation HTTP 502, post-maintenance
HTTP/terminal failure and eight-reload preparation timeout do not occur in
this cohort. The new passing artifacts do not identify the cause of those
historical failures, which remain recorded separately. No outside runtime
defect is inferred and no testcase retry or relaxed deadline clears them.

## Current timing observations

Single-run MariaDB editor-case timings, measured to the first WordPress
response rather than completion of every editor asset:

| Engine | Initial streamed installation | Saved-computer response, including named lifecycle |
| --- | ---: | ---: |
| Chromium | 13.58 s | 7.39 s, browser-process crash and relaunch |
| Firefox | 18.12 s | 5.02 s, page reload |
| WebKit | 15.68 s | 4.38 s, page reload |

The default-profile mixed workload observes these wall-clock intervals:

| Engine | Live source-blocked reload to application response | Checkpoint and reboot | Post-checkpoint source-blocked reload |
| --- | ---: | ---: | ---: |
| Chromium | 5.47 s | 37.44 s | 4.46 s |
| Firefox | 6.56 s | 35.79 s | 5.55 s |
| WebKit | 5.66 s | 16.95 s | 4.32 s |

The eight-reload WebKit case observes application response in
4.23–5.26 seconds and complete application/guest verification in
11.68–14.26 seconds per reload. These are a single desktop sequence, not
an alternating main-versus-candidate benchmark or a mobile performance
claim. Node fixture generation, conformance and another workspace's build
overlap portions of the application cohort. No broad speedup or regression
conclusion is justified by comparing these values with older receipts.

## Memory observations and boundaries

The six default mixed cases record fifteen filesystem admission reports;
the constrained and turnover cases record another fifteen. Every report
passes the existing admission assertions. The simultaneous Rust admitted
peak in the default reports ranges from 50,603,746 to 52,705,910 credits;
the constrained WebKit cases peak at 52,560,112 credits. These are
kernel-lifetime modeled admission credits, not allocator bytes, total
browser memory or mobile physical RAM. Historical peaks are not compared
against subsequently lowered limits.

One-second diagnostic process-tree sampling has no failed or truncated
samples in these three cohorts. Their peak summed descendant RSS is
6,873,168 KiB for the default mixed cohort, 1,175,952 KiB for the constrained
cohort and 1,199,136 KiB for turnover. These include harnesses and browser
processes, can double-count shared mappings and omit reparented platform
helpers. They are not a single-computer physical-memory ceiling. Rust
admission, separately bounded archive storage, host metadata credits,
manifest operations, composer/codec workers and caller-owned results remain
separate owners in the acceptance ledger.

The complete large-image Node cohort and repeated browser-memory regression
command now pass. The pressure cohort is included in the current Node and
three-engine storage runs below. Their modeled credits and kernel page
observations must not be represented as a bound on total browser RSS.

## Completed cohorts and retained failures

### Filesystem pressure and demand reads

Both checked policies run the same pressure guest against a 96 MiB cold file,
2,048 seeded long names, an 8 GiB sparse mapping and an 8 MiB synchronized
working set. The physical checked containers are 106,455,188 bytes (CRC32C)
and 106,500,244 bytes (SHA-256), larger than the 64 MiB kernel ceiling.
Namespace creation reaches explicit `ENOMEM`, then reclamation and retry
preserve accepted names. Original and streamed-snapshot recovery each verify
the namespace, sparse contents and written payload. Nine admission reports
per policy and host cover initialization, workload completion and export.

| Host | Rust aggregate peak credits | Namespace temporary peak | Host metadata peak | Kernel peak pages |
| --- | ---: | ---: | ---: | ---: |
| Node | 14,045,082 | 5,189,360 | 2,634,768 | 219 |
| Chromium | 14,041,438 | 5,185,696 | 2,634,768 | 220 |
| Firefox | 14,041,438 | 5,185,696 | 2,634,768 | 220 |
| WebKit | 14,041,438 | 5,185,696 | 2,634,768 | 220 |

Values are identical across the two policies for each host. These are current
ABI-55 observations, not copied ABI-51 results. There are 72 admission reports
in total. Pages are 64 KiB; credits are modeled ownership, not physical bytes.
Each browser's separate snapshot codec reaches 22 pages, with 64 KiB input,
caller chunk and backing peaks. Manifest, archive, producer and caller-result
owners retain their separate limits in the plan's memory ledger; they are
not silently included in the Rust aggregate or a whole-browser RAM promise.

Current demand-read cases install, mutate and synchronize each fixture, reset
the byte observer, then reopen the existing journal. Across all three engines,
a 512 KiB cold payload causes 331,904 immutable-base bytes to be read; a
32 MiB cold payload causes 921,728 bytes under CRC32C or 974,976 under SHA-256.
No guarded cold-payload range is touched, and no native request exceeds
64 KiB. The corresponding Node cases also pass. These are observed metadata
and verification reads, not zero-I/O reopen or a full-image integrity scrub.
The eighteen application cases separately require source-free recovery and
record actual first-response times above. Initial streamed installation is
not conflated with ordinary reopen.

### Runtime and fault cohorts

The first 31-file Node batch completes with 538 passes and two failures,
without skips. Both failures are diagnostic: whole-file inspection correctly
refuses its 1024-byte allowance with `ENOMEM`, but the integrated error
wrapper discards that explanation when adding the path and errno. The
shared host fix retains both. Twelve focused Node cases and six real-OPFS
cases pass afterward, preserving short reads, symlinks, explicit ranges,
executable loading and recovered writes under both checking policies. The
full cohort recheck remains separate from that initial failed receipt.

The final serialized 31-file Node cohort passes all 540 cases, without skips
or failures. Its fixture receipts verify all fifteen current SDK-built
artifacts before and after execution. The kernel, resident/positioned image
modules, lamp image and three host bundles retain their hashes. The final
source ownership audit passes all 97 cases, and ABI and evidence-inventory
checks pass. `node-final.json`, `source-audit-final.json` and
`final-frozen-after.log` record these successful results separately from the
earlier failed batches. Native positioned-image unit coverage passes 75 cases
with `cargo test --lib --features positioned-image`; a prior non-`--lib`
invocation cannot link the intended Wasm imports into a native cdylib.

The second full cohort has 539 passes and one preparation failure, without
skips. Its MariaDB case cannot begin because concurrent normal browser
preparation republishes the product projection while the consumer retains
the previous member-size metadata. The resolver refuses that mismatch rather
than mixing provenance tiers. The final checksum audit also detects the
expected host JavaScript rebuild: `npm run typecheck` checks declarations
only, whereas the memory gate's `npm run build` replaces those bundles. All
three native kernel/image-module hashes remain unchanged. These are retained
failed-batch receipts, not successful full-cohort acceptance.

After product preparation completes, a fresh Node process passes the real
MariaDB live workload with unchanged artifact hashes before and after. Its
compiled worker entries match the complete current host source/config/lock
fingerprint. Both persistent phases verify the published post, uploaded PNG,
four 8 MiB guest files and 64 small files. The ordinary source/configured
images are removed before reopen. No image checkpoint is used.

| Node operation | Wall-clock observation |
| --- | ---: |
| Decompress, configure and write checked base | 6.54 s |
| In-memory first WordPress response | 7.23 s |
| Persistent-install first response | 8.16 s |
| Persistent source-free reopen first response | 8.54 s |
| Guest 32 MiB write plus sync | 8.29 s |
| Initial guest verification | 7.46 s |
| Reopened guest verification | 8.52 s |

The checked base is 251,978,195 bytes. The kernel grows to 1731 pages after
installation and 1761 after reopen, under its 12288-page ceiling. Both
filesystem admission reports pass with a simultaneous high water of
50,668,589 credits. Verification includes guest SHA-256 and 64 small-file
reads; these intervals are not isolated disk bandwidth. The sequential
in-memory phase starts from image state rather than the later modified
database, so it is not a matched performance baseline.

The raw >32 GiB near-dense and dense cases pass in the first batch with
230 pages after initial mutation and 182 pages after recovery, under the
unchanged 1024-page (64 MiB) kernel ceiling. The two checked-image policies
pass high-word reads and tail overwrite/recovery with 229/182 pages, under
their separate 12288-page ceiling. Their container lengths are
34,445,738,140 bytes for CRC32C and 34,460,590,236 bytes for SHA-256. Each
uses less than 512 MiB of allocated host disk; neither is 32 GiB of
incompressible data. The checked-container file size, block allocation and
modification timestamps remain unchanged across the cohort.

The initial queued browser release batch fails before starting its memory
or runtime tests: normal Vitest preparation rebuilds twelve test fixtures,
so their bytes no longer match the earlier all-SDK-helper receipt. The
corrected receipt validates normal source/toolchain fingerprints for those
twelve and exact source/output hashes for three unchanged helper outputs.
All fifteen retain the current ABI. This is explicit provisioning repair,
not a weakened artifact check or a retry of executed browser failures.

The full persistent POSIX suite discovers 179 cases under each policy.
SHA-256 passes 174, with three existing expected failures and two explicitly
unsupported scheduling cases. CRC32C initially passes 173 and has one
preparation failure: source projection generation changes before
`sigwaitinfo/8-1` can execute. After preparation settles, all eight CRC32C
sigwaitinfo cases pass, including that case. No signal implementation is
changed. The initial failed cohort is retained. Strict persistent-reboot
Sortix validation passes 1,051 cases, with eight existing expected failures
and no failures, skips or timeouts across `basic`, `stdio`, `io` and `paths`.
The broader case-colliding include suite is not claimed. The conformance
wrapper still exits nonzero because it retains the CRC32C preparation failure
and compares two product images and three host bundles against its older
receipt. All three native artifacts match. The later frozen artifact audit
is green. The stable full CRC32C invocation passes 174 cases, with three
existing expected failures and two unsupported scheduling skips. Its frozen
artifact audit passes before and after execution. Both policies therefore
have successful complete POSIX selections in separate receipts; the earlier
failed wrapper is not rewritten as green.

The initial complete browser-memory command passes its 236 ownership host
cases, three Node teardown cases and seven Bun teardown/lifecycle cases.
Its browser stage has eight passes and one failure. Chromium and WebKit
complete all four same-realm application-switch cycles; Firefox stalls
before its first cycle finishes because the fixture waits for an Enable
toast click after activation removes that button. The trace records the
detached click target while the failed screenshot shows a running game.
The fixture now uses the production shell's trusted keyboard activation and
asserts the same running state, with unchanged deadlines, consumers, cycles
and realm checks. Six focused browser cases pass, including a negative
control that refuses a still-suspended sink. That regression is included in
the ordinary three-engine CI smoke list and complete memory command. The
repaired full memory command now passes all stages, including fifteen browser
cases with no skips, failures or flaky results. All three engines complete
four same-document/audio-realm application-switch cycles. Actual audio,
rendering, detached tmux servers and ownership assertions remain enabled;
there are no forced reloads, collections, teardown or autoplay bypasses.
`browser-memory-repaired.log` ends with the complete gate's success marker.

The current three-engine native-process/capture cohort passes all 63 cases.
The OPFS storage/pressure cohort passes all 114 cases, with no retries or
skips. Those storage cases cover both checking policies, bounded metadata
admission, demand-only reopen reads, streamed creation/snapshots, logical
capacity, sparse mappings, deferred transport and original/snapshot recovery.
Compaction passes all 90 selected cases, and the three separately selected
closed-orphan reclamation cases pass. Authority/quota passes 74 cases, with
four intentionally unsupported quota-manager protocol cases on Firefox and
WebKit. Archive overlap passes six. This totals 350 passing browser cases
and four explicit platform skips, without flaky results or runtime retries.
These successful cohorts do not relabel the original release wrapper's
initial memory failure and stale host-bundle audit as passing. The later
serialized memory/Node wrapper exits zero with current frozen hashes.

## Matched main/candidate benchmarks

All nine enabled suites complete on Node and Chromium, three rounds per suite,
in two counterbalanced passes per side/host: 216 suite-round executions. The
already-disabled Erlang suite remains excluded on both sides. Main is pinned
to `7dfe4b501` (ABI 54), not claimed to include subsequent upstream SDK work.
Each side uses its independently built SDK, kernel, programs, products and
compiled worker bundle. Candidate runtime hashes remain unchanged after all
eight complete CLI runs. First-pair Node results identify `cb7a25062`; the
remaining runs identify `3fe9e3c6e`, whose only executable changes are the
browser benchmark reader and its tests, not Node/runtime code.

Order is main/candidate on Node and candidate/main in browser, then reversed
for each host. Each complete pass has a fresh CLI process and browser launch;
three rounds and their workers within that pass share the parent process and
are not independent parent launches. Node is v24.15.0; both Chromium installs
report 153.0.8010.12. No other build or acceptance suite from this workspace
runs during timing. Recorded process snapshots still show desktop/browser
activity; these are local-machine comparisons, not isolated-device or mobile
results. Raw result JSON includes actual selected artifact hashes; all four
unmodified comparison tables and original failed attempts are retained.

| Host/metric | Main pass 1 | Candidate pass 1 | Main pass 2 | Candidate pass 2 |
| --- | ---: | ---: | ---: | ---: |
| Node hello total, ms | 322.62 | 2269.58 | 346.46 | 2333.12 |
| Node exec total, ms | 433.78 | 2365.52 | 454.30 | 2441.83 |
| Node WordPress CLI, ms | 593.02 | 594.59 | 604.03 | 602.49 |
| Node WordPress first response, ms | 3221.21 | 3678.12 | 3893.28 | 3934.23 |
| Node InnoDB bootstrap, ms | 2280.29 | 2422.74 | 2363.51 | 2437.02 |
| Node file-read microbenchmark, MB/s | 95.44 | 97.65 | 90.90 | 96.50 |
| Browser WordPress boot, ms | 8370.08 | 8444.69 | 8331.52 | 8448.78 |
| Browser WordPress first response, ms | 314.57 | 310.08 | 307.72 | 211.20 |
| Browser Aria bootstrap, ms | 1175.46 | 1152.87 | 1176.90 | 1149.48 |
| Browser wasm64 InnoDB bootstrap, ms | 1062.57 | 1089.12 | 1060.91 | 1073.65 |
| Browser many-file lock acquisition, us/op | 39.37 | 55.12 | 39.37 | 55.12 |

These standard suites measure the existing runtime paths, not isolated OPFS
bandwidth. The earlier persistent application/pressure cohorts separately
measure installation, source-free reopen, actual write/sync and maintenance.
No claim of broad speedup or performance neutrality follows from these tables.
The first Node WordPress response flag is +14.2%; reverse order yields +1.1%.
Other query/wait/lock flags vary between passes. Browser many-file acquisition
is consistently +40%, approximately two milliseconds per 127-operation batch;
that measured cost is retained, not waived as a passing no-regression check.

Separate clock diagnostics find a 5 us minimum positive `performance.now`
step in each cross-origin-isolated Chromium page, but a 1 ms minimum realtime
step. The file/lock C fixture uses `gettimeofday`, whose browser realtime
provider uses `Date.now`; its short batches are therefore quantized. Node's
outer timer minimum positive step is about 0.000041 ms. Percentages on short
browser batches are not precise per-operation latency estimates. Longer
monotonic-clock diagnostic workloads would be needed before attributing those
small flags to a syscall implementation or claiming they disappeared.

The large Node cold-start flag has concrete phase attribution rather than a
storage guess. In three separate observations, automatic rootfs resolution
spends 2.05–2.52 seconds regenerating/checking the development source program
index. Candidate default initialization takes 2.22–2.32 seconds; explicit-image
initialization takes 252–265 ms, versus 224–233 ms on main. Guest hello execution
is 89–97 ms versus 88–94 ms; destruction is 19–20 ms versus 5–6 ms. The new
canonical rootfs preference preserves provenance instead of accepting an older
alias. This is a real automatic source-checkout boot regression, not an OPFS
cache miss or evidence of a sevenfold guest-execution slowdown. Current
persistent computers use explicit installed images, bypassing that lookup;
their independent reopen/application observations remain the relevant evidence.
The resolver optimization is recorded in `docs/future-improvements.md` and
must not weaken freshness checks. This acceptance is a measured bounded
filesystem implementation, not a promise that every development benchmark
improves over main.

After comparison and clock/phase diagnostics finish, the temporary main
worktree is retired to reclaim its build outputs. Its harness-only patch,
source identities, artifact digests, raw results and successful pre-retirement
hash audit remain in the receipt directory. The serving demos, saved computers
and current candidate artifacts are preserved. No shared cache generation is
manually deleted.

## Requirement reconciliation

### Requirement audit

Both independent comparison checkouts now prepare all MariaDB architectures,
VFS images and ten SDK microbenchmark programs. Main's normal setup succeeds
after explicitly preparing its missing release `xtask`. Its initial benchmark
preflight refuses the missing unpacked WordPress tree before timing; the
documented local setup supplies it, with matching config/version/drop-in
hashes. The first complete Node pair passes all nine suites at three rounds.

The first candidate browser pass fails while compiling the MariaDB bootstrap
program. Its benchmark reader ignores a positive short read and returns an
otherwise zero-filled executable. The bridge deliberately limits each read
to 64 KiB; that limit is retained. The benchmark now completes bounded reads,
rejects premature EOF/invalid progress and closes on every exit path. The
same harness-only adjustment is applied to the pinned main checkout before
browser timing, without changing its runtime, SDK or ABI. This extraction
occurs before the timed bootstrap interval. Both architectures' complete
image executables match their actual ordinary-resolver build dependencies
and pass native WebAssembly validation in each checkout. A different normal
resolver tier can legitimately select another built variant; it is not used
as a substitute for the image's declared build dependency in that check.

The reader's twelve source-only cases and actual loaded-image regression
pass. The two-file image/helper selection totals 95 passes and one existing
opt-in 32 GiB fixture skip; it is not claimed as 96 passes. All current native,
lamp and host hashes remain unchanged. The evidence inventory now has 632
files. The initial browser failure is retained separately from the completed
browser and counterbalanced comparison runs described above. Matching Node
WordPress trees contain 3,972 measured files and 86,397,207 bytes, with identical
tree digests after excluding the declared runtime database/debug-log paths.

| Requirement | Implementation and current evidence | Boundary or remaining work |
| --- | --- | --- |
| Larger-than-memory images and ordinary imports | Native checked image reader/writer; current Node >32 GiB raw/checked cases and three-engine positioned installation/storage cohort pass. | Initial ordinary VFS import streams and can scan its input. This is not the demand-only reopen path. Large sparse host fixtures are not incompressible allocated disks. |
| Logical block/inode capacity and POSIX parity | Native rootfs/journal mutations; fixed-rootfs, statfs, inode-capacity, namespace-failure and persistent conformance tests exercise partial writes, mappings, namespace operations, metadata, open references and reclamation. Both checking policies pass 174 POSIX cases, with three existing expected failures and two unsupported scheduling cases each. | Existing unsupported platform APIs remain unsupported; persistence does not claim to implement all POSIX APIs. |
| Bounded filesystem memory | Native metadata, journal and shared I/O admission; host storage/manifest limits; 72 pressure reports, streamed original/snapshot recovery, 540-case Node cohort and full same-realm memory gate pass. | The plan's separate archive, codec, producer and caller owners are explicit. Admission credits are not exact allocator bytes or a whole-browser physical-memory ceiling. |
| Crash-safe journal compaction and base handoff | Rust activation, generation eligibility and recovery policy; 26 native-tail crash tests, 93 browser compaction cases and authority/quota cohorts pass. | Activated latest-state damage fails closed. An older valid generation alone cannot justify losing acknowledged state. Model cuts and process crashes are not device power-loss proof. |
| Fast installed-computer reopen | Native checked pages and bounded journal recovery; Node/three-engine demand-read cases, eighteen application cases and six final checkpoint cases pass without source requests. | No whole-base scan is needed on ordinary checked reopen, but metadata and requested pages still incur I/O. Matched comparisons and the separate source-checkout resolver cost are recorded above; no broad speedup or mobile claim. |
| Durability and lifecycle | `docs/persistence-durability.md`, native sync failure propagation, shutdown/close ownership, original/snapshot recovery and actual Chromium quota-manager cases. | Browser eviction, external trust, application transaction ordering and device flush guarantees are not supplied by this filesystem. Login cookies remain user-deferred. |
| Rust/host split and ABI | Rust controls formats, verification, namespace/cache/journal policy and recovery authority; hosts own positioned I/O, locks and asynchronous publication. ABI 55 snapshot/storage imports and 97-case ownership audit pass. | No stale-ABI guest shims or earlier browser saved-computer migration. Native journal/index admission is a separate format contract. |
| Release automation and workload comparison | 3,722 Rust workspace, 801 xtask, 75 positioned-module, 540 final Node, 350 browser storage/fault, eighteen application and six final checkpoint cases; complete memory command, both persistent POSIX policies, strict Sortix runtime selection and all nine enabled Node/Chromium benchmark suites complete. The added reader/image selection passes 95 with one existing opt-in fixture skip. | Earlier failed wrappers, four unsupported quota-protocol cases and prior ABI receipts remain distinct. This is the declared relevant acceptance selection, not every repository suite or a full supported-package build. |

The declared filesystem implementation and acceptance gates are complete.
Retained performance costs are not converted into a no-regression promise.
The supported durability contract remains conditional on host flush and
exclusive ownership, not browser eviction immunity or OS/device power loss.
Native Safari/iPhone testing, longer monotonic microbenchmarks and faster
development source-index regeneration remain follow-up work, not claimed
results. Unrelated signal/wake hardening and login-cookie continuity remain
outside this objective. Review and merging the draft PR are separate actions.
