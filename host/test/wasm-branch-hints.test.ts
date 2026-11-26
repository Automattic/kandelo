import { afterEach, describe, expect, it, vi } from "vitest";

const v8 = vi.hoisted(() => ({ setFlagsFromString: vi.fn() }));

vi.mock("node:v8", () => v8);

import { enableWasmBranchHints } from "../src/wasm-branch-hints";

describe("enableWasmBranchHints", () => {
  afterEach(() => {
    v8.setFlagsFromString.mockClear();
  });

  it("sets the V8 flag on Node 24", () => {
    enableWasmBranchHints("24.22.1");

    expect(v8.setFlagsFromString).toHaveBeenCalledExactlyOnceWith(
      "--experimental-wasm-branch-hinting",
    );
  });

  it("sets no flag on Node 26", () => {
    enableWasmBranchHints("26.4.0");

    expect(v8.setFlagsFromString).not.toHaveBeenCalled();
  });
});
