import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adapterPath = join(__dirname, "../node-compat/adapter.js");
const suffixPath = join(__dirname, "../node-compat/suffix.js");
const adapterSource = `${readFileSync(adapterPath, "utf8")}\n${readFileSync(suffixPath, "utf8")}`;

function runAdapter(globals: Record<string, unknown>): string[] {
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
  return context.execArgv as string[];
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
});
