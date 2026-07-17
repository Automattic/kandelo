import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));
const program = join(__dirname, "../../examples/fifo_lifecycle_test.wasm");

describe("POSIX named FIFO lifecycle", () => {
  it("rendezvouses across processes and cancels an exact blocked thread", async () => {
    const result = await runCentralizedProgram({
      programPath: program,
      argv: ["fifo-lifecycle-test"],
      timeout: 30_000,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("FIFO_RENDEZVOUS_PASS");
    expect(result.stdout).toContain("FIFO_ENQUEUED_CANCEL_PASS");
    expect(result.stdout).toContain("FIFO_PRE_ENQUEUE_CANCEL_PASS");
    expect(result.stdout).toContain("FIFO_DISABLED_CANCEL_PASS");
    expect(result.stdout).toContain("FIFO_SIGNAL_EINTR_PASS");
    expect(result.stdout).toContain("FIFO_CANCEL_PASS");
    expect(result.stdout).toContain("FIFO_PATH_ONLY_PASS");
    expect(result.stdout).toContain("FIFO_FUTIMENS_PERMISSIONS_PASS");
    expect(result.stdout).toContain("FIFO_CACHED_CTIME_PASS");
    expect(result.stdout).toContain("FIFO_LIFECYCLE_PASS");
    expect(result.stderr).toBe("");
  });
});
