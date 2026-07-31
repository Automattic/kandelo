import { describe, expect, it } from "vitest";
import { ExecutableModuleCache } from "../src/executable-module-cache";

interface TestModule {
  id: number;
  source: number[];
}

function bytes(...values: number[]): ArrayBuffer {
  return Uint8Array.from(values).buffer;
}

function compiler() {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    compile: async (source: ArrayBuffer): Promise<TestModule> => ({
      id: ++calls,
      source: [...new Uint8Array(source)],
    }),
  };
}

describe("ExecutableModuleCache", () => {
  it("reuses one module for aliases with identical executable bytes", async () => {
    const compiled = compiler();
    const cache = new ExecutableModuleCache<TestModule>({
      compile: compiled.compile,
    });
    const files = new Map<string, ArrayBuffer>([
      ["/bin/tool", bytes(0, 97, 115, 109, 1)],
      ["/usr/bin/tool-alias", bytes(0, 97, 115, 109, 1)],
    ]);
    const resolve = (path: string) => cache.getOrCompile(files.get(path)!);

    const direct = await resolve("/bin/tool");
    const alias = await resolve("/usr/bin/tool-alias");

    expect(alias).toBe(direct);
    expect(compiled.calls).toBe(1);
  });

  it("does not reuse stale code after a same-length path replacement", async () => {
    const compiled = compiler();
    const cache = new ExecutableModuleCache<TestModule>({
      compile: compiled.compile,
    });
    const files = new Map([["/bin/tool", bytes(0, 1, 2, 3)]]);
    const resolve = () => cache.getOrCompile(files.get("/bin/tool")!);

    const before = await resolve();
    // Model an in-place write that preserves path and length. Metadata-only
    // cache keys could miss this replacement when timestamps are coarse.
    files.set("/bin/tool", bytes(0, 1, 2, 4));
    const after = await resolve();

    expect(after).not.toBe(before);
    expect(after.source).toEqual([0, 1, 2, 4]);
    expect(compiled.calls).toBe(2);
  });

  it("coalesces concurrent compilation of the same content", async () => {
    let calls = 0;
    const module = { id: 1, source: [7, 8, 9] };
    const cache = new ExecutableModuleCache<TestModule>({
      compile: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return module;
      },
    });

    const [first, second] = await Promise.all([
      cache.getOrCompile(bytes(7, 8, 9)),
      cache.getOrCompile(bytes(7, 8, 9)),
    ]);

    expect(first).toBe(module);
    expect(second).toBe(module);
    expect(calls).toBe(1);
  });

  it("evicts the least-recently-used module at the entry bound", async () => {
    const compiled = compiler();
    const cache = new ExecutableModuleCache<TestModule>({
      maxEntries: 2,
      maxSourceBytes: 100,
      compile: compiled.compile,
    });

    const firstA = await cache.getOrCompile(bytes(1));
    const firstB = await cache.getOrCompile(bytes(2));
    expect(await cache.getOrCompile(bytes(1))).toBe(firstA);
    await cache.getOrCompile(bytes(3));
    const secondB = await cache.getOrCompile(bytes(2));

    expect(secondB).not.toBe(firstB);
    expect(cache.size).toBe(2);
    expect(cache.sourceBytes).toBe(2);
    expect(compiled.calls).toBe(4);
  });

  it("bounds source weight and compiles oversized modules uncached", async () => {
    const compiled = compiler();
    let digestCalls = 0;
    const cache = new ExecutableModuleCache<TestModule>({
      maxEntries: 10,
      maxSourceBytes: 3,
      compile: compiled.compile,
      digest: async (source) => {
        digestCalls += 1;
        return [...new Uint8Array(source)].join(",");
      },
    });

    await cache.getOrCompile(bytes(1, 1));
    await cache.getOrCompile(bytes(2, 2));
    expect(cache.size).toBe(1);
    expect(cache.sourceBytes).toBe(2);

    const oversized = bytes(3, 3, 3, 3);
    const first = await cache.getOrCompile(oversized);
    const second = await cache.getOrCompile(oversized.slice(0));

    expect(second).not.toBe(first);
    expect(cache.size).toBe(1);
    expect(cache.sourceBytes).toBe(2);
    expect(compiled.calls).toBe(4);
    expect(digestCalls).toBe(2);
  });

  it("removes failed compiler promises so a later launch can retry", async () => {
    let calls = 0;
    const cache = new ExecutableModuleCache<TestModule>({
      compile: async (source) => {
        calls += 1;
        if (calls === 1) throw new Error("compile failed");
        return { id: calls, source: [...new Uint8Array(source)] };
      },
    });

    await expect(cache.getOrCompile(bytes(4, 5, 6))).rejects.toThrow(
      "compile failed",
    );
    await expect(cache.getOrCompile(bytes(4, 5, 6))).resolves.toEqual({
      id: 2,
      source: [4, 5, 6],
    });
    expect(cache.size).toBe(1);
  });

  it("rejects invalid cache bounds", () => {
    expect(
      () => new ExecutableModuleCache({ maxEntries: -1 }),
    ).toThrow("entry limit");
    expect(
      () => new ExecutableModuleCache({ maxSourceBytes: 1.5 }),
    ).toThrow("source-byte limit");
  });
});
