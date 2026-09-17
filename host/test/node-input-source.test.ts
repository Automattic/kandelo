import { describe, expect, it } from "vitest";
import { NodeInputSource } from "../src/input/node-input-source.js";
import type { InputEvent } from "../src/input/input-source.js";

describe("NodeInputSource", () => {
  it("start() registers but emits no records; stop() is a no-op too", () => {
    const recorded: InputEvent[] = [];
    const src = new NodeInputSource();
    src.start((ev) => recorded.push(ev));
    src.stop();
    expect(recorded).toEqual([]);
  });

  it("can be started + stopped repeatedly without throwing", () => {
    const src = new NodeInputSource();
    src.start(() => {});
    src.stop();
    src.start(() => {});
    src.stop();
    expect(true).toBe(true);
  });
});
