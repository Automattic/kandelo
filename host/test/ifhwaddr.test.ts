import { describe, it, expect } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { resolveBinary } from "../src/binary-resolver";

describe("SIOCGIFCONF / SIOCGIFHWADDR", () => {
  it("returns a virtual MAC address via ioctl", async () => {
    const result = await runCentralizedProgram({
      programPath: resolveBinary("programs/ifhwaddr.wasm"),
      timeout: 10_000,
    });

    expect(result.exitCode).toBe(0);

    // Should find one interface named "eth0"
    expect(result.stdout).toContain("interfaces: 1");
    expect(result.stdout).toContain("name: eth0");

    // MAC should be locally-administered and non-zero
    expect(result.stdout).toContain("locally-administered: yes");
    expect(result.stdout).toContain("non-zero: yes");

    // MAC format: xx:xx:xx:xx:xx:xx
    const macMatch = result.stdout.match(/mac: ([0-9a-f]{2}(?::[0-9a-f]{2}){5})/);
    expect(macMatch).not.toBeNull();

    // Verify locally-administered bit (second-lowest bit of first octet)
    const firstOctet = parseInt(macMatch![1].split(":")[0], 16);
    expect(firstOctet & 0x02).toBe(0x02); // locally administered
    expect(firstOctet & 0x01).toBe(0x00); // unicast
  });
});
