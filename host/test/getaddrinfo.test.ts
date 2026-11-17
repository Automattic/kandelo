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
    // Attach a FetchNetworkBackend (made-up 198.18.0.0/15 addresses, no real DNS needed)
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

    // Hostname should resolve via syscall #140 → FetchNetworkBackend → 198.18.0.0/15
    expect(stdout).toContain("OK: example.com resolved to 198.18.");

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

// Each line is `NAME ok A.B.C.D` or `NAME error <EAI code> <gai_strerror>`.
const lookupProgram = join(__dirname, "../../examples/getaddrinfo_lookup.wasm");
const EAI_NONAME = -2;

describe("getaddrinfo results a guest observes", () => {
  it.skipIf(!HAS_PUBLIC_DNS)(
    "reports a name the Node host resolver does not know as EAI_NONAME",
    async () => {
      // `.invalid` is reserved never to resolve (RFC 6761). Node reports it
      // as ENOTFOUND, which used to reach the guest as EIO and EAI_FAIL
      // ("Non-recoverable error") instead of "the name does not resolve".
      const io = new NodePlatformIO();
      (io as any).network = new TcpNetworkBackend();

      const { exitCode, stdout } = await runCentralizedProgram({
        programPath: lookupProgram,
        argv: ["getaddrinfo_lookup", "example.com", "kandelo-no-such-name.invalid"],
        io,
      });

      expect(stdout).toMatch(/^example\.com ok (\d{1,3}\.){3}\d{1,3}$/m);
      expect(stdout).toContain(
        `kandelo-no-such-name.invalid error ${EAI_NONAME} Name does not resolve\n`,
      );
      expect(exitCode).toBe(0);
    },
    30_000,
  );

  it("fails name lookups when the machine has no network", async () => {
    // A Node machine without `enableTcpNetwork` has no egress link and no
    // resolver. Numeric literals and localhost still resolve in libc.
    const io = new NodePlatformIO();
    expect(io.network).toBeUndefined();

    const { exitCode, stdout } = await runCentralizedProgram({
      programPath: lookupProgram,
      argv: ["getaddrinfo_lookup", "192.0.2.7", "localhost", "example.com"],
      io,
    });

    expect(stdout).toContain("192.0.2.7 ok 192.0.2.7\n");
    expect(stdout).toContain("localhost ok 127.0.0.1\n");
    expect(stdout).toContain(`example.com error ${EAI_NONAME} Name does not resolve\n`);
    expect(exitCode).toBe(0);
  }, 30_000);
});
