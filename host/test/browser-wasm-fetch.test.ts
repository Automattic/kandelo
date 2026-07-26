import { afterEach, describe, expect, it, vi } from "vitest";
import { runFetchedWasmProgram } from "../../apps/browser-demos/test/run-fetched-wasm-program";

describe("direct browser Wasm fixture fetches", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects an HTTP-success HTML fallback before invoking the kernel", async () => {
    const runTest = vi.fn();
    vi.stubGlobal("window", { __runTest: runTest });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("<!doctype html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        })
      ),
    );

    await expect(
      runFetchedWasmProgram({
        programUrl: "https://example.test/missing.wasm",
        argv: ["missing"],
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(
      /non-WebAssembly bytes: status=200 content-type=text\/html first-bytes=3c 21 64 6f/,
    );
    expect(runTest).not.toHaveBeenCalled();
  });
});
