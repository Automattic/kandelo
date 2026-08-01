import { describe, expect, it } from "vitest";
import { isWasmUnreachableTrap } from "../src/worker-main";

describe("committed worker exit traps", () => {
  it("recognizes V8 and WebKit unreachable spellings", () => {
    expect(
      isWasmUnreachableTrap(new WebAssembly.RuntimeError("unreachable")),
    ).toBe(true);
    expect(
      isWasmUnreachableTrap(
        new WebAssembly.RuntimeError(
          "Unreachable code should not be executed (evaluating 'trap()')",
        ),
      ),
    ).toBe(true);
  });

  it("does not accept ordinary errors or unrelated Wasm traps", () => {
    expect(isWasmUnreachableTrap(new Error("unreachable setup state"))).toBe(
      false,
    );
    expect(
      isWasmUnreachableTrap(
        new WebAssembly.RuntimeError("memory access out of bounds"),
      ),
    ).toBe(false);
  });
});
