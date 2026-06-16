/**
 * Boundary cases for the IoctlEncoded arg-size decoder used by the
 * host's ioctl marshalling. The decoder extracts the byte count from
 * bits 16..29 of the Linux `_IOC()` request word and clamps to a
 * caller-supplied floor for legacy size-0 ioctls (FIONBIO, FIOCLEX,
 * KDGKBTYPE, …).
 */
import { describe, expect, it } from "vitest";
import { computeIoctlEncodedSize } from "../src/kernel-worker";

const ioc = (dir: number, type: number, nr: number, size: number) =>
  (dir << 30) | (size << 16) | (type << 8) | nr;

const IOC_READ = 2;
const IOC_WRITE = 1;

describe("computeIoctlEncodedSize", () => {
  it("returns the floor for legacy size-0 ioctls", () => {
    // FIONBIO = _IO('T', 0x7e), size=0 → covered by floor=256.
    const FIONBIO = 0x5421;
    expect(computeIoctlEncodedSize(FIONBIO, 256)).toBe(256);
  });

  it("returns the encoded size when it exceeds the floor", () => {
    // SNDRV_PCM_IOCTL_HW_PARAMS = _IOWR('A', 0x11, struct snd_pcm_hw_params)
    // size=0x25c=604 → kernel must marshal 604 bytes.
    const req = ioc(IOC_READ | IOC_WRITE, 0x41, 0x11, 0x25c);
    expect(computeIoctlEncodedSize(req, 256)).toBe(0x25c);
  });

  it("honours the maximum 14-bit encoded size (0x3fff = 16383)", () => {
    const req = ioc(IOC_WRITE, 0x55, 0x42, 0x3fff);
    expect(computeIoctlEncodedSize(req, 256)).toBe(0x3fff);
  });

  it("masks out bits above the 14-bit size field", () => {
    // dir=11b in the top two bits + size set to 0x3fff — the 16-bit
    // shift + 14-bit mask must drop the direction bits cleanly.
    const req = ioc(IOC_READ | IOC_WRITE, 0xff, 0xff, 0x3fff) >>> 0;
    expect(computeIoctlEncodedSize(req, 0)).toBe(0x3fff);
  });

  it("uses unsigned shift so high-bit dir flags don't poison the size", () => {
    // dir=IOC_READ|IOC_WRITE places bit 31 = 1 (signed bit). A signed
    // right-shift would smear ones across the size field.
    const req = ioc(IOC_READ | IOC_WRITE, 0x55, 0x00, 0x0004);
    expect(computeIoctlEncodedSize(req, 256)).toBe(256);
    // And the size itself when above the floor.
    const req2 = ioc(IOC_READ | IOC_WRITE, 0x55, 0x00, 0x0400);
    expect(computeIoctlEncodedSize(req2, 256)).toBe(0x0400);
  });

  it("accepts a floor of zero (size=0 ioctl with no floor expected)", () => {
    const FIOCLEX = 0x5451;
    expect(computeIoctlEncodedSize(FIOCLEX, 0)).toBe(0);
  });
});
