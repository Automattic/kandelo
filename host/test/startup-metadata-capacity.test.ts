import { describe, expect, it } from "vitest";
import {
  POSIX_ARG_MAX_BYTES,
  PROCESS_METADATA_ENTRY_MAX_BYTES,
  PROCESS_STARTUP_MAX_ARGV_COUNT,
  PROCESS_STARTUP_MAX_ENVP_COUNT,
} from "../src/generated/abi";
import { buildKernelImportsForTest } from "../src/worker-main";

const E2BIG = 7;
const EFAULT = 14;
const EINVAL = 22;
const ERANGE = 34;

type EntryReader = (
  index: number,
  pointer: number | bigint,
  capacity: number,
) => number;

function reader(
  pointerWidth: 4 | 8,
  argv: string[],
  env: string[],
  kind: "argv" | "env",
  pages = 2,
): {
  memory: WebAssembly.Memory;
  read: EntryReader;
  imports: Record<string, WebAssembly.ExportValue>;
} {
  const memory = new WebAssembly.Memory({ initial: pages });
  const imports = buildKernelImportsForTest(
    memory,
    0,
    pointerWidth,
    argv,
    env,
  );
  return {
    memory,
    read: imports[
      kind === "argv" ? "kernel_argv_read" : "kernel_environ_get"
    ] as EntryReader,
    imports,
  };
}

function pointer(pointerWidth: 4 | 8, offset: number): number | bigint {
  return pointerWidth === 8 ? BigInt(offset) : offset;
}

function metadataAtRepresentedBytes(
  pointerWidth: 4 | 8,
  representedBytes: number,
): string[] {
  const vectorNullBytes = 2 * pointerWidth;
  const remaining = representedBytes - vectorNullBytes;
  const largestContribution =
    pointerWidth + PROCESS_METADATA_ENTRY_MAX_BYTES + 1;
  const count = Math.ceil(remaining / largestContribution);
  const contentBytes = remaining - count * (pointerWidth + 1);
  if (
    count < 0
    || count > PROCESS_STARTUP_MAX_ARGV_COUNT
    || contentBytes < 0
    || contentBytes > count * PROCESS_METADATA_ENTRY_MAX_BYTES
  ) {
    throw new Error("cannot construct requested startup metadata boundary");
  }
  let left = contentBytes;
  return Array.from({ length: count }, () => {
    const length = Math.min(left, PROCESS_METADATA_ENTRY_MAX_BYTES);
    left -= length;
    return "x".repeat(length);
  });
}

