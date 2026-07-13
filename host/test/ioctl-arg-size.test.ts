import { describe, expect, it } from "vitest";

import { ioctlArgSize, ioctlPointerRequired } from "../src/kernel-worker";

describe("ioctl argument sizing", () => {
  it("matches Kandelo's supported OSS wasm32 ABI", () => {
    for (const request of [0x5000, 0x5001, 0x5008, 0x500e]) {
      expect(ioctlArgSize(request), request.toString(16)).toBe(0);
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
      expect(ioctlArgSize(request), request.toString(16)).toBe(4);
    }
    expect(ioctlArgSize(0x8010500c)).toBe(16); // GETOSPACE/audio_buf_info
    expect(ioctlArgSize(0x800c5012)).toBe(12); // GETOPTR/count_info
    expect(ioctlArgSize(0x540b)).toBe(0); // TCFLSH has an immediate selector
    expect(ioctlPointerRequired(0x5000)).toBe(false);
    expect(ioctlPointerRequired(0x8010500c)).toBe(true);
  });
});
