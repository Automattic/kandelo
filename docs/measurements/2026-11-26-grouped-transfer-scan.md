# Grouped host buffer transfers, 2026-11-26

## Transfer contract

On develop `dffcfca5325666d5e02cacdef03d4f14893a4584`, the host checked the live binding and numeric range, asked Rust to validate every page, and then asked Rust for the authorized contiguous physical spans covering that same range. Both Rust exports inspect page rights. The byte copy starts only after the complete span list has been collected.

The span list now supplies the preflight for transfers. One successful nonempty transfer removes one Wasm call and its full-range page walk. The Rust span helper can inspect the first page of a later span while finding a boundary. Failure still asks Rust for the precise fault. An invalid range with a long valid prefix can therefore build a temporary prefix of the span list before rejection. The caller cannot copy from or write to those spans on failure. A rights-only check keeps its existing direct Rust inspection. No span list survives the operation.

## Browser Worker benchmark

The benchmark imported the production `GroupProcessAddressSpace` and used its real Wasm helper on a shared memory with eight virtual pages mapped to physical pages 4, 5, 8, 9, 12, 13, 14 and 15. Each virtual page held its 1-based index. Each round called `readBytes` at the same address and checked the sum of the first and last output bytes over the whole batch. Addresses below use 65,536-byte pages.

Four fresh module Workers ran in control, candidate, candidate, control order. Each ran six rounds per workload. The numbers below are median milliseconds per batch, excluding the first round of each Worker. Both used the same cumulative desktop source with only the transfer change varied.

| Address, length and repetitions | Firefox before → after | Playwright WebKit before → after | Chromium before → after |
| --- | ---: | ---: | ---: |
| 0, 4 bytes × 25,000 | 4.06 → 3.41 | 3.92 → 3.14 | 4.65 → 3.81 |
| 100, 320 bytes × 15,000 | 2.65 → 2.25 | 2.86 → 2.46 | 9.33 → 8.68 |
| 12 bytes before the third page, 32 bytes × 12,000 | 2.96 → 2.60 | 3.04 → 2.90 | 3.44 → 3.03 |
| Start of the second page, four pages × 90 | 2.40 → 2.44 | 1.23 → 1.02 | 2.47 → 2.47 |

## Desktop scope

The same partial Sway/SFWBar/Foot/shell image and kernel served both desktop arms (kernel SHA-256 `cbddc6fb8f3b452106f8d503f6497007d2906630ea52ef49e42a9846422b255f`). At 2634 × 1806, the test starts at the first trusted Alt+Return with one painted terminal, and stops when each expected tile shows the terminal background and prompt. This cumulative ABI 40 desktop and the isolated develop ABI 41 review branch have different host revisions.

The first paired four-launch run took 7.75 → 7.34 seconds in Firefox and 4.64 → 7.06 seconds in WebKit. In reverse order, the WebKit burst took 4.55 seconds on the candidate and 4.53 on the control. The Firefox candidate repeat started with one terminal and finished with six visible prompts after four shortcuts, so it missed the exact five-tile check. Its control took 8.77 seconds. One launch took 2.96 → 2.34 seconds in Firefox and 2.13 → 1.52 seconds in WebKit. Both candidate runs in each engine showed the final cursor at all eight requested destinations. Timings on this shared build machine varied. These results do not establish a desktop latency gain. An initial server setup failed to navigate in Firefox and WebKit, and a separate harness invocation rejected the expected kernel hash before boot. Those attempts supplied no timings.

## Validation

The clean develop-based change passed the host build, 38 focused process address-space and memory-view tests and the 1,430-test host memory suite. The new regression writes across three pages with two noncontiguous writable spans followed by a protected page. Both write and fill must leave the earlier bytes intact on failure, and retry must update all three pages after permission is granted. Kernel code, guest ABI, scanner bytes and the lifetime of native waits are unchanged.

On the pinned ABI 41 kernel, 54 of 55 real-kernel, Worker-boundary and public-session tests passed together. The public read-only-file bytes launch exceeded its 90-second deadline on the first run and passed in 7.0 seconds on an isolated retry with the same deadline. The SDK tests passed ordinary and grouped 256-thread churn, forty native-wait exit cohorts and forty fork cohorts with backing reuse. The public SDK and fork fixtures used their explicit read-only mprotect opt-in. Three rounds each of syscall I/O, process lifecycle and empty-filesystem spawn ran on Node and browser. Ordinary workloads moved in both directions on this shared host (Node file reads 35.16 → 28.61 MB/s, browser 71.05 → 74.60 MB/s). The MariaDB and WordPress application comparison is separate.

A native Safari 27.2 WebDriver session reported a running machine with one scanout flip at 2634 × 1806. The automation window reported hidden on a locked macOS session and the first terminal never met the pixel predicate. This supplies no foreground native Safari latency measurement. The WebKit numbers above use Playwright.

## Ordinary database and stdin workloads

Three rounds of the ordinary wasm32 and wasm64 MariaDB Aria and InnoDB suites and stdin throughput ran on Node and Chromium against pinned develop `dffcfca532`. The database table below shows the largest time increase and decrease on each host. Concurrent builds affected both arms. These workloads exercise ordinary processes, so the differences do not measure grouped desktop latency. [All 42 comparisons](2026-11-26-grouped-transfer-scan-ordinary-apps.csv).

| Host | Largest elapsed time decrease | Largest elapsed time increase |
| --- | --- | --- |
| Node | mariadb-aria-64/query_select_ms 632.18 → 237.92 ms (-62.4%) | mariadb-aria/query_join_ms 213.56 → 662.99 ms (+210.4%) |
| Chromium | mariadb-innodb/bootstrap_ms 3968.6 → 2274.58 ms (-42.7%) | mariadb-innodb-64/bootstrap_ms 2215.85 → 2635.98 ms (+19.0%) |

The full browser WordPress comparison remains unmeasured. Provisioning the standard WordPress image reached an unresolved `mprotect` symbol while linking its SpiderMonkey Node dependency. The browser benchmark needs that image.
