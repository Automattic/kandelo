import { describe, expect, it } from "vitest";
import type {
  InputEvent,
  InputSource,
} from "../src/input/input-source.js";

describe("InputSource interface", () => {
  it("admits a minimal stub source that round-trips events through dispatch", () => {
    const recorded: InputEvent[] = [];

    class StubSource implements InputSource {
      private dispatch: ((ev: InputEvent) => void) | null = null;
      start(dispatch: (ev: InputEvent) => void): void {
        this.dispatch = dispatch;
      }
      stop(): void {
        this.dispatch = null;
      }
      emit(ev: InputEvent): void {
        this.dispatch?.(ev);
      }
    }

    const src = new StubSource();
    src.start((ev) => recorded.push(ev));
    src.emit({ device: 0, ev_type: 0x01, code: 30, value: 1 });
    src.emit({ device: 0, ev_type: 0x00, code: 0, value: 0 });
    src.stop();
    src.emit({ device: 1, ev_type: 0x02, code: 0, value: 5 });

    expect(recorded).toEqual([
      { device: 0, ev_type: 0x01, code: 30, value: 1 },
      { device: 0, ev_type: 0x00, code: 0, value: 0 },
    ]);
  });
});
