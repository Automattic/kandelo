import { describe, it, expect } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { resolveBinary } from "../src/binary-resolver";
import { LocalVirtualNetwork } from "../src/networking/virtual-network";
import { NodePlatformIO } from "../src/platform/node";

describe("virtual network interface ioctls", () => {
  it.each([
    {
      arch: "wasm32",
      programPath: "programs/ifhwaddr.wasm",
      ifreqSize: 32,
    },
    {
      arch: "wasm64",
      programPath: "programs/wasm64/ifhwaddr.wasm",
      ifreqSize: 40,
    },
  ])(
    "honors interface and guest-memory contracts for $arch",
    async ({ arch, programPath, ifreqSize }) => {
      const network = new LocalVirtualNetwork();
      const io = new NodePlatformIO();
      io.network = network.attachMachine({
        id: `ifhwaddr-${arch}`,
        address: [10, 23, 45, 67],
      });

      const result = await runCentralizedProgram({
        programPath: resolveBinary(programPath),
        io,
        timeout: 30_000,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("FAIL:");
      expect(result.stdout).toContain(`ifreq-size: ${ifreqSize}`);
      expect(result.stdout).toContain("ifconf: lo=127.0.0.1 eth0=10.23.45.67");
      expect(result.stdout).toContain("eth0-address: 10.23.45.67");
      expect(result.stdout).toContain(
        "libc-name-to-index: lo=1 eth0=2 missing=0 errno=19",
      );
      expect(result.stdout).toContain("libc-invalid-index: errno=6");
      expect(result.stdout).toContain("nameindex: lo=1");
      expect(result.stdout).toContain("nameindex: eth0=2");
      expect(result.stdout).toContain(
        "PASS: virtual interface ioctl and libc contracts",
      );

      const macMatch = result.stdout.match(
        /eth0-mac: ([0-9a-f]{2}(?::[0-9a-f]{2}){5})/,
      );
      expect(macMatch).not.toBeNull();

      const firstOctet = parseInt(macMatch![1].split(":")[0], 16);
      expect(firstOctet & 0x02).toBe(0x02);
      expect(firstOctet & 0x01).toBe(0x00);
    },
    30_000,
  );
});
