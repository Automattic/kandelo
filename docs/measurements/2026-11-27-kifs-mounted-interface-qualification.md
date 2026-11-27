# Mounted filesystem qualification

KIFS v3 took less elapsed time than v2 in all 80 saved-shell comparisons.
The 0.75× stretch target held in 71 of 80 comparisons and in every
order and repeat for 12 of 20 host-operation pairs.

Each round opened fresh saved computers on Node, Chromium, Firefox and WebKit.
Each host ran once with v2 first and once with v3 first. The entries in the
table are the largest ratios of median guest elapsed times across the two
rounds and both orders. Each median uses three samples. The operations create
files, look them up in random order, write and sync a stream, verify the
stream on read, and delete the files. The permission tests ran after timing
on each filesystem. An unprivileged guest could create and remove a file in
a writable directory. The guarded file and directory denied read, create
through either path, and unlink.

| Host | Create | Random stat | Write and sync | Verified read | Delete |
| --- | ---: | ---: | ---: | ---: | ---: |
| Node | 0.068× | 0.548× | 0.217× | 0.792× | 0.060× |
| Chromium | 0.279× | 0.960× | 0.550× | 0.702× | 0.254× |
| Firefox | 0.757× | 0.928× | 0.781× | 0.884× | 0.698× |
| WebKit | 0.903× | 0.550× | 0.405× | 0.521× | 0.808× |

The preceding packaged kernel ran the same workloads with the current host
and both filesystem orders. For each backend and host, every operation met
or beat its preceding median in at least one order or repeat. For example,
the largest rollout ratio came from Chromium random stat in the first
v3-first run. The v3 median was 48.52 ms in that run, 25.91 ms on the repeat
and 30.52 ms with the preceding kernel in the same order.

## Capacity and recovery

The v2 control reported 512 MiB and 65,536 file entries. The upgraded
development shell reported 1 GiB with a shared logical budget for metadata
and file data. The packaged Bash, coreutils and Git shell started from a
2.42 MiB staged v3 volume. On each host it created 12,000 one-byte files
and still reported 972.3 MiB free. All hosts used 27 kernel Wasm pages
at boot (1.69 MiB) and 163 after the workload (10.19 MiB). These counts
measure kernel linear memory. The host storage metadata tracker peaked
at 3 KiB. Restart and snapshot reopen verified the saved files.

The focused guest and fault-injection checks passed on Node and all three
browsers. They exercise open file and directory identities across rename
and unlink, inode metadata and recovery, logical exhaustion and reclamation,
quota failure and retry, and seven interrupted-upgrade points including
generation activation. The 303 native rootfs tests and the 15 host scratch
and stat-lease tests passed. The full Rust workspace suite excluding xtask
passed 4,716 cases, with two ignored. The exact kernel package passed the ABI
snapshot check and the existing guest program baseline.

## Rollout

The Kandelo app now asks the shared boot protocol for KIFS v3 by default
when it opens a checked resizable development shell. The normal app test
installed a fresh shell, upgraded a used legacy computer, and reopened the
activated volume after requesting the legacy profile. It checked file
contents, unchanged inode numbers and hard-link metadata, the 1 GiB
geometry, and confirmed journal retirement. The test passed on Chromium,
Firefox and WebKit with the pinned kernel bytes.

Other app computers can request an upgrade explicitly. The development
shell can stay on its existing legacy filesystem with
`experimentalKifsV3=0` until it upgrades. Once activation succeeds, the
saved generation selects the format at every boot.

## Build inputs and scope

The kernel came from the package recipe in
`packages/registry/kernel/build-kernel.sh`. Its SHA-256 was
`5b34933882de6f5cd513fb89cac9d02b6b65cd679551dd1c1e14a4ea82be35da`.
Node used the freshly built host worker. The browser tests used the Vite
browser worker, the pinned kernel, and the partial package shell under the
SourceOnly resolver. The timing runs used fresh test-owned storage and
executed in series. The manifest, run orders, guest samples, memory
measurements and exact stretch misses are in the raw evidence.
[Raw qualification evidence](2026-11-27-kifs-mounted-interface-qualification.json)

The initial app test intercepted network requests for the kernel. Some
requests reached the service worker without reaching that route. The
passing fixture pins the packaged bytes at the app's kernel fetch and
counts deliveries across install, upgrade and restart.

This checkout had no built SpiderMonkey guest Node/npm artifact. The
workloads exercised packaged guest filesystem operations. The pinned
next-starter install and physical power-loss tests remain unmeasured.
