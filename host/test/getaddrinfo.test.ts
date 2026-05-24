import { describe, it, expect } from "vitest";
import { lookup } from "node:dns";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";
import { NodePlatformIO } from "../src/platform/node";
import { FetchNetworkBackend } from "../src/networking/fetch-backend";
import { TcpNetworkBackend } from "../src/networking/tcp-backend";

const __dirname = dirname(fileURLToPath(import.meta.url));

const HAS_PUBLIC_DNS = await new Promise<boolean>((resolve) =>
  lookup("example.com", 4, (err) => resolve(!err)),
);

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

  it.skipIf(!HAS_PUBLIC_DNS)(
    "resolves a hostname through TcpNetworkBackend without deadlocking on real DNS",
    async () => {
      // Regression: a prior Atomics.wait-based getaddrinfo deadlocked the
      // kernel thread against libuv's dns.lookup callback.
      const io = new NodePlatformIO();
      (io as any).network = new TcpNetworkBackend();

      const { exitCode, stdout } = await runCentralizedProgram({
        programPath: join(__dirname, "../../examples/getaddrinfo_test.wasm"),
        io,
      });

      expect(stdout).toContain("OK: numeric IP resolved to 127.0.0.1");
      expect(stdout).toMatch(/OK: example\.com resolved to (\d{1,3}\.){3}\d{1,3}/);
      expect(stdout).toContain("ALL TESTS PASSED");
      expect(exitCode).toBe(0);
    },
    30_000,
  );
});
