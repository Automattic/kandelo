import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";

/**
 * musl's syslog(3) against a daemon bound to /dev/log, end to end on the Node
 * host.
 *
 * unix-dgram-cross-process.test.ts proves the routing with sockets the guest
 * builds itself. This covers the call every ported program actually makes,
 * which differs in a way that matters: musl connects with an abbreviated
 * address (an 11-byte `struct { short family; char path[9]; }`, not a full
 * sockaddr_un), so a kernel that required the full structure would refuse
 * real syslog(3) while a hand-built socket still worked.
 *
 * The guest (examples/syslog_client_test.c) judges its own result. It checks
 * the fields a daemon routes on -- the priority, which encodes facility and
 * level, and the tag -- rather than the timestamp.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const programPath = join(__dirname, "../../examples/syslog_client_test.wasm");
const TEST_TIMEOUT_MS = 90_000;

describe("musl syslog(3) over /dev/log", () => {
  it("delivers the tag and priority to a daemon in another process", async () => {
    const result = await runCentralizedProgram({
      programPath,
      argv: ["syslog_client_test"],
      timeout: 60_000,
      useDefaultRootfs: false,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe("syslog-client-ok\n");
    expect(result.stderr).toBe("");
  }, TEST_TIMEOUT_MS);

  // The optionality contract: logging is per-image, and an image without a
  // daemon must not break the programs that log. POSIX gives syslog(3) no way
  // to report failure -- it returns void -- and musl ignores its connect()
  // result, so the message is dropped and the caller is told nothing. That is
  // the specified behaviour, not a Kandelo shortcut, and a `logger` built on
  // syslog(3) therefore cannot exit non-zero when no daemon is listening.
  it("drops the message without failing the caller when no daemon is bound", async () => {
    const result = await runCentralizedProgram({
      programPath,
      argv: ["syslog_client_test", "silent"],
      timeout: 60_000,
      useDefaultRootfs: false,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe("syslog-client-silent-ok\n");
    expect(result.stderr).toBe("");
  }, TEST_TIMEOUT_MS);
});
