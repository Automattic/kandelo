import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  CHANNEL_SCALAR_SLOT_CONTRACTS,
  channelResultKind,
  normalizeChannelScalarArguments,
} from "../src/channel-scalar-contract";
import { ABI_SYSCALLS } from "../src/generated/abi";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const wasmApiSource = readFileSync(
  join(repoRoot, "crates/kernel/src/wasm_api.rs"),
  "utf8",
);
const kernelWorkerSource = readFileSync(
  join(repoRoot, "host/src/kernel-worker.ts"),
  "utf8",
);
const sharedScalarSource = readFileSync(
  join(repoRoot, "crates/shared/src/channel_scalar.rs"),
  "utf8",
);

function hostExactI64Slots(): string[] {
  return Object.entries(CHANNEL_SCALAR_SLOT_CONTRACTS)
    .flatMap(([syscall, slots]) =>
      Object.entries(slots)
        .filter(([, kind]) => kind === "i64")
        .map(([index]) => `${Number(syscall)}:${Number(index)}`)
    )
    .sort();
}

describe("channel scalar-slot contract", () => {
  it("preserves every exact i64 field before kernel scratch dispatch", () => {
    const exact = (1n << 53n) + 1n;
    for (const [syscallText, slots] of Object.entries(
      CHANNEL_SCALAR_SLOT_CONTRACTS,
    )) {
      for (const [indexText, kind] of Object.entries(slots)) {
        if (kind !== "i64") continue;
        const index = Number(indexText);
        const rawArgs = Array<bigint>(6).fill(0n);
        rawArgs[index] = exact;
        expect(
          normalizeChannelScalarArguments(Number(syscallText), rawArgs)[index],
        ).toBe(exact);
      }
    }
  });

  it("applies the default signed-i32 contract before any Number conversion", () => {
    const raw = (1n << 53n) + 1n;
    expect(
      normalizeChannelScalarArguments(ABI_SYSCALLS.Getpid, [
        raw,
        0n,
        0n,
        0n,
        0n,
        0n,
      ])[0],
    ).toBe(1);
  });

  it("normalizes split signed and unsigned words before Number conversion", () => {
    const tooWideLowWord = 0x1_ffff_ffffn;
    const widenedNegativeHighWord = 0xffff_ffffn;

    const lseek = normalizeChannelScalarArguments(ABI_SYSCALLS.Seek, [
      7n,
      tooWideLowWord,
      widenedNegativeHighWord,
      0n,
      0n,
      0n,
    ]);
    expect(lseek[1]).toBe(0xffff_ffff);
    expect(lseek[2]).toBe(-1);

    const llseek = normalizeChannelScalarArguments(ABI_SYSCALLS.Llseek, [
      7n,
      widenedNegativeHighWord,
      tooWideLowWord,
      0n,
      0n,
      0n,
    ]);
    expect(llseek[1]).toBe(-1);
    expect(llseek[2]).toBe(0xffff_ffff);

    for (const syscall of [
      ABI_SYSCALLS.Preadv,
      ABI_SYSCALLS.Pwritev,
      ABI_SYSCALLS.Preadv2,
      ABI_SYSCALLS.Pwritev2,
    ]) {
      const vector = normalizeChannelScalarArguments(syscall, [
        7n,
        0n,
        1n,
        tooWideLowWord,
        widenedNegativeHighWord,
        0n,
      ]);
      expect(vector[3]).toBe(0xffff_ffff);
      expect(vector[4]).toBe(-1);
    }
  });

  it("generates exact and pointer result kinds from the shared table", () => {
    expect(channelResultKind(ABI_SYSCALLS.Seek)).toBe("i64");
    expect(channelResultKind(ABI_SYSCALLS.Time)).toBe("i64");
    expect(channelResultKind(ABI_SYSCALLS.Mmap)).toBe("process-address");
    expect(channelResultKind(ABI_SYSCALLS.Brk)).toBe("process-address");
    expect(channelResultKind(ABI_SYSCALLS.Mremap)).toBe("process-address");
    expect(channelResultKind(ABI_SYSCALLS.Getpid)).toBe("i32");
  });

  it("routes every live Rust exact-i64 consumer through the declared helper", () => {
    const latentStubs = new Set([
      ABI_SYSCALLS.Readahead,
      ABI_SYSCALLS.Fadvise,
      ABI_SYSCALLS.SyncFileRange,
    ]);
    const expectedLive = hostExactI64Slots()
      .filter((slot) => !latentStubs.has(Number(slot.split(":")[0])))
      .sort();
    const liveConsumers = Array.from(
      wasmApiSource.matchAll(
        /channel_scalar::i64_argument\((\d+),\s*args,\s*(\d+)\)/g,
      ),
      (match) => `${Number(match[1])}:${Number(match[2])}`,
    ).sort();

    expect(liveConsumers).toEqual(expectedLive);
  });

  it("uses the scalar contract to initialize adjusted arguments", () => {
    expect(kernelWorkerSource).toContain(
      "const adjustedArgs = normalizeChannelScalarArguments(syscallNr, rawArgs);",
    );
    expect(kernelWorkerSource).not.toMatch(
      /syscallNr === SYS_LLSEEK && i ===/,
    );
    expect(kernelWorkerSource).not.toContain("adjustedArgs.map(Number)");
    expect(kernelWorkerSource).toContain(
      "BigInt.asUintN(64, rawRetVal)",
    );
    expect(kernelWorkerSource).toContain("publicationRetVal");
    expect(kernelWorkerSource).not.toContain(
      "channelReturnValueForPublication",
    );
    expect(wasmApiSource).toContain("dispatch_channel_wide_result");
    expect(wasmApiSource).not.toMatch(
      /(?:46|48|66|126)\s*=>[^,\\n]*as\s+i32/,
    );
    expect(sharedScalarSource).toContain(
      "assert_eq!(\n        argument_kind(syscall_number, index)",
    );
  });
});
