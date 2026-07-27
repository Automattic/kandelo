import { describe, expect, it, vi } from "vitest";

import { assertSupportedKernelFunctionImports } from "../src/worker-main";

function section(id: number, payload: number[]): number[] {
  return [id, payload.length, ...payload];
}

function wasmString(value: string): number[] {
  const bytes = [...new TextEncoder().encode(value)];
  return [bytes.length, ...bytes];
}

function moduleImportingKernelFunction(name: string): WebAssembly.Module {
  const typeSection = section(1, [1, 0x60, 0, 0]);
  const importSection = section(2, [
    1,
    ...wasmString("kernel"),
    ...wasmString(name),
    0,
    0,
  ]);
  return new WebAssembly.Module(new Uint8Array([
    0x00, 0x61, 0x73, 0x6d,
    0x01, 0x00, 0x00, 0x00,
    ...typeSection,
    ...importSection,
  ]));
}

describe("process kernel-import contract", () => {
  it("accepts only an explicitly callable channel-mode kernel import", () => {
    const module = moduleImportingKernelFunction("kernel_fork");
    const kernelFork = vi.fn();

    expect(() =>
      assertSupportedKernelFunctionImports(module, {
        kernel_fork: kernelFork,
      })
    ).not.toThrow();
    expect(kernelFork).not.toHaveBeenCalled();
  });

  it.each([
    "kernel_readv",
    "kernel_writev",
    "kernel_preadv",
    "kernel_pwritev",
  ])("rejects obsolete direct import %s before instantiation", (name) => {
    const module = moduleImportingKernelFunction(name);
    const kernelImports: Record<string, WebAssembly.ExportValue> = {};

    expect(() =>
      assertSupportedKernelFunctionImports(module, kernelImports)
    ).toThrow(
      `Unsupported kernel import kernel.${name}; `
        + "rebuild this program with the current Kandelo SDK",
    );
    expect(kernelImports).toEqual({});
  });

  it("rejects a non-callable placeholder instead of treating it as support", () => {
    const module = moduleImportingKernelFunction("kernel_readv");

    expect(() =>
      assertSupportedKernelFunctionImports(module, {
        kernel_readv: 0 as unknown as WebAssembly.ExportValue,
      })
    ).toThrow(/Unsupported kernel import kernel\.kernel_readv/);
  });

  it("does not mistake an inherited object function for an explicit import", () => {
    const module = moduleImportingKernelFunction("toString");

    expect(() =>
      assertSupportedKernelFunctionImports(module, {})
    ).toThrow(/Unsupported kernel import kernel\.toString/);
  });
});
