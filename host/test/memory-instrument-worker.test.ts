import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { resolveBinary } from "../src/binary-resolver";
import { MEMORY_PLAIN_FORM_SECTION } from "../src/fork-module-state";
import { createNodeProgramRewriteWorker } from "../src/memory-instrument-node";
import { MEMORY_REWRITE_AT_EXEC_SECTION, ProgramRewriter } from "../src/program-rewriter";

const instrumenter = new WebAssembly.Module(
  readFileSync(resolveBinary("kandelo_memory_instrument32.wasm")),
);
const mark = new TextEncoder().encode(MEMORY_REWRITE_AT_EXEC_SECTION);

function marked(plain: Uint8Array) {
  const bytes = Uint8Array.from([...plain, 0x00, 1 + mark.length, mark.length, ...mark]).buffer;
  return { bytes, module: new WebAssembly.Module(bytes) };
}

const rewriter = () => new ProgramRewriter(
  instrumenter,
  createNodeProgramRewriteWorker,
  (bytes) => WebAssembly.compile(bytes),
);

describe("program rewrite in a real Node worker", () => {
  it("rewrites a marked program and records the hash of its plain form", async () => {
    const program = marked(readFileSync(resolve(import.meta.dirname, "../../abi/program-fixtures/v56/raw-fork.wasm")));

    const rewritten = await rewriter().rewritten(program);

    expect(WebAssembly.Module.customSections(rewritten!.module, MEMORY_REWRITE_AT_EXEC_SECTION)).toEqual([]);
    expect(WebAssembly.Module.customSections(rewritten!.module, MEMORY_PLAIN_FORM_SECTION).map((section) => Buffer.from(section)))
      .toEqual([createHash("sha256").update(new Uint8Array(program.bytes)).digest()]);
  });

  it("reports why the instrumenter refuses a marked program", async () => {
    const program = marked(Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));

    await expect(rewriter().rewritten(program)).rejects.toThrow(/memory instrumentation failed: /);
  });
});
