import { describe, expect, it } from "vitest";

import { batchBySynReport } from "../src/input/input-batch.js";
import type { InputEvent } from "../src/input/input-source.js";

const EV_SYN = 0x00;
const EV_REL = 0x02;
const EV_KEY = 0x01;
const SYN_REPORT = 0x00;
const REL_X = 0x00;
const REL_Y = 0x01;
const KEY_A = 30;

function rel(code: number, value: number): InputEvent {
  return { device: 1, ev_type: EV_REL, code, value };
}
const syn: InputEvent = {
  device: 1,
  ev_type: EV_SYN,
  code: SYN_REPORT,
  value: 0,
};

describe("batchBySynReport", () => {
  it("flushes one batch per SYN_REPORT frame, including the SYN", () => {
    const batches: InputEvent[][] = [];
    const dispatch = batchBySynReport((b) => batches.push(b));

    dispatch(rel(REL_X, 5));
    dispatch(rel(REL_Y, -3));
    expect(batches).toHaveLength(0); // nothing flushed until the SYN
    dispatch(syn);

    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual([rel(REL_X, 5), rel(REL_Y, -3), syn]);
  });

  it("keeps separate frames separate", () => {
    const batches: InputEvent[][] = [];
    const dispatch = batchBySynReport((b) => batches.push(b));

    dispatch(rel(REL_X, 1));
    dispatch(syn);
    dispatch({ device: 0, ev_type: EV_KEY, code: KEY_A, value: 1 });
    dispatch({ device: 0, ev_type: EV_SYN, code: SYN_REPORT, value: 0 });

    expect(batches).toHaveLength(2);
    expect(batches[0]).toEqual([rel(REL_X, 1), syn]);
    expect(batches[1]).toEqual([
      { device: 0, ev_type: EV_KEY, code: KEY_A, value: 1 },
      { device: 0, ev_type: EV_SYN, code: SYN_REPORT, value: 0 },
    ]);
  });

  it("force-flushes a runaway frame that never sends a SYN_REPORT", () => {
    const batches: InputEvent[][] = [];
    const dispatch = batchBySynReport((b) => batches.push(b), 4);

    for (let i = 0; i < 5; i++) dispatch(rel(REL_X, i));

    // Cap is 4: the 4th record triggers a flush; the 5th starts a new frame.
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(4);
  });

  it("does not flush an empty frame", () => {
    const batches: InputEvent[][] = [];
    const dispatch = batchBySynReport((b) => batches.push(b));
    // A lone SYN is still a frame of one record — it must flush so the
    // kernel sees the frame boundary (e.g. a pointer-lock re-sync SYN).
    dispatch(syn);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual([syn]);
  });
});
