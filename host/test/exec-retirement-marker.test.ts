import { describe, expect, it } from "vitest";

import {
  CH_SIG_BASE,
  CH_SIG_SIGNUM,
  CH_SIG_SI_CODE,
} from "../src/generated/abi";
import { isExecRetirementMarker } from "../src/worker-main";
import { EXEC_RETIRE_SIGNAL_CODE } from "../src/worker-protocol";

describe("exec worker retirement marker", () => {
  it("reads the marker from the generated ABI layout", () => {
    const channelOffset = 64;
    const view = new DataView(
      new ArrayBuffer(channelOffset + CH_SIG_SI_CODE + 4),
    );
    view.setUint32(channelOffset + CH_SIG_SIGNUM, 9, true);
    view.setUint32(
      channelOffset + CH_SIG_SI_CODE,
      EXEC_RETIRE_SIGNAL_CODE,
      true,
    );

    expect(isExecRetirementMarker(view, channelOffset)).toBe(true);

    view.setUint32(channelOffset + CH_SIG_SI_CODE, 0, true);
    // ABI 42 placed si_code four bytes earlier. A stale derived offset must
    // not accidentally become worker protocol after an ABI layout change.
    view.setUint32(
      channelOffset + CH_SIG_BASE + 24,
      EXEC_RETIRE_SIGNAL_CODE,
      true,
    );
    expect(isExecRetirementMarker(view, channelOffset)).toBe(false);
  });
});
