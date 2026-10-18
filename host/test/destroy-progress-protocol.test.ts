import { describe, expect, it } from "vitest";
import type {
  DestroyProgressEvent as BrowserEvent,
  DestroyProgressMessage as BrowserMessage,
} from "../src/browser-kernel-protocol";
import type {
  DestroyProgressEvent as NodeEvent,
} from "../src/node-kernel-protocol";

describe("destroy_progress protocol", () => {
  it("describes cumulative teardown counts", () => {
    const event: BrowserEvent = {
      phase: "draining",
      completed: 3,
      total: 7,
      totalProvisional: true,
    };
    const message: BrowserMessage = { type: "destroy_progress", event };
    expect(message.type).toBe("destroy_progress");
    expect(message.event.totalProvisional).toBe(true);
  });

  it("uses the same shape in both hosts", () => {
    // A Node event must be assignable to the browser type and back. If the two
    // protocol files drift, this stops compiling.
    const node: NodeEvent = {
      phase: "terminating",
      completed: 9,
      total: 9,
      totalProvisional: false,
    };
    const browser: BrowserEvent = node;
    const back: NodeEvent = browser;
    expect(back.phase).toBe("terminating");
  });
});
