import { describe, expect, it, vi } from "vitest";
import { NodeLazyAssetResolver } from "../src/node-lazy-asset-resolver";
import { MockWorkerAdapter } from "../src/worker-adapter";
import { resolveBinary } from "../src/binary-resolver";
import * as compiledEntry from "../src/compiled-worker-entry";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

describe("Node lazy asset resolver ownership", () => {
  it.each([false, true])("resolves a real package through the canonical checkpoint (source fallback=%s)", async (sourceFallback) => {
    const url = "binaries/programs/wasm32/dash.wasm";
    const expected = resolveBinary("programs/wasm32/dash.wasm");
    const directory = mkdtempSync(join(tmpdir(), "kandelo-checkpoint-proof-"));
    const marker = join(directory, "calls");
    const wrapper = join(directory, "xtask");
    const hostTarget = execFileSync("rustc", ["-vV"], { encoding: "utf8" })
      .match(/^host: (.+)$/m)![1];
    const checker = resolve("../target/program-index-checker", hostTarget, "release/xtask");
    const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
    writeFileSync(wrapper, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${quote(marker)}\nexec ${quote(checker)} "$@"\n`, { mode: 0o755 });
    const previousChecker = process.env.WASM_POSIX_XTASK_BIN;
    process.env.WASM_POSIX_XTASK_BIN = wrapper;
    const freshness = sourceFallback
      ? vi.spyOn(compiledEntry, "compiledWorkerEntryIsCurrent").mockReturnValue(false)
      : undefined;
    const resolver = new NodeLazyAssetResolver([url]);
    try {
      expect(await resolver.resolve(url)).toBe(expected);
      expect(readFileSync(marker, "utf8")).toContain("program-index-context-ensure");
    } finally {
      await resolver.close();
      freshness?.mockRestore();
      if (previousChecker === undefined) delete process.env.WASM_POSIX_XTASK_BIN;
      else process.env.WASM_POSIX_XTASK_BIN = previousChecker;
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("starts one cohort on first read and pins its per-URL results", async () => {
    const adapter = new MockWorkerAdapter();
    const resolver = new NodeLazyAssetResolver(["a", "b", "a"], adapter);
    expect(adapter.allWorkers).toHaveLength(0);
    let settled = false;
    const pending = resolver.resolve("a").then((path) => { settled = true; return path; });
    expect(adapter.allWorkers).toHaveLength(1);
    expect(adapter.lastWorkerData).toMatchObject({ urls: ["a", "b"] });
    await Promise.resolve();
    expect(settled).toBe(false);
    adapter.lastWorker!.simulateMessage(new Map([
      ["a", { path: "/immutable/a" }],
      ["b", { error: new Error("stale closure") }],
    ]));
    expect(await pending).toBe("/immutable/a");
    expect(await resolver.resolve("a")).toBe("/immutable/a");
    await expect(resolver.resolve("b")).rejects.toThrow("stale closure");
    expect(adapter.allWorkers).toHaveLength(1);
    await resolver.close();
  });

  it("checks newly introduced URLs off-thread and shares concurrent requests", async () => {
    const adapter = new MockWorkerAdapter();
    const resolver = new NodeLazyAssetResolver([], adapter);
    const first = resolver.resolve("late");
    const second = resolver.resolve("late");
    expect(adapter.allWorkers).toHaveLength(1);
    adapter.lastWorker!.simulateMessage(new Map([["late", { path: "/immutable/late" }]]));
    expect(await Promise.all([first, second])).toEqual(["/immutable/late", "/immutable/late"]);
    await resolver.close();
  });

  it("cancels pending reads on destroy and rejects subsequent reads", async () => {
    const adapter = new MockWorkerAdapter();
    const resolver = new NodeLazyAssetResolver(["a"], adapter);
    const pending = resolver.resolve("a");
    const rejected = expect(pending).rejects.toThrow("destroyed");
    await resolver.close();
    await rejected;
    await expect(resolver.resolve("a")).rejects.toThrow("closed");
    await resolver.close();
  });

  it.each(["crash", "exit", "invalid reply"])("reports %s when the affected URL is fetched", async (failure) => {
    const adapter = new MockWorkerAdapter();
    const resolver = new NodeLazyAssetResolver(["a"], adapter);
    const pending = resolver.resolve("a");
    const worker = adapter.lastWorker!;
    if (failure === "crash") worker.simulateError(new Error("resolver crash"));
    else if (failure === "exit") worker.simulateExit(1);
    else worker.simulateMessage(new Map());
    await expect(pending).rejects.toThrow(/resolver/);
    await resolver.close();
  });

  it("does not prepare a checker or allocate a worker for unused assets", async () => {
    const adapter = new MockWorkerAdapter();
    const resolver = new NodeLazyAssetResolver(["unused"], adapter);
    await resolver.close();
    expect(adapter.allWorkers).toHaveLength(0);
  });
});
