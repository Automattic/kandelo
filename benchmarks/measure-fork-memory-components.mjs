#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

const MIB = 1024 * 1024;
const WASM_PAGE_SIZE = 64 * 1024;
const MEMORY_MIB = 256;
const MEMORY_PAGES = MEMORY_MIB * MIB / WASM_PAGE_SIZE;
const NONZERO_PAGE_STRIDE = 16;
const WORKER_ITERATIONS = 32;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workerSource = String.raw`
  const { parentPort } = require("node:worker_threads");
  parentPort.once("message", ({ module, memory }) => {
    const exports = module ? WebAssembly.Module.exports(module).length : 0;
    const marker = memory ? new Uint8Array(memory.buffer)[0] : 0;
    parentPort.postMessage({ exports, marker });
  });
`;

function rssBytes() {
  return process.memoryUsage.rss();
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function fillSparsePages(memory) {
  const bytes = new Uint8Array(memory.buffer);
  let nonzeroBytes = 0;
  for (let page = 0; page < MEMORY_PAGES; page += NONZERO_PAGE_STRIDE) {
    bytes.fill(0xa5, page * WASM_PAGE_SIZE, (page + 1) * WASM_PAGE_SIZE);
    nonzeroBytes += WASM_PAGE_SIZE;
  }
  return nonzeroBytes;
}

async function runWorker(payload) {
  const worker = new Worker(workerSource, { eval: true });
  try {
    const response = new Promise((resolveResponse, rejectResponse) => {
      worker.once("message", resolveResponse);
      worker.once("error", rejectResponse);
    });
    worker.postMessage(payload);
    return await response;
  } finally {
    await worker.terminate();
  }
}

async function measureWorkerChurn(withModule) {
  const module = withModule
    ? await WebAssembly.compile(readFileSync(
      resolve(repoRoot, "benchmarks/wasm/fork-bench.wasm"),
    ))
    : undefined;
  const baselineRssBytes = rssBytes();
  let peakRssBytes = baselineRssBytes;
  const started = performance.now();
  for (let iteration = 0; iteration < WORKER_ITERATIONS; iteration += 1) {
    await runWorker(module ? { module } : {});
    peakRssBytes = Math.max(peakRssBytes, rssBytes());
  }
  await delay(100);
  return {
    iterations: WORKER_ITERATIONS,
    elapsedMs: performance.now() - started,
    baselineRssBytes,
    peakRssBytes,
    endRssBytes: rssBytes(),
    peakGrowthBytes: peakRssBytes - baselineRssBytes,
  };
}

async function measureSharedMemoryWorker() {
  const module = await WebAssembly.compile(readFileSync(
    resolve(repoRoot, "benchmarks/wasm/fork-bench.wasm"),
  ));
  const baselineRssBytes = rssBytes();
  const memory = new WebAssembly.Memory({
    initial: MEMORY_PAGES,
    maximum: MEMORY_PAGES,
    shared: true,
  });
  const nonzeroBytes = fillSparsePages(memory);
  const afterTouchRssBytes = rssBytes();
  const started = performance.now();
  const response = await runWorker({ module, memory });
  const afterWorkerRssBytes = rssBytes();
  if (response.marker !== 0xa5) {
    throw new Error(`shared-memory Worker read ${response.marker}, expected 165`);
  }
  return {
    memoryBytes: memory.buffer.byteLength,
    nonzeroBytes,
    elapsedMs: performance.now() - started,
    baselineRssBytes,
    afterTouchRssBytes,
    afterWorkerRssBytes,
    workerGrowthBytes: afterWorkerRssBytes - afterTouchRssBytes,
  };
}

function pageIsZero(words, firstWord, wordsPerPage) {
  const end = firstWord + wordsPerPage;
  for (let word = firstWord; word < end; word += 1) {
    if (words[word] !== 0n) return false;
  }
  return true;
}

async function measureClone(sparse) {
  const baselineRssBytes = rssBytes();
  const parent = new WebAssembly.Memory({
    initial: MEMORY_PAGES,
    maximum: MEMORY_PAGES,
    shared: true,
  });
  const nonzeroBytes = fillSparsePages(parent);
  const parentRssBytes = rssBytes();
  const started = performance.now();
  const child = new WebAssembly.Memory({
    initial: MEMORY_PAGES,
    maximum: MEMORY_PAGES,
    shared: true,
  });
  let copiedBytes = parent.buffer.byteLength;
  if (sparse) {
    copiedBytes = 0;
    const sourceWords = new BigUint64Array(parent.buffer);
    const sourceBytes = new Uint8Array(parent.buffer);
    const childBytes = new Uint8Array(child.buffer);
    const wordsPerPage = WASM_PAGE_SIZE / BigUint64Array.BYTES_PER_ELEMENT;
    for (let page = 0; page < MEMORY_PAGES; page += 1) {
      if (pageIsZero(sourceWords, page * wordsPerPage, wordsPerPage)) continue;
      const start = page * WASM_PAGE_SIZE;
      childBytes.set(sourceBytes.subarray(start, start + WASM_PAGE_SIZE), start);
      copiedBytes += WASM_PAGE_SIZE;
    }
  } else {
    new Uint8Array(child.buffer).set(new Uint8Array(parent.buffer));
  }
  const elapsedMs = performance.now() - started;
  await delay(100);
  const cloneRssBytes = rssBytes();
  if (new Uint8Array(child.buffer)[0] !== 0xa5) {
    throw new Error("clone did not preserve the nonzero marker");
  }
  return {
    memoryBytes: parent.buffer.byteLength,
    nonzeroBytes,
    copiedBytes,
    elapsedMs,
    baselineRssBytes,
    parentRssBytes,
    cloneRssBytes,
    cloneGrowthBytes: cloneRssBytes - parentRssBytes,
  };
}

async function runCase(name) {
  if (typeof globalThis.gc === "function") {
    throw new Error("component measurements must run without --expose-gc");
  }
  switch (name) {
    case "worker-only": return measureWorkerChurn(false);
    case "module-worker": return measureWorkerChurn(true);
    case "shared-memory-worker": return measureSharedMemoryWorker();
    case "full-clone": return measureClone(false);
    case "sparse-clone": return measureClone(true);
    default: throw new Error(`unknown component measurement: ${name}`);
  }
}

const selectedCase = process.argv[2];
if (selectedCase) {
  process.stdout.write(`${JSON.stringify(await runCase(selectedCase))}\n`);
} else {
  const results = {};
  for (const name of [
    "worker-only",
    "module-worker",
    "shared-memory-worker",
    "full-clone",
    "sparse-clone",
  ]) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), name], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    if (child.status !== 0) {
      throw new Error(
        `${name} failed (${child.status}): ${child.stderr || child.stdout}`,
      );
    }
    results[name] = JSON.parse(child.stdout.trim());
  }
  process.stdout.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    memoryMiB: MEMORY_MIB,
    nonzeroPageStride: NONZERO_PAGE_STRIDE,
    results,
  }, null, 2)}\n`);
}
