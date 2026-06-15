import { test, expect } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "../../../../..");

function currentAbiVersion(): number {
  const snapshot = JSON.parse(
    readFileSync(join(repoRoot, "abi/snapshot.json"), "utf8"),
  ) as { abi_version: number };
  return snapshot.abi_version;
}

function jsWasmCandidates(): string[] {
  return [
    join(repoRoot, "local-binaries/programs/wasm32/js.wasm"),
    join(repoRoot, "binaries/programs/wasm32/js.wasm"),
    join(repoRoot, "packages/registry/spidermonkey/bin/js.wasm"),
  ];
}

function spiderMonkeyNodeWasmCandidates(): string[] {
  return [
    join(repoRoot, "local-binaries/programs/wasm32/spidermonkey-node.wasm"),
    join(repoRoot, "local-binaries/programs/wasm32/node.wasm"),
    join(repoRoot, "binaries/programs/wasm32/spidermonkey-node.wasm"),
    join(repoRoot, "binaries/programs/wasm32/node.wasm"),
    join(repoRoot, "packages/registry/spidermonkey/bin/node.wasm"),
  ];
}

function findJsWasm(): string | null {
  return jsWasmCandidates().find((candidate) => existsSync(candidate)) ?? null;
}

function findSpiderMonkeyNodeWasm(): string | null {
  return spiderMonkeyNodeWasmCandidates().find((candidate) => existsSync(candidate)) ?? null;
}

