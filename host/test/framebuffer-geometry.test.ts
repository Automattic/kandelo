import { describe, expect, it } from "vitest";
import { BrowserKernel } from "../src/browser-kernel-host.js";
import { NodeKernelHost } from "../src/node-kernel-host.js";
import type { MainToKernelMessage as BrowserMessage } from "../src/browser-kernel-protocol.js";
import type { MainToKernelMessage as NodeMessage } from "../src/node-kernel-protocol.js";

/**
 * `/dev/fb0` geometry is a per-image setting the host pushes into the
 * kernel at boot. Both hosts carry the same message, so both are checked
 * here rather than one being taken as evidence for the other.
 *
 * What the message DOES once it reaches the kernel is covered end to end
 * by `framebuffer-integration.test.ts`, which runs fbtest against a pushed
 * mode and reads the pattern back out of the bound region.
 *
 * Both constructors only store options, so a bare instance is safe to
 * build; `init()` (which spawns a worker) is bypassed by stubbing the send
 * path directly.
 */
describe("framebuffer geometry", () => {
  it("BrowserKernel.setFbGeometry posts the worker message", () => {
    const kernel = new BrowserKernel();
    const sent: BrowserMessage[] = [];
    (kernel as unknown as { sendToKernel: (m: BrowserMessage) => void })
      .sendToKernel = (m) => sent.push(m);

    kernel.setFbGeometry(1280, 800);

    expect(sent).toEqual([
      { type: "set_fb_geometry", width: 1280, height: 800 },
    ]);
  });

  it("NodeKernelHost.setFbGeometry posts the same worker message", () => {
    const host = new NodeKernelHost();
    const sent: NodeMessage[] = [];
    (host as unknown as { sendToWorker: (m: NodeMessage) => void })
      .sendToWorker = (m) => sent.push(m);

    host.setFbGeometry(1280, 800);

    expect(sent).toEqual([
      { type: "set_fb_geometry", width: 1280, height: 800 },
    ]);
  });
});