describe("process startup metadata capacity contract", () => {
  it.each([4, 8] as const)(
    "copies exact argv/environment entries, rejects one-short, and preserves larger-capacity tails for wasm%s",
    (pointerWidth) => {
      for (const kind of ["argv", "env"] as const) {
        const value = kind === "argv" ? "argument" : "NAME=value";
        const { memory, read } = reader(
          pointerWidth,
          kind === "argv" ? [value] : [],
          kind === "env" ? [value] : [],
          kind,
        );
        const encoded = new TextEncoder().encode(value);
        const offset = 128;
        const bytes = new Uint8Array(memory.buffer);
        bytes.fill(0x5a, offset, offset + encoded.byteLength + 2);

        expect(read(0, pointer(pointerWidth, 0), 0)).toBe(encoded.byteLength);
        expect(read(
          0,
          pointer(pointerWidth, offset),
          encoded.byteLength - 1,
        )).toBe(-ERANGE);
        expect([...bytes.slice(offset, offset + encoded.byteLength + 2)])
          .toEqual(Array(encoded.byteLength + 2).fill(0x5a));

        expect(read(
          0,
          pointer(pointerWidth, offset),
          encoded.byteLength,
        )).toBe(encoded.byteLength);
        expect([...bytes.slice(offset, offset + encoded.byteLength)])
          .toEqual([...encoded]);
        expect(bytes[offset + encoded.byteLength]).toBe(0x5a);

        bytes.fill(0x6b, offset, offset + encoded.byteLength + 2);
        expect(read(
          0,
          pointer(pointerWidth, offset),
          encoded.byteLength + 1,
        )).toBe(encoded.byteLength);
        expect([...bytes.slice(offset, offset + encoded.byteLength)])
          .toEqual([...encoded]);
        expect([...bytes.slice(
          offset + encoded.byteLength,
          offset + encoded.byteLength + 2,
        )]).toEqual([0x6b, 0x6b]);
      }
    },
  );

  it.each([4, 8] as const)(
    "validates startup pointers and current-memory boundaries for wasm%s",
    (pointerWidth) => {
      const { memory, read } = reader(pointerWidth, ["four"], [], "argv");
      const bytes = new Uint8Array(memory.buffer);
      const exactEnd = bytes.byteLength - 4;

      expect(read(0, pointer(pointerWidth, exactEnd), 4)).toBe(4);
      expect(new TextDecoder().decode(bytes.slice(exactEnd))).toBe("four");

      bytes.fill(0x6b, exactEnd - 1);
      expect(read(0, pointer(pointerWidth, exactEnd + 1), 4)).toBe(-EFAULT);
      expect([...bytes.slice(exactEnd - 1)])
        .toEqual(Array(5).fill(0x6b));

      expect(read(0, pointer(pointerWidth, 0), 4)).toBe(-EFAULT);
      expect(read(0, pointerWidth === 8 ? -1n : -1, 4)).toBe(-EFAULT);
      expect(read(0, pointerWidth === 8 ? 1 : 1.5, 4)).toBe(-EFAULT);
      expect(read(
        0,
        pointerWidth === 8 ? Number.MAX_SAFE_INTEGER + 1 : 0x1_0000_0000,
        4,
      )).toBe(-EFAULT);

      const empty = reader(pointerWidth, [""], [], "argv").read;
      expect(empty(0, pointer(pointerWidth, 0), 0)).toBe(0);
      expect(empty(0, pointer(pointerWidth, 0), 1)).toBe(-EFAULT);
      expect(empty(0, pointer(pointerWidth, exactEnd), 1)).toBe(0);
    },
  );

  it.each([4, 8] as const)(
    "rejects malformed indices and capacities without touching wasm%s memory",
    (pointerWidth) => {
      const { memory, read } = reader(pointerWidth, ["value"], [], "argv");
      const bytes = new Uint8Array(memory.buffer);
      bytes.fill(0x3c, 64, 80);

      for (const index of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, 1]) {
        expect(read(index, pointer(pointerWidth, 64), 16)).toBe(-EINVAL);
      }
      for (const capacity of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
        expect(read(0, pointer(pointerWidth, 64), capacity)).toBe(-EINVAL);
      }
      expect([...bytes.slice(64, 80)]).toEqual(Array(16).fill(0x3c));
    },
  );

  it.each([4, 8] as const)(
    "accepts exact ARG_MAX and rejects ARG_MAX+1 for wasm%s",
    (pointerWidth) => {
      const exact = metadataAtRepresentedBytes(
        pointerWidth,
        POSIX_ARG_MAX_BYTES,
      );
      const imports = buildKernelImportsForTest(
        new WebAssembly.Memory({ initial: 1 }),
        0,
        pointerWidth,
        exact,
        [],
      );
      expect(
        (imports.kernel_get_argc as () => number)(),
      ).toBe(exact.length);

      const oversized = metadataAtRepresentedBytes(
        pointerWidth,
        POSIX_ARG_MAX_BYTES + 1,
      );
      expect(() => buildKernelImportsForTest(
        new WebAssembly.Memory({ initial: 1 }),
        0,
        pointerWidth,
        oversized,
        [],
      )).toThrow(`errno ${E2BIG}`);
    },
  );

  it.each([4, 8] as const)(
    "accepts exact startup count limits and rejects count+1 for wasm%s",
    (pointerWidth) => {
      const argv = Array(PROCESS_STARTUP_MAX_ARGV_COUNT).fill("");
      const env = Array(PROCESS_STARTUP_MAX_ENVP_COUNT).fill("");
      const imports = buildKernelImportsForTest(
        new WebAssembly.Memory({ initial: 1 }),
        0,
        pointerWidth,
        argv,
        env,
      );
      expect((imports.kernel_get_argc as () => number)())
        .toBe(PROCESS_STARTUP_MAX_ARGV_COUNT);
      expect((imports.kernel_environ_count as () => number)())
        .toBe(PROCESS_STARTUP_MAX_ENVP_COUNT);

      expect(() => buildKernelImportsForTest(
        new WebAssembly.Memory({ initial: 1 }),
        0,
        pointerWidth,
        [...argv, ""],
        [],
      )).toThrow(`errno ${E2BIG}`);
      expect(() => buildKernelImportsForTest(
        new WebAssembly.Memory({ initial: 1 }),
        0,
        pointerWidth,
        [],
        [...env, ""],
      )).toThrow(`errno ${E2BIG}`);
    },
  );

  it.each([4, 8] as const)(
    "accepts exact per-entry size and rejects one byte more for wasm%s",
    (pointerWidth) => {
      const exact = "x".repeat(PROCESS_METADATA_ENTRY_MAX_BYTES);
      const imports = buildKernelImportsForTest(
        new WebAssembly.Memory({ initial: 1 }),
        0,
        pointerWidth,
        [exact],
        [],
      );
      expect(
        (imports.kernel_argv_read as EntryReader)(
          0,
          pointer(pointerWidth, 0),
          0,
        ),
      ).toBe(PROCESS_METADATA_ENTRY_MAX_BYTES);

      expect(() => buildKernelImportsForTest(
        new WebAssembly.Memory({ initial: 1 }),
        0,
        pointerWidth,
        [`${exact}x`],
        [],
      )).toThrow(`errno ${E2BIG}`);
    },
  );

  it.each([4, 8] as const)(
    "holds one immutable launch snapshot across sequential and interleaved reads for wasm%s",
    (pointerWidth) => {
      const argv = ["before"];
      const env = ["NAME=before"];
      const memory = new WebAssembly.Memory({ initial: 2 });
      const imports = buildKernelImportsForTest(
        memory,
        0,
        pointerWidth,
        argv,
        env,
      );
      const readArgv = imports.kernel_argv_read as EntryReader;
      const readEnv = imports.kernel_environ_get as EntryReader;
      argv[0] = "after-with-a-different-length";
      env[0] = "NAME=after-with-a-different-length";

      expect(readArgv(0, pointer(pointerWidth, 0), 0)).toBe(6);
      expect(readEnv(0, pointer(pointerWidth, 0), 0)).toBe(11);
      expect(readEnv(0, pointer(pointerWidth, 64), 11)).toBe(11);
      expect(readArgv(0, pointer(pointerWidth, 96), 6)).toBe(6);
      expect(readArgv(0, pointer(pointerWidth, 128), 6)).toBe(6);
      const bytes = new Uint8Array(memory.buffer);
      expect(new TextDecoder().decode(bytes.slice(64, 75))).toBe("NAME=before");
      expect(new TextDecoder().decode(bytes.slice(96, 102))).toBe("before");
      expect(new TextDecoder().decode(bytes.slice(128, 134))).toBe("before");
    },
  );
});
