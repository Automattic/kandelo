import { describe, expect, it, vi } from "vitest";
import {
  marshalNextOpfsDirectoryEntry,
  type OpfsDirectoryIterator,
} from "../src/vfs/opfs-directory-iterator";

describe("OPFS directory iterator atomicity", () => {
  it("does not consume an entry until payload and channel metadata both fit", () => {
    const iter: OpfsDirectoryIterator = {
      entries: [
        { name: "first", kind: "file" },
        { name: "second", kind: "directory" },
      ],
      index: 0,
    };
    const publish = vi.fn();

    expect(() =>
      marshalNextOpfsDirectoryEntry(iter, new Uint8Array(5), publish),
    ).toThrow(RangeError);
    expect(iter.index).toBe(0);
    expect(publish).not.toHaveBeenCalled();

    expect(() =>
      marshalNextOpfsDirectoryEntry(
        iter,
        new Uint8Array(32),
        () => {
          throw new Error("injected channel write failure");
        },
      ),
    ).toThrow("injected channel write failure");
    expect(iter.index).toBe(0);

    const data = new Uint8Array(32);
    expect(marshalNextOpfsDirectoryEntry(iter, data, publish)).toBe(true);
    expect(iter.index).toBe(1);
    expect(publish).toHaveBeenLastCalledWith(5);
    expect(new TextDecoder().decode(data.subarray(0, 5))).toBe("first");
    expect(data[5]).toBe(8);

    expect(marshalNextOpfsDirectoryEntry(iter, data, publish)).toBe(true);
    expect(iter.index).toBe(2);
    expect(publish).toHaveBeenLastCalledWith(6);
    expect(new TextDecoder().decode(data.subarray(0, 6))).toBe("second");
    expect(data[6]).toBe(4);
    expect(marshalNextOpfsDirectoryEntry(iter, data, publish)).toBe(false);
    expect(iter.index).toBe(2);
  });
});
