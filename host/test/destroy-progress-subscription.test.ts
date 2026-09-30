import { describe, expect, it } from "vitest";
import type { DestroyProgressEvent } from "../src/browser-kernel-protocol";
import type { BrowserKernel } from "../src/browser-kernel-host";
import type { NodeKernelHost } from "../src/node-kernel-host";

/** The shape both hosts must expose. */
type DestroyProgressSubscriber = {
  subscribeDestroyProgress(
    cb: (event: DestroyProgressEvent) => void,
  ): () => void;
};

describe("destroy progress subscription", () => {
  it("is exposed by the browser host", () => {
    type Check = BrowserKernel extends DestroyProgressSubscriber ? true : false;
    const satisfied: Check = true;
    expect(satisfied).toBe(true);
  });

  it("is exposed by the node host with the same signature", () => {
    type Check = NodeKernelHost extends DestroyProgressSubscriber ? true : false;
    const satisfied: Check = true;
    expect(satisfied).toBe(true);
  });
});
