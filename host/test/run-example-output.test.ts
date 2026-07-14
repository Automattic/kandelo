import { describe, expect, it } from "vitest";
import { writeAllSync } from "../../examples/run-example-output";

describe("run-example guest output", () => {
  it("preserves every byte across short synchronous writes", () => {
    const chunks: Uint8Array[] = [];
    const offsets: number[] = [];
    const input = new Uint8Array([0, 255, 1, 128, 2]);

    writeAllSync(7, input, (_fd, data, offset, length) => {
      const written = Math.min(2, length);
      offsets.push(offset);
      chunks.push(new Uint8Array(data.subarray(offset, offset + written)));
      return written;
    });

    expect(offsets).toEqual([0, 2, 4]);
    expect(new Uint8Array(Buffer.concat(chunks))).toEqual(input);
  });

  it("fails instead of spinning when a write makes no progress", () => {
    expect(() =>
      writeAllSync(7, new Uint8Array([1]), () => 0),
    ).toThrow("short write to guest output sink");
  });
});
