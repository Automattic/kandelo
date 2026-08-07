import assert from "node:assert/strict";
import test from "node:test";

import { NodeKernelHost } from "../../host/src/node-kernel-host";
import { createNodeLifecycleMachine } from "./homebrew_guest_lifecycle_node";

test("forwards the exact supplied kernel bytes into NodeKernelHost.init", async () => {
  const expectedKernel = new Uint8Array([0, 97, 115, 109, 42]).buffer;
  let actualKernel: ArrayBuffer | undefined;
  const originalInit = NodeKernelHost.prototype.init;
  NodeKernelHost.prototype.init = async function (kernelWasmBytes) {
    actualKernel = kernelWasmBytes;
  };
  try {
    const machine = createNodeLifecycleMachine(
      {
        imageBytes: new Uint8Array([1]),
        lazyUrlBase: "https://embedded-homebrew.kandelo.invalid/flat-vfs/",
      },
      { kernelWasmBytes: expectedKernel },
    );
    await machine.start();
    assert.strictEqual(actualKernel, expectedKernel);
  } finally {
    NodeKernelHost.prototype.init = originalInit;
  }
});
