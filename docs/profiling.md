# Profiling and Benchmarking

This document covers Kandelo's performance measurement tools: a runtime syscall profiler for detailed per-syscall analysis, and a benchmark suite for repeatable cross-host comparisons.

## Syscall Profiler

The host runtime includes a built-in syscall profiler that measures every syscall handled by the kernel worker. It is zero-cost when disabled — no data structures are allocated and no timing code runs.

### Enabling

Set the `WASM_POSIX_PROFILE` environment variable before starting the kernel:

```bash
WASM_POSIX_PROFILE=1 npx tsx examples/run-example.ts hello
```

### Collecting Results

The profiler accumulates data in memory. Call `dumpProfile()` on the kernel worker instance to print results to stderr:

```typescript
import { KernelWorker } from "wasm-posix-kernel/host";

const kernel = new KernelWorker(/* ... */);
// ... run workload ...
kernel.dumpProfile();
```

A common pattern is to dump on SIGINT so you can interrupt a long-running program:

```typescript
process.on("SIGINT", () => {
  kernel.dumpProfile();
  process.exit();
});
```

### Output Format

```
=== Syscall Profile ===
Syscall       Count     Time(ms)    Avg(ms)    Retries
----------------------------------------------------
4                50        12.34      0.247          0
3                30         8.21      0.274          5
63               20         3.45      0.173          2
----------------------------------------------------
TOTAL           100        23.00      0.230          7
Pending pipe readers: 0, writers: 0
=== End Profile ===
```

Columns:

| Column | Meaning |
|--------|---------|
| **Syscall** | Linux syscall number (e.g., 3 = read, 4 = write, 63 = pread64). See `crates/shared/src/syscall_number.rs` for the full mapping. |
| **Count** | Total number of times this syscall was invoked. |
| **Time(ms)** | Cumulative wall-clock time spent handling this syscall, including kernel Wasm execution and host I/O. |
| **Avg(ms)** | Average time per call (`Time / Count`). |
| **Retries** | Number of times a blocking syscall (read/write on pipes/sockets, accept) returned EAGAIN and was re-queued for retry. High retry counts indicate contention or slow producers/consumers. |

Results are sorted by total time (highest first), so the most expensive syscalls appear at the top.

The footer shows pending pipe reader/writer counts — non-zero values at shutdown may indicate leaked pipes or unfinished I/O.

### Limitations

- Only available in Node.js (relies on `process.env`).
- Measures host-side wall-clock time, which includes both kernel Wasm execution and any host I/O (filesystem, network). It does not isolate kernel computation from host latency.
- Retry counts track how often a syscall was re-queued due to EAGAIN, not the total number of underlying host retries.

## Benchmark Suite

The benchmark suite runs reproducible workloads on both Node.js and browser hosts, producing JSON results that can be compared across runs.

### Prerequisites

Build the kernel and benchmark programs:

```bash
bash build.sh
scripts/build-programs.sh
```

Some suites require additional binaries:

| Suite | Requires |
|-------|----------|
| `syscall-io` | Base sysroot + benchmark programs |
| `process-lifecycle` | Base sysroot + benchmark programs |
| `erlang-ring` | Pre-built Erlang binary |
| `wordpress` | Pre-built PHP, nginx, WordPress |
| `mariadb` | Pre-built MariaDB |

Suites skip gracefully if their binaries are not found.

### Running Benchmarks

```bash
# All suites on Node.js (3 rounds each, reports median)
npx tsx benchmarks/run.ts

# All suites in the browser (via Playwright)
npx tsx benchmarks/run.ts --host=browser

# Single suite
npx tsx benchmarks/run.ts --suite=syscall-io

# More rounds for stability
npx tsx benchmarks/run.ts --rounds=5

# Combine options
npx tsx benchmarks/run.ts --host=browser --suite=process-lifecycle --rounds=5
```

Results are saved as JSON in `benchmarks/results/`.

### Available Suites

#### syscall-io

Measures raw I/O throughput and syscall round-trip overhead.

