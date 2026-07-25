import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ABI_VERSION } from "../src/generated/abi";
import {
  captureProgramFixtureBuildContract,
  programFixtureNeedsRebuild,
  stampProgramFixture,
} from "./program-fixture-freshness";

const temporaryDirectories: string[] = [];

function uleb128(value: number): number[] {
  const bytes: number[] = [];
  do {
    let byte = value & 0x7f;
    value = Math.floor(value / 128);
    if (value !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (value !== 0);
  return bytes;
}

function sleb128I32(value: number): number[] {
  const bytes: number[] = [];
  for (;;) {
    let byte = value & 0x7f;
    value >>= 7;
    const signBit = (byte & 0x40) !== 0;
    if ((value === 0 && !signBit) || (value === -1 && signBit)) {
      bytes.push(byte);
      return bytes;
    }
    bytes.push(byte | 0x80);
  }
}

function section(id: number, payload: number[]): number[] {
  return [id, ...uleb128(payload.length), ...payload];
}

function nameBytes(name: string): number[] {
  const encoded = new TextEncoder().encode(name);
  return [...uleb128(encoded.length), ...encoded];
}

function executableWasmWithAbi(abi: number): Uint8Array {
  const functionBody = [0x00, 0x41, ...sleb128I32(abi), 0x0b];
  return Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d,
    0x01, 0x00, 0x00, 0x00,
    ...section(1, [0x01, 0x60, 0x00, 0x01, 0x7f]),
    ...section(3, [0x01, 0x00]),
    ...section(7, [
      0x01,
      ...nameBytes("__abi_version"),
      0x00,
      0x00,
    ]),
    ...section(10, [
      0x01,
      ...uleb128(functionBody.length),
      ...functionBody,
    ]),
  ]);
}

function writeAt(path: string, contents: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  utimesSync(path, 100, 100);
}

function createFixture(): {
  root: string;
  source: string;
  input: string;
  output: string;
} {
  const root = mkdtempSync(join(tmpdir(), "kandelo-fixture-freshness-"));
  temporaryDirectories.push(root);
  const source = join(root, "examples", "fixture.c");
  const input = join(root, "sysroot", "include", "fixture.h");
  const output = join(root, "examples", "fixture.wasm");
  writeAt(source, "int main(void) { return FIXTURE_VALUE; }\n");
  writeAt(input, "#define FIXTURE_VALUE 0\n");
  return { root, source, input, output };
}

function capture(root: string, input: string) {
  return captureProgramFixtureBuildContract(
    root,
    "wasm32\ncompiler=test-1",
    [input],
  );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("compiled program fixture freshness", () => {
  it("accepts only the exact stamped source content, independent of mtimes", () => {
    const { root, source, input, output } = createFixture();
    const contract = capture(root, input);
    writeAt(output, executableWasmWithAbi(ABI_VERSION));
    stampProgramFixture(source, output, contract);

    expect(programFixtureNeedsRebuild(source, output, contract)).toBe(false);

    // A newly touched output cannot conceal source bytes changed at the same
    // timestamp.
    writeAt(source, "int main(void) { return FIXTURE_VALUE + 1; }\n");
    utimesSync(output, 10_000, 10_000);
    expect(programFixtureNeedsRebuild(source, output, contract)).toBe(true);
  });

  it("invalidates same-ABI outputs after compiler/sysroot input changes", () => {
    const { root, source, input, output } = createFixture();
    const originalContract = capture(root, input);
    writeAt(output, executableWasmWithAbi(ABI_VERSION));
    stampProgramFixture(source, output, originalContract);
    expect(
      programFixtureNeedsRebuild(source, output, originalContract),
    ).toBe(false);

    writeAt(input, "#define FIXTURE_VALUE 1\n");
    const changedContract = capture(root, input);
    expect(changedContract.inputFingerprint).not.toBe(
      originalContract.inputFingerprint,
    );
    expect(programFixtureNeedsRebuild(source, output, changedContract)).toBe(
      true,
    );
  });

  it("rejects missing, malformed, or duplicate input stamps", () => {
    const { root, source, input, output } = createFixture();
    const contract = capture(root, input);

    writeAt(output, executableWasmWithAbi(ABI_VERSION));
    expect(programFixtureNeedsRebuild(source, output, contract)).toBe(true);

    stampProgramFixture(source, output, contract);
    const stamped = readFileSync(output);
    stamped[stamped.byteLength - 1] = "z".charCodeAt(0);
    writeAt(output, stamped);
    expect(programFixtureNeedsRebuild(source, output, contract)).toBe(true);

    writeAt(output, executableWasmWithAbi(ABI_VERSION));
    stampProgramFixture(source, output, contract);
    stampProgramFixture(source, output, contract);
    expect(programFixtureNeedsRebuild(source, output, contract)).toBe(true);
  });

  it("rejects an otherwise current stamp under the wrong ABI", () => {
    const { root, source, input, output } = createFixture();
    const contract = capture(root, input);
    writeAt(output, executableWasmWithAbi(ABI_VERSION - 1));
    stampProgramFixture(source, output, contract);

    expect(programFixtureNeedsRebuild(source, output, contract)).toBe(true);
  });
});
