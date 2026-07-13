import { describe, expect, it } from "vitest";

import { IOCTL_REQUESTS } from "../src/generated/abi";

describe("ioctl argument sizing", () => {
  it("generates Kandelo's supported OSS argument contracts", () => {
    for (const request of [0x5000, 0x5001, 0x5008, 0x500e]) {
      expect(IOCTL_REQUESTS[request], request.toString(16)).toEqual({
        argKind: "none",
        direction: "none",
        wasm32Size: 0,
        wasm64Size: 0,
      });
    }
    for (const request of [
      0xc0045002, // SPEED
      0xc0045003, // STEREO
      0xc0045004, // GETBLKSIZE
      0xc0045005, // SETFMT
      0xc0045006, // CHANNELS
      0xc004500a, // SETFRAGMENT
      0x8004500b, // GETFMTS
      0x8004500f, // GETCAPS
      0x80045017, // GETODELAY
      0x80045002, // READ_RATE
      0x80045005, // READ_BITS
      0x80045006, // READ_CHANNELS
    ]) {
      expect(
        IOCTL_REQUESTS[request]?.wasm32Size,
        request.toString(16),
      ).toBe(4);
      expect(
        IOCTL_REQUESTS[request]?.argKind,
        request.toString(16),
      ).toBe("pointer");
    }
    expect(IOCTL_REQUESTS[0x8010500c]?.wasm32Size).toBe(16); // GETOSPACE/audio_buf_info
    expect(IOCTL_REQUESTS[0x800c5012]?.wasm32Size).toBe(12); // GETOPTR/count_info
    expect(IOCTL_REQUESTS[0x540b]).toMatchObject({
      argKind: "scalar-i32",
      wasm32Size: 0,
    }); // TCFLSH has an immediate selector
  });
});
