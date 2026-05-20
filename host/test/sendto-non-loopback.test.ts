import { describe, it, expect } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { resolveBinary } from "../src/binary-resolver";

/**
 * Node-host parity test for the `host_send_dgram` default — DA #3 from
 * the 2026-05-20 session-13 audit.
 *
 * On the browser host, `host_send_dgram` is overridden in the worker
 * entry to forward onto an open RTCDataChannel; on the Node host the
 * kernel-worker default is left in place and returns -ENETUNREACH
 * (-101). The Rust kernel side is covered by
 * `test_udp_non_loopback_routes_to_host` (syscalls.rs), but that test
 * uses MockHostIO and never exercises the actual default; this test
 * boots a real NodeKernelHost and asserts the userspace-visible
 * errno, closing the parity gap CLAUDE.md §"Two hosts" calls out.
 */
describe("sendto(non-loopback) on Node host", () => {
  it("propagates ENETUNREACH from the default host_send_dgram", async () => {
    const result = await runCentralizedProgram({
      programPath: resolveBinary("programs/sendto-non-loopback.wasm"),
      timeout: 10_000,
    });

    expect(result.stdout).toContain("PASS: sendto returned ENETUNREACH");
    expect(result.exitCode).toBe(0);
  });
});