| Metric | Unit | What it measures |
|--------|------|------------------|
| `pipe_mbps` | MB/s | Write 1 MB through a pipe (fork + read/write loop) |
| `file_write_mbps` | MB/s | Write 1 MB to a file |
| `file_read_mbps` | MB/s | Read 1 MB from a file |
| `syscall_latency_us` | microseconds | Average `getpid()` round-trip over 1000 calls |

#### process-lifecycle

Measures process management primitives.

| Metric | Unit | What it measures |
|--------|------|------------------|
| `hello_start_ms` | ms | Cold start: load Wasm + run hello world to exit |
| `fork_ms` | ms | Fork a child + wait for it to exit |
| `exec_ms` | ms | Exec a new program |
| `clone_ms` | ms | Create a thread via clone |

#### erlang-ring

Runs the Erlang/OTP BEAM VM, spawning 1000 lightweight processes in a ring topology and passing a token around 100 times.

| Metric | Unit | What it measures |
|--------|------|------------------|
| `total_ms` | ms | Wall-clock time for full ring completion |
| `messages_per_sec` | msg/s | Total messages (100,000) / elapsed seconds |

**Prerequisites:**

| Component | Path | Build command |
|-----------|------|---------------|
| BEAM VM | `examples/libs/erlang/bin/beam.wasm` | `bash examples/libs/erlang/build-erlang.sh` |
| OTP libraries | `examples/libs/erlang/erlang-install/` | (built by same script) |
| Ring program | `examples/erlang/ring.beam` | (included in repo) |

Build requirements: host Erlang/OTP 28 (`brew install erlang`), `wasm32posix-cc` SDK (`cd sdk && npm link`).

#### wordpress

Runs PHP 8.4 with a full WordPress 6.7 installation. Two measurements: cold CLI load time and HTTP server first-response time.

| Metric | Unit | What it measures |
|--------|------|------------------|
| `cli_require_ms` | ms | `php -r "require 'wp-load.php'"` — process start to exit |
| `http_first_response_ms` | ms | Start PHP built-in server, time to first HTTP response |

**Prerequisites:**

| Component | Path | Build command |
|-----------|------|---------------|
| PHP CLI | `examples/libs/php/php-src/sapi/cli/php` | `bash examples/libs/php/build-php.sh` |
| WordPress | `examples/wordpress/wordpress/wp-settings.php` | See below |
| Router script | `examples/wordpress/router.php` | (included in repo) |

Build requirements: `wasm32posix-cc` SDK. The PHP build script automatically builds dependencies (SQLite, zlib, OpenSSL, libxml2). WordPress must be downloaded separately into `examples/wordpress/wordpress/`.

#### mariadb

Runs MariaDB 10.5 with the Aria or InnoDB storage engine. Measures bootstrap (system table creation) and a sequence of SQL operations.

Four suite variants are registered so wasm32 and wasm64 builds can be compared side-by-side in one `run.ts` invocation:

| Suite | Engine | Wasm ABI | Install dir |
|-------|--------|----------|-------------|
| `mariadb-aria`     | Aria   | wasm32 (ILP32) | `mariadb-install/` |
| `mariadb-aria-64`  | Aria   | wasm64 (LP64)  | `mariadb-install-64/` |
| `mariadb-innodb`   | InnoDB | wasm32 (ILP32) | `mariadb-install/` |
| `mariadb-innodb-64`| InnoDB | wasm64 (LP64)  | `mariadb-install-64/` |

| Metric | Unit | What it measures |
|--------|------|------------------|
| `bootstrap_ms` | ms | System table initialization (`--bootstrap` mode) |
| `query_create_ms` | ms | CREATE TABLE (2 tables) |
| `query_insert_ms` | ms | Batch INSERT (100 rows into each table) |
| `query_select_ms` | ms | SELECT with WHERE clause |
| `query_join_ms` | ms | JOIN across two tables |

Set `MARIADB_BENCH_VERBOSE=1` to forward mariadbd stdout/stderr to the shell (useful for debugging hangs or slow bootstraps).

**Prerequisites:**