function readULEB128(buf: Uint8Array, off: number): [number, number] {
  let result = 0;
  let shift = 0;
  let pos = off;
  for (;;) {
    const byte = buf[pos++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return [result, pos - off];
}

function readSLEB128I32(buf: Uint8Array, off: number): [number, number] {
  let result = 0;
  let shift = 0;
  let pos = off;
  let byte = 0;
  for (;;) {
    byte = buf[pos++];
    result |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  if (shift < 32 && (byte & 0x40) !== 0) result |= ~0 << shift;
  return [result, pos - off];
}

function skipLimits(buf: Uint8Array, off: number): number {
  const [flags, flagsLen] = readULEB128(buf, off);
  let pos = off + flagsLen;
  const [, minLen] = readULEB128(buf, pos);
  pos += minLen;
  if ((flags & 0x01) !== 0) {
    const [, maxLen] = readULEB128(buf, pos);
    pos += maxLen;
  }
  return pos;
}

function extractAbiVersion(bytes: Uint8Array): number | null {
  let off = 8;
  let importedFunctionCount = 0;
  let abiFunctionIndex: number | null = null;
  const decoder = new TextDecoder();

  while (off < bytes.length) {
    const id = bytes[off++];
    const [size, sizeLen] = readULEB128(bytes, off);
    off += sizeLen;
    const sectionEnd = off + size;

    if (id === 2) {
      const [count, countLen] = readULEB128(bytes, off);
      let pos = off + countLen;
      for (let i = 0; i < count; i++) {
        const [moduleLen, moduleLenBytes] = readULEB128(bytes, pos);
        pos += moduleLenBytes + moduleLen;
        const [nameLen, nameLenBytes] = readULEB128(bytes, pos);
        pos += nameLenBytes + nameLen;
        const kind = bytes[pos++];
        if (kind === 0x00) {
          importedFunctionCount++;
          const [, typeLen] = readULEB128(bytes, pos);
          pos += typeLen;
        } else if (kind === 0x01) {
          pos += 1;
          pos = skipLimits(bytes, pos);
        } else if (kind === 0x02) {
          pos = skipLimits(bytes, pos);
        } else if (kind === 0x03) {
          pos += 2;
        } else if (kind === 0x04) {
          pos += 1;
          const [, typeLen] = readULEB128(bytes, pos);
          pos += typeLen;
        }
      }
    } else if (id === 7) {
      const [count, countLen] = readULEB128(bytes, off);
      let pos = off + countLen;
      for (let i = 0; i < count; i++) {
        const [nameLen, nameLenBytes] = readULEB128(bytes, pos);
        pos += nameLenBytes;
        const name = decoder.decode(bytes.subarray(pos, pos + nameLen));
        pos += nameLen;
        const kind = bytes[pos++];
        const [index, indexLen] = readULEB128(bytes, pos);
        pos += indexLen;
        if (kind === 0x00 && name === "__abi_version") abiFunctionIndex = index;
      }
    } else if (id === 10 && abiFunctionIndex !== null) {
      const bodyIndex = abiFunctionIndex - importedFunctionCount;
      if (bodyIndex < 0) return null;
      const [count, countLen] = readULEB128(bytes, off);
      let pos = off + countLen;
      for (let i = 0; i < count; i++) {
        const [bodySize, bodySizeLen] = readULEB128(bytes, pos);
        pos += bodySizeLen;
        const bodyStart = pos;
        const bodyEnd = bodyStart + bodySize;
        if (i === bodyIndex) {
          const [localDeclCount, localDeclLen] = readULEB128(bytes, pos);
          pos += localDeclLen;
          for (let j = 0; j < localDeclCount; j++) {
            const [, nLen] = readULEB128(bytes, pos);
            pos += nLen + 1;
          }
          while (pos < bodyEnd) {
            const opcode = bytes[pos++];
            if (opcode === 0x41) {
              const [value] = readSLEB128I32(bytes, pos);
              return value;
            }
            if (opcode === 0x10) {
              const [, callTargetLen] = readULEB128(bytes, pos);
              pos += callTargetLen;
              continue;
            }
            if (opcode === 0x0b) break;
            return null;
          }
          return null;
        }
        pos = bodyEnd;
      }
    }

    off = sectionEnd;
  }
  return null;
}

const hasKernelWasm = [
  join(repoRoot, "local-binaries/kernel.wasm"),
  join(repoRoot, "binaries/kernel.wasm"),
].some((candidate) => existsSync(candidate));
const jsWasm = findJsWasm();
const jsWasmAbi = jsWasm ? extractAbiVersion(readFileSync(jsWasm)) : null;
const nodeWasm = findSpiderMonkeyNodeWasm();
const nodeWasmAbi = nodeWasm ? extractAbiVersion(readFileSync(nodeWasm)) : null;
const abiVersion = currentAbiVersion();

test.skip(!hasKernelWasm, "kernel.wasm is not built or fetched");
test.skip(!jsWasm, "SpiderMonkey js.wasm is not built or fetched");
test.skip(!nodeWasm, "SpiderMonkey Node-compatible wasm is not built or fetched");
test.skip(
  jsWasmAbi !== abiVersion,
  `SpiderMonkey js.wasm ABI ${jsWasmAbi ?? "unknown"} does not match current ABI ${abiVersion}; rebuild spidermonkey before running this stress test`,
);
test.skip(
  nodeWasmAbi !== abiVersion,
  `SpiderMonkey Node-compatible wasm ABI ${nodeWasmAbi ?? "unknown"} does not match current ABI ${abiVersion}; rebuild spidermonkey before running this stress test`,
);

test("repeated /usr/bin/js browser launches stay compact and do not leak processes", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(
    () => {
      const status = document.getElementById("status");
      return status && (status.textContent === "done" || status.textContent === "error");
    },
    { timeout: 180_000 },
  );

  const status = await page.locator("#status").textContent();
  const stderr = await page.locator("#stderr").textContent();
  const resultsText = await page.locator("#results").textContent();
  if (status === "error") {
    console.log("STDERR:", stderr);
    console.log("RESULTS:", resultsText);
  }

  expect(status).toBe("done");
  const results = JSON.parse(resultsText!);
  expect(results.iterations).toBe(7);
  expect(results.maxObservedMemoryBytes).toBeLessThan(512 * 1024 * 1024);
  expect(results.leakedPids).toEqual([]);
  expect(results.nodeWorkerProbes).toEqual([
    expect.objectContaining({
      label: "test-worker-abort-on-uncaught-exception-terminate",
      exitCode: 0,
      stdout: expect.stringContaining("abort-on-uncaught-exception-terminate exit 1"),
    }),
    expect.objectContaining({
      label: "test-worker-terminate-microtask-loop",
      exitCode: 0,
      stdout: expect.stringContaining("terminate-microtask-loop message up"),
    }),
  ]);
  expect(results.nodeWorkerProbes[1].stdout).toContain("terminate-microtask-loop exit 1");
  expect(results.stdout).toContain("stress-ok-6");
});
