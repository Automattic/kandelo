# KIFS guest watch qualification after the develop merge

The reconciled kernel uses the mounted VFS for both saved formats. Directory
watches use inode identities, so a write can notify the correct names after
a directory rename or through another hard link. Watchers on the same
positioned directory share an alias index. It loads on the first write,
updates on successful namespace changes, and shares a 2 MiB budget with
resident directory indexes. The kernel reuses committed inode identities
for create, rename and removal notifications.

## Saved-shell comparisons

Two independent rounds on Node 24.22.1, Chromium 153, Firefox 155 and
WebKit 26.6 used both filesystem orders. Each pair seeded separate
computers and verified Bash execution, permissions, directory watch events,
and saved inode identities before and after explicit activation. The clocks
exclude fixture seeding and watch registration. The watched times include
reading and checking each event. Each pair used three samples per mode.

KIFS v3 beat v2 in 63 of 80 ordinary I/O comparisons and 17 of 48
watcher comparisons. It met the 0.75× stretch target in 53 and 13 of those
comparisons, respectively. Watched namespace churn was faster in 14 of
16 pairs. The table shows the largest v3/v2 median elapsed-time ratio across
the four pairs on each host. A ratio above 1 means v3 took longer.

| Host | First watched write | 512 writes with a watch | 128 create/write/rename/unlink sequences with a watch |
| --- | ---: | ---: | ---: |
| Node | 4.03× | 1.75× | 0.22× |
| Chromium | 2.29× | 2.65× | 0.43× |
| Firefox | 2.35× | 4.88× | 1.27× |
| WebKit | 3.29× | 1.53× | 1.10× |

The highest first-write v3 median was 1.65 ms. The repeated-write workload
opens existing files and grows their initially empty contents. It was also
as much as 4.36× slower on Firefox with the watch off. The timings therefore
include a difference in the underlying write path. Other local builds were
active during the runs. The raw samples preserve each pair’s elapsed times
and machine load. The current matrix falls short of the rollout requirement.
[Raw samples and input hashes](2026-11-27-kifs-develop-watchers.json)

On WebKit, a separate comparison against the earlier integration kernel
reduced v3’s median time for the 512 watched writes from 152.48 to 99.96 ms
in v2-first order and from 192.22 to 91.14 ms in v3-first order. Unwatched
times improved in the same runs. The timings reflect both kernels and the
machine load over the run.

## Capacity, correctness and artifacts

The timed kernel was built with the normal kernel package recipe from
`660c210bdb`. Its SHA-256 was
`f4fa247bbddebe995d6beea97d09be1597001c9cf3802461c97ab038d287dc6f`.
The guest fixture was rebuilt with the Kandelo SDK, fork instrumenter and
program ABI stamp check. Both formats used the same frozen partial package
shell built earlier in this checkout. The browser comparison fixture pinned
the kernel and served the saved image’s matching Coreutils bytes directly
after the current Vite resolver rejected stale packaged artifacts. Rust
still checked the length and digest declared by the image. These runs
qualify the saved-shell path with those inputs. The exact fresh app package
is a separate qualification.

The v2 control had 512 MiB and 65,536 file entries. The upgraded v3 shell
reported 1 GiB and a shared logical budget for data and metadata. Kernel
Wasm memory at boot was 32 pages (2.00 MiB) for v2 and 27 pages (1.69 MiB)
for v3 in every timed pair. A separate Node run started with 2.42 MiB of
physical v3 storage, created 12,000 one-byte files, and retained 972.3 MiB
of logical free space. Kernel memory grew to 163 pages (10.19 MiB), the
host transport metadata tracker peaked at 3 KiB, and the saved volume and
its exported snapshot reopened successfully.

The native runtime suite passed 4,156 tests after the merge. The final
watcher changes passed all 307 rootfs tests, including two observers,
hard links, and same-inode rename. The packaged kernel matched the generated
ABI snapshot and passed the program ABI 56 baseline check. The exact
kernel passed Node and browser guest identity and interrupted-upgrade checks,
including quota refusal and retry. The host passed 14 scratch and stat-lease
checks and 19 grouped-memory tests against the exact kernel.

The Rust-first host boundary check flags the two length words added to the
existing `host_fetch_deferred` import. The host uses the filesystem’s
declared resource length for bounded byte transport. Rust retains
verification and filesystem decisions. Adapter version 42 requires a
matching kernel and host. The change needs maintainer review.
[ABI notes](../abi-versioning.md#positioned-root-filesystem)

The saved format still selects the backend at boot. The web app displays
that format and leaves upgrades to the explicit shared host API. Physical
power loss and the pinned guest Node/npm install remain outside this
qualification.
