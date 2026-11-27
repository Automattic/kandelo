import { describe, expect, it, vi } from "vitest";

import type { ProgramRewriteResponse } from "../src/memory-instrument-worker";
import { MEMORY_REWRITE_AT_EXEC_SECTION, ProgramRewriter } from "../src/program-rewriter";
import { MockWorkerHandle } from "../src/worker-adapter";

const emptyModule = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const mark = new TextEncoder().encode(MEMORY_REWRITE_AT_EXEC_SECTION);
const instrumenter = new WebAssembly.Module(Uint8Array.from(emptyModule));

function image(bytes: number[]) {
  const buffer = Uint8Array.from(bytes).buffer;
  return { bytes: buffer, module: new WebAssembly.Module(buffer) };
}

const plain = () => image(emptyModule);
const marked = (tail: number[] = []) => image([
  ...emptyModule,
  0x00, 1 + mark.length, mark.length, ...mark,
  ...tail,
]);
const otherMarked = () => marked([0x00, 0x02, 0x01, 0x61]);

function rewriterWith(...responses: (ProgramRewriteResponse | Error | number)[]) {
  const createWorker = vi.fn(() => {
    const worker = new MockWorkerHandle();
    const response = responses.shift()!;
    queueMicrotask(() => {
      if (response instanceof Error) worker.simulateError(response);
      else if (typeof response === "number") worker.simulateExit(response);
      else worker.simulateMessage(response);
    });
    return worker;
  });
  const compile = vi.fn(async (bytes: ArrayBuffer) => new WebAssembly.Module(bytes));
  return { rewriter: new ProgramRewriter(instrumenter, createWorker, compile), createWorker, compile };
}

const rewrittenResponse = (): ProgramRewriteResponse =>
  ({ kind: "rewritten", program: Uint8Array.from(emptyModule).buffer });

describe("ProgramRewriter", () => {
  it("starts no rewrite for a program without the mark", async () => {
    const { rewriter, createWorker } = rewriterWith();

    expect(await rewriter.rewritten(plain())).toBeNull();
    expect(createWorker).not.toHaveBeenCalled();
  });

  it("gives the rewrite worker the instrumenter and the bytes of a marked program", async () => {
    const { rewriter, createWorker, compile } = rewriterWith(rewrittenResponse());
    const program = marked();

    const rewritten = await rewriter.rewritten(program);

    expect(createWorker).toHaveBeenCalledWith({ instrumenter, program: program.bytes });
    expect(new Uint8Array(rewritten!.bytes)).toEqual(Uint8Array.from(emptyModule));
    expect(compile).toHaveBeenCalledWith(rewritten!.bytes);
    expect(rewritten!.module).toBe(await compile.mock.results[0]!.value);
  });

  it("rewrites the same bytes once and other bytes again", async () => {
    const { rewriter, createWorker } = rewriterWith(rewrittenResponse(), rewrittenResponse());

    const [first, second] = await Promise.all([rewriter.rewritten(marked()), rewriter.rewritten(marked())]);
    const other = await rewriter.rewritten(otherMarked());

    expect(second).toBe(first);
    expect(other).not.toBe(first);
    expect(createWorker).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["the worker reports a failure", { kind: "failure", detail: "foo" } as const, "foo"],
    ["the worker throws", new Error("bar"), "bar"],
    ["the worker exits", 1, "program rewrite worker exited: 1"],
  ])("rejects when %s and rewrites again at the next start", async (_, response, message) => {
    const { rewriter, createWorker } = rewriterWith(response, rewrittenResponse());

    await expect(rewriter.rewritten(marked())).rejects.toThrow(message);

    expect(await rewriter.rewritten(marked())).not.toBeNull();
    expect(createWorker).toHaveBeenCalledTimes(2);
  });
});