| Component | Path | Build command |
|-----------|------|---------------|
| MariaDB server (wasm32) | `examples/libs/mariadb/mariadb-install/bin/mariadbd`    | `bash examples/libs/mariadb/build-mariadb.sh` |
| MariaDB server (wasm64) | `examples/libs/mariadb/mariadb-install-64/bin/mariadbd` | `bash examples/libs/mariadb/build-mariadb.sh --wasm64` |
| mysqltest client        | `<install-dir>/bin/mysqltest.wasm` | (built by same script) |
| System table SQL        | `<install-dir>/share/mysql/mysql_system_tables*.sql` | (built by same script) |

Build requirements: `cmake` (`brew install cmake`), `wasm32posix-cc` / `wasm64posix-cc` SDK. The build is a two-phase cross-compilation (host build for code generators, then wasm cross-compile). The wasm64 build uses `-O1` instead of `-O2` to avoid an LLVM 21 wasm64 backend miscompilation in table-lookup sign-extension.

### Building All Suite Prerequisites

To run the complete benchmark suite, build all prerequisites in order:

```bash
# 1. SDK toolchain (required by all application suites)
cd sdk && npm link && cd ..

# 2. Base benchmark programs (syscall-io, process-lifecycle)
scripts/build-programs.sh

# 3. Erlang/OTP (requires: brew install erlang)
bash examples/libs/erlang/build-erlang.sh

# 4. PHP + WordPress (PHP build includes SQLite, zlib, OpenSSL, libxml2)
bash examples/libs/php/build-php.sh
# Download WordPress into examples/wordpress/wordpress/

# 5. MariaDB (requires: brew install cmake)
bash examples/libs/mariadb/build-mariadb.sh          # wasm32
bash examples/libs/mariadb/build-mariadb.sh --wasm64 # wasm64 (optional, for dual-arch comparison)
```

### Running the Complete Suite for Performance Work

When measuring the performance impact of kernel changes, **run all 5 suites on both hosts**. Application-level suites (erlang-ring, wordpress, mariadb) exercise different syscall patterns and threading models that micro-benchmarks miss.

```bash
# Full comparison workflow:
# 1. Run baseline on both hosts
npx tsx benchmarks/run.ts --rounds=3
npx tsx benchmarks/run.ts --host=browser --rounds=3

# 2. Apply changes

# 3. Run again on both hosts
npx tsx benchmarks/run.ts --rounds=3
npx tsx benchmarks/run.ts --host=browser --rounds=3

# 4. Compare
npx tsx benchmarks/compare.ts benchmarks/results/<before>.json benchmarks/results/<after>.json
```

Suites that cannot find their binaries will skip gracefully and report no metrics. If a suite skips, build its prerequisites (see above) before drawing conclusions about performance impact.

### Comparing Results

Use the comparison tool to diff two benchmark runs:

```bash
npx tsx benchmarks/compare.ts benchmarks/results/before.json benchmarks/results/after.json
```

Output is a markdown table with percentage change for each metric. Regressions (>5% worse) are bolded:

```
| Benchmark                      | Before | After | Change  |
|--------------------------------|--------|-------|---------|
| syscall-io/pipe_mbps           | 245.5  | 260.1 | +5.9%   |
| syscall-io/syscall_latency_us  | 12.3   | 15.1  | **+22.8%** |
| process-lifecycle/fork_ms      | 45.2   | 44.8  | -0.9%   |
```

For throughput metrics (`*_mbps`, `messages_per_sec`), a decrease is a regression. For latency/duration metrics, an increase is a regression.

### Writing a Custom Suite

Create a TypeScript file in `benchmarks/suites/` that exports a `BenchmarkSuite`:

```typescript
import type { BenchmarkSuite } from "../types.js";

const suite: BenchmarkSuite = {
  name: "my-suite",
  async run(): Promise<Record<string, number>> {
    // Run workload, return metric_name → value
    return { ops_per_sec: 1234.5 };
  },
};

export default suite;
```

Register it in `benchmarks/run.ts` by adding an entry to `SUITE_MODULES`:

```typescript
const SUITE_MODULES: Record<string, string> = {
  // ...existing suites...
  "my-suite": "./suites/my-suite.js",
};
```

Benchmark programs (C source) live in `benchmarks/programs/` and output metrics as `key=value` lines on stdout, which suites parse with a simple regex.
