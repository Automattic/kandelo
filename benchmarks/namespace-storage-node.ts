import { closeSync, fstatSync, fsyncSync, ftruncateSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { compareNamespaces, measureNamespace, type PositionedFile } from "./namespace-storage";

const wasmPath = process.argv[2];
if (!wasmPath) throw new Error("Provide the namespace benchmark Wasm path");
const bytes = readFileSync(wasmPath);
const module = await WebAssembly.compile(bytes);
const scratch = mkdtempSync(join(resolve(".scratch"), "namespace-node-"));
try {
  let caseNumber = 0;
  const samples = await compareNamespaces(async (format, files, seed) => {
    const descriptors: number[] = [];
    try {
      const slots: PositionedFile[] = Array.from({ length: 3 }, (_, slot) => {
        const fd = openSync(join(scratch, `${caseNumber}-${slot}`), "wx+");
        descriptors.push(fd);
        return {
          size: () => fstatSync(fd).size,
          read: (offset, bytes) => readSync(fd, bytes, 0, bytes.length, offset),
          write: (offset, bytes) => writeSync(fd, bytes, 0, bytes.length, offset),
          flush: () => fsyncSync(fd),
          truncate: length => ftruncateSync(fd, length),
        };
      });
      return await measureNamespace(module, slots, format, files, seed);
    } finally {
      for (const fd of descriptors) closeSync(fd);
      caseNumber++;
    }
  });
  process.stdout.write(JSON.stringify({
    backend: "Node positioned files",
    node: process.version,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    samples,
  }, null, 2) + "\n");
} finally { rmSync(scratch, { recursive: true, force: true }); }
