import { expect, test } from "@playwright/test";

import {
  classifyProcessMemoryRss,
  MIB,
  type ProcessMemoryRssSample,
} from "../process-memory-rss-telemetry";

function rssSamples(
  valuesMiB: readonly number[],
  childrenPerSample = 8,
): ProcessMemoryRssSample[] {
  return valuesMiB.map((rssMiB, index) => ({
    completedChildren: index * childrenPerSample,
    elapsedMs: index * 100,
    rssBytes: rssMiB * MIB,
    processes: [],
  }));
}

test.describe("engine-local process-memory RSS classification", () => {
  test("accepts two bounded trials against a sensitive live control", () => {
    const verdict = classifyProcessMemoryRss(
      [
        rssSamples([500, 520, 515, 510, 505, 500, 495]),
        rssSamples([510, 530, 525, 520, 515, 510, 505]),
      ],
      rssSamples([500, 580, 660, 740, 820]),
    );
    expect(verdict.status).toBe("pass");
  });

  test("reports an insensitive control instead of trusting a flat trace", () => {
    const verdict = classifyProcessMemoryRss(
      [
        rssSamples([500, 505, 510, 515]),
        rssSamples([500, 505, 510, 515]),
      ],
      rssSamples([500, 505, 510, 515]),
    );
    expect(verdict.status).toBe("inconclusive");
  });

  test("rejects two trials that grow like retained live processes", () => {
    const verdict = classifyProcessMemoryRss(
      [
        rssSamples([500, 580, 660, 740, 820]),
        rssSamples([510, 590, 670, 750, 830]),
      ],
      rssSamples([500, 580, 660, 740, 820]),
    );
    expect(verdict.status).toBe("regression");
  });

  test("requires agreement before reporting a regression", () => {
    const verdict = classifyProcessMemoryRss(
      [
        rssSamples([500, 580, 660, 740, 820]),
        rssSamples([510, 500, 490, 480, 470]),
      ],
      rssSamples([500, 580, 660, 740, 820]),
    );
    expect(verdict.status).toBe("inconclusive");
  });

  test("does not call a rising trial green only because it descended", () => {
    const verdict = classifyProcessMemoryRss(
      [
        rssSamples([900, 500, 600, 700, 800, 900, 1000]),
        rssSamples([910, 510, 610, 710, 810, 910, 1010]),
      ],
      rssSamples([500, 580, 660, 740, 820]),
    );
    expect(verdict.status).toBe("inconclusive");
  });
});
