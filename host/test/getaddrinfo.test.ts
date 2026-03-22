import { describe, it, expect } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";
import { NodePlatformIO } from "../src/platform/node";
import { FetchNetworkBackend } from "../src/networking/fetch-backend";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("getaddrinfo override", () => {
  it("resolves numeric IP, NULL name, and hostname via getaddrinfo", async () => {
    // Attach a FetchNetworkBackend (returns synthetic 10.x.x.x IPs, no real DNS needed)
    const io = new NodePlatformIO();
    (io as any).network = new FetchNetworkBackend();

    const { exitCode, stdout } = await runCentralizedProgram({
      programPath: join(__dirname, "../../examples/getaddrinfo_test.wasm"),
      io,
    });

    // Numeric IP (127.0.0.1) should resolve without syscall
    expect(stdout).toContain("OK: numeric IP resolved to 127.0.0.1");

    // NULL name should return loopback
    expect(stdout).toContain("OK: NULL name resolved to 127.0.0.1");

    // Hostname should resolve via syscall #140 → FetchNetworkBackend → 10.x.x.x
    expect(stdout).toContain("OK: example.com resolved to 10.");

    expect(stdout).toContain("ALL TESTS PASSED");
    expect(exitCode).toBe(0);
  }, 30_000);
});
