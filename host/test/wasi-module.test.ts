/**
 * End-to-end WASI Preview 1 behavior, through a real kernel.
 *
 * These run hand-written WASI `.wasm` guests through `CentralizedKernelWorker`
 * and assert what the guest observes: stdout, argv, i64 scalar fidelity, file
 * I/O and directory listing. Since K10 I6 the implementation under them is the
 * co-resident Rust `crates/wasi-module`, not a TypeScript shim, so this file
 * is the WIRING gate: it proves the module is built, shipped to the process
 * worker, placed in the guest's address space, instantiated, spliced into the
 * guest's `wasi_snapshot_preview1` namespace, and driving the real syscall
 * channel.
 *
 * What it does NOT cover, stated so the silence is not read as completeness:
 * `poll_oneoff`, the `sock_*` family, `clock_*`, `random_get`, the seven
 * `path_*` mutators, `fd_fdstat_*`, `fd_filestat_*`, `fd_pread`/`fd_pwrite`,
 * `environ_*`, `fd_prestat_*`, `proc_raise`, `sched_yield`, `fd_renumber`,
 * `fd_allocate` and `fd_sync`/`fd_datasync` have no end-to-end fixture here.
 * They are covered at the channel-record level by
 * `crates/wasi-module/tests/entry_points.rs`, which asserts the exact syscall
 * number and the six i64 argument slots each one emits. The TypeScript this
 * replaced had no end-to-end coverage of them either.
 */
import { describe, it, expect } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "fixtures");

describe("WASI guests run on the co-resident Rust module", () => {
  it("hello world via fd_write", async () => {
    const result = await runCentralizedProgram({
      programPath: join(fixturesDir, "wasi-hello.wasm"),
      timeout: 10_000,
    });
    expect(result.stdout).toBe("Hello from WASI\n");
    expect(result.exitCode).toBe(0);
  });

  it("args_get passes argv to the program", async () => {
    const result = await runCentralizedProgram({
      programPath: join(fixturesDir, "wasi-args.wasm"),
      argv: ["wasi-args", "test-argument-value"],
      timeout: 10_000,
    });
    expect(result.stdout).toBe("test-argument-value\n");
    expect(result.exitCode).toBe(0);
  });

  it("preserves scalar offsets above 2^53 through the real kernel channel", async () => {
    const result = await runCentralizedProgram({
      programPath: join(fixturesDir, "wasi-scalar-abi.wasm"),
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  // The three fixtures above cover fd_write to stdout, args_get, and i64
  // scalar fidelity. None of them opens a file or reads a directory, so
  // path_open, fd_read, fd_seek, fd_tell and fd_readdir had no end-to-end
  // coverage at all. These two close that gap against a REAL kernel.
  it("reads, seeks, and tells against a real file via path_open", async () => {
    const result = await runCentralizedProgram({
      programPath: join(fixturesDir, "wasi-file-io.wasm"),
      // The fixture creates everything it needs, so it runs against the
      // kernel's own writable overlay rather than the canonical rootfs
      // image. That keeps a test of WASI file I/O from depending on the
      // whole base-program set having been built.
      useDefaultRootfs: false,
      timeout: 10_000,
    });
    // "abcd" from the first read, "4" from fd_tell, "ghi" after a relative
    // seek. A failing call inside the fixture prints "E" and exits 1, so a
    // regression is visible in BOTH the exit code and stdout.
    expect(result.stdout).toBe("abcd4ghi\n");
    expect(result.exitCode).toBe(0);
  });

  it("lists a real directory via fd_readdir", async () => {
    const result = await runCentralizedProgram({
      programPath: join(fixturesDir, "wasi-readdir.wasm"),
      // As above: the fixture creates its own directory and files.
      useDefaultRootfs: false,
      timeout: 10_000,
    });
    // Two five-character names ("alpha", "bravo"). "." and ".." are 1 and 2
    // characters, so the count is stable whether or not the kernel reports
    // them.
    //
    // This stays inside the single-batch case on purpose. The multi-batch
    // case is pinned in Rust, where the batch size can be controlled --
    // crates/wasi-module/tests/entry_points.rs, `defect_5_*`.
    expect(result.stdout).toBe("2\n");
    expect(result.exitCode).toBe(0);
  });
});
