import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adapterPath = join(__dirname, "../node-compat/adapter.js");
const suffixPath = join(__dirname, "../node-compat/suffix.js");
const adapterSource = `${readFileSync(adapterPath, "utf8")}\n${readFileSync(suffixPath, "utf8")}`;

function runAdapterContext(globals: Record<string, unknown>): vm.Context {
  const context = vm.createContext({
    ArrayBuffer,
    console,
    Map,
    Promise,
    queueMicrotask,
    TextDecoder,
    TextEncoder,
    Uint8Array,
    ...globals,
  });

  vm.runInContext(adapterSource, context, { filename: adapterPath });
  return context;
}

function runAdapter(globals: Record<string, unknown>): string[] {
  return runAdapterContext(globals).execArgv as string[];
}

describe("SpiderMonkey Node adapter argv normalization", () => {
  it("drops a duplicated executable name from scriptArgs when scriptPath is absent", () => {
    expect(runAdapter({
      scriptArgs: ["node", "/node-v22.0.0/prelude.js", "/node-v22.0.0/test.js"],
    })).toEqual([
      "node",
      "/node-v22.0.0/prelude.js",
      "/node-v22.0.0/test.js",
    ]);
  });

  it("keeps scriptArgs unchanged when they already start at the main script", () => {
    expect(runAdapter({
      scriptArgs: ["/node-v22.0.0/prelude.js", "/node-v22.0.0/test.js"],
    })).toEqual([
      "node",
      "/node-v22.0.0/prelude.js",
      "/node-v22.0.0/test.js",
    ]);
  });

  it("uses scriptPath when SpiderMonkey exposes one separately", () => {
    expect(runAdapter({
      scriptPath: "/node-v22.0.0/prelude.js",
      scriptArgs: ["/node-v22.0.0/test.js"],
    })).toEqual([
      "node",
      "/node-v22.0.0/prelude.js",
      "/node-v22.0.0/test.js",
    ]);
  });

  it("uses raw shell argv when the shell filtered Node-only options", () => {
    expect(runAdapter({
      kandeloNodeRawArgv: ["node", "--disable-proto=throw", "-e", "void 0"],
      scriptArgs: ["-e", "void 0"],
    })).toEqual(["node", "--disable-proto=throw", "-e", "void 0"]);
  });
});

describe("SpiderMonkey Node adapter worker preludes", () => {
  it("propagates --disable-proto=throw into shell worker source", () => {
    let workerSource = "";
    const context = runAdapterContext({
      evalInWorker(source: string) {
        workerSource = source;
      },
    });
    context.process = {
      env: {},
      execArgv: ["--disable-proto=throw"],
    };
    const workerThreads = context.__kandeloCreateWorkerThreads(
      EventEmitter,
      {},
    ) as { Worker: new (source: string, options: { eval: true }) => EventEmitter };

    new workerThreads.Worker("void 0;", { eval: true });

    expect(workerSource).toContain('__kandeloDisableProtoMode = "throw"');
    expect(workerSource).toContain('err.code = "ERR_PROTO_ACCESS"');
  });

  it("does not read --disable-proto from eval source text", () => {
    let workerSource = "";
    const context = runAdapterContext({
      evalInWorker(source: string) {
        workerSource = source;
      },
    });
    context.process = {
      env: {},
      execArgv: ["-e", "--disable-proto=throw"],
    };
    const workerThreads = context.__kandeloCreateWorkerThreads(
      EventEmitter,
      {},
    ) as { Worker: new (source: string, options: { eval: true }) => EventEmitter };

    new workerThreads.Worker("void 0;", { eval: true });

    expect(workerSource).toContain('__kandeloDisableProtoMode = ""');
  });
});
