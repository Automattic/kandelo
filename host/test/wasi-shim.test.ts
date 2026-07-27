/**
 * Integration tests for WASI Preview 1 compatibility shim.
 *
 * Runs hand-written WASI .wasm binaries through CentralizedKernelWorker
 * and verifies behavior (stdout output, args, etc.).
 */
import { afterEach, describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";
import { WasiShim } from "../src/wasi-shim";
import {
  ABI_SYSCALLS,
  CHANNEL_STATUS_COMPLETE,
  CH_ARG_SIZE,
  CH_ARGS,
  CH_DATA,
  CH_ERRNO,
  CH_RETURN,
  CH_STATUS,
  CH_SYSCALL,
  PROCESS_IOVEC_WASM32_BASE_OFFSET,
  PROCESS_IOVEC_WASM32_LEN_OFFSET,
} from "../src/generated/abi";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "fixtures");
const channelOffset = 64 * 1024;

interface ObservedChannelCall {
  syscall: number;
  args: bigint[];
}

interface ChannelResponse {
  result?: bigint;
  errno?: number;
  data?: Uint8Array;
}

function createChannelHarness(
  respond: (
    call: ObservedChannelCall,
    memory: WebAssembly.Memory,
  ) => ChannelResponse,
): {
  memory: WebAssembly.Memory;
  shim: WasiShim;
  calls: ObservedChannelCall[];
} {
  const memory = new WebAssembly.Memory({
    initial: 3,
    maximum: 3,
    shared: true,
  });
  const calls: ObservedChannelCall[] = [];

  vi.spyOn(Atomics, "wait").mockImplementation(() => {
    const view = new DataView(memory.buffer);
    const call = {
      syscall: view.getInt32(channelOffset + CH_SYSCALL, true),
      args: Array.from(
        { length: 6 },
        (_, index) => view.getBigInt64(
          channelOffset + CH_ARGS + index * CH_ARG_SIZE,
          true,
        ),
      ),
    };
    calls.push(call);

    const response = respond(call, memory);
    if (response.data) {
      new Uint8Array(memory.buffer, channelOffset + CH_DATA, response.data.length)
        .set(response.data);
    }
    view.setBigInt64(channelOffset + CH_RETURN, response.result ?? 0n, true);
    view.setUint32(channelOffset + CH_ERRNO, response.errno ?? 0, true);
    Atomics.store(
      new Int32Array(memory.buffer),
      (channelOffset + CH_STATUS) / Int32Array.BYTES_PER_ELEMENT,
      CHANNEL_STATUS_COMPLETE,
    );
    return "not-equal";
  });

  return {
    memory,
    shim: new WasiShim(memory, channelOffset, [], []),
    calls,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("WASI shim", () => {
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
});

describe("WASI shim scalar channel ABI", () => {
  it("passes pread and pwrite offsets in their single exact i64 slot", () => {
    const { memory, shim, calls } = createChannelHarness((call) => {
      if (call.syscall === ABI_SYSCALLS.Pread) {
        return { result: 3n, data: Uint8Array.of(1, 2, 3) };
      }
      return { result: 3n };
    });
    const view = new DataView(memory.buffer);
    const iov = 0x100;
    const buffer = 0x200;
    const countOut = 0x300;
    view.setUint32(iov + PROCESS_IOVEC_WASM32_BASE_OFFSET, buffer, true);
    view.setUint32(iov + PROCESS_IOVEC_WASM32_LEN_OFFSET, 3, true);

    const preadOffset = 0x0020_0000_0000_0001n;
    expect(shim.fd_pread(7, iov, 1, preadOffset, countOut)).toBe(0);
    expect(new Uint8Array(memory.buffer, buffer, 3)).toEqual(
      Uint8Array.of(1, 2, 3),
    );
    expect(view.getUint32(countOut, true)).toBe(3);
    expect(calls[0]).toEqual({
      syscall: ABI_SYSCALLS.Pread,
      args: [
        7n,
        BigInt(channelOffset + CH_DATA),
        3n,
        preadOffset,
        0n,
        0n,
      ],
    });

    new Uint8Array(memory.buffer, buffer, 3).set([4, 5, 6]);
    const pwriteOffset = 0x0020_0000_0000_0003n;
    expect(shim.fd_pwrite(8, iov, 1, pwriteOffset, countOut)).toBe(0);
    expect(calls[1]).toEqual({
      syscall: ABI_SYSCALLS.Pwrite,
      args: [
        8n,
        BigInt(channelOffset + CH_DATA),
        3n,
        pwriteOffset,
        0n,
        0n,
      ],
    });
  });

  it("splits signed lseek input words and preserves its exact i64 result", () => {
    const returnedOffset = 0x0020_0000_0000_0007n;
    const { memory, shim, calls } = createChannelHarness(() => ({
      result: returnedOffset,
    }));
    const newOffsetOut = 0x100;
    const offset = 0x0020_0001_89ab_cdefn;

    expect(shim.fd_seek(9, offset, 2, newOffsetOut)).toBe(0);
    expect(new DataView(memory.buffer).getBigUint64(newOffsetOut, true))
      .toBe(returnedOffset);
    expect(calls).toEqual([{
      syscall: ABI_SYSCALLS.Seek,
      args: [
        9n,
        BigInt.asUintN(32, offset),
        BigInt.asIntN(32, offset >> 32n),
        2n,
        0n,
        0n,
      ],
    }]);
  });

  it("sign-extends negative lseek offsets and uses SEEK_CUR for fd_tell", () => {
    const tellResult = 0x0020_0000_0000_000bn;
    const { memory, shim, calls } = createChannelHarness((_call) => ({
      result: calls.length === 1 ? 0n : tellResult,
    }));
    const seekOut = 0x100;
    const tellOut = 0x108;

    expect(shim.fd_seek(10, -1n, 0, seekOut)).toBe(0);
    expect(shim.fd_tell(10, tellOut)).toBe(0);
    expect(new DataView(memory.buffer).getBigUint64(tellOut, true))
      .toBe(tellResult);
    expect(calls).toEqual([
      {
        syscall: ABI_SYSCALLS.Seek,
        args: [10n, 0xffff_ffffn, -1n, 0n, 0n, 0n],
      },
      {
        syscall: ABI_SYSCALLS.Seek,
        args: [10n, 0n, 0n, 1n, 0n, 0n],
      },
    ]);
  });

  it("does not replace the seek output when the channel returns an error", () => {
    const { memory, shim } = createChannelHarness(() => ({
      result: -1n,
      errno: 22,
    }));
    const out = 0x100;
    const sentinel = 0x1234_5678_9abc_def0n;
    new DataView(memory.buffer).setBigUint64(out, sentinel, true);

    expect(shim.fd_seek(11, 0n, 0, out)).toBe(28);
    expect(new DataView(memory.buffer).getBigUint64(out, true)).toBe(sentinel);
  });

  it("rejects an invalid WASI whence before issuing a channel syscall", () => {
    const { memory, shim, calls } = createChannelHarness(() => ({
      result: 123n,
    }));
    const out = 0x100;
    const sentinel = 0x1234_5678_9abc_def0n;
    new DataView(memory.buffer).setBigUint64(out, sentinel, true);

    expect(shim.fd_seek(11, 0n, 3, out)).toBe(28);
    expect(calls).toEqual([]);
    expect(new DataView(memory.buffer).getBigUint64(out, true)).toBe(sentinel);
  });

  it("passes ftruncate and fallocate scalars in their exact ABI slots", () => {
    const { shim, calls } = createChannelHarness(() => ({ result: 0n }));
    const size = 0x0020_0000_0000_0001n;
    const offset = 0x0020_0000_0000_0003n;
    const len = 0x7fff_ffff_ffff_ffffn;

    expect(shim.fd_filestat_set_size(12, size)).toBe(0);
    expect(shim.fd_allocate(13, offset, len)).toBe(0);
    expect(calls).toEqual([
      {
        syscall: ABI_SYSCALLS.Ftruncate,
        args: [12n, size, 0n, 0n, 0n, 0n],
      },
      {
        syscall: ABI_SYSCALLS.Fallocate,
        args: [13n, 0n, offset, len, 0n, 0n],
      },
    ]);
  });

  it("rejects direct JavaScript scalars that cannot encode signed i64 exactly", () => {
    const { shim, calls } = createChannelHarness(() => ({ result: 0n }));
    const aboveI64 = 1n << 63n;
    const unsafeNumber = Number.MAX_SAFE_INTEGER + 1;

    expect(() => shim.fd_filestat_set_size(14, aboveI64)).toThrow(
      /outside signed i64/,
    );
    expect(() =>
      shim.fd_allocate(14, -(1n << 63n) - 1n, 1n)
    ).toThrow(/outside signed i64/);
    expect(() =>
      shim.fd_filestat_set_size(
        14,
        unsafeNumber as unknown as bigint,
      )
    ).toThrow(/safe integer/);
    expect(() =>
      shim.fd_allocate(14, 0.5 as unknown as bigint, 1n)
    ).toThrow(/safe integer/);
    expect(calls).toEqual([]);
  });
});
