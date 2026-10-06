/**
 * POSIX message queues, run as a real guest program on both caller widths.
 *
 * WHY THIS FILE EXISTS. `mq_timedsend`/`mq_timedreceive` had no end-to-end
 * coverage anywhere in the repository. The queue semantics were covered by
 * Rust unit tests in `crates/runtime-core/src/mqueue.rs`, and the only
 * host-side cases exercised a sizing preflight that the kernel now performs
 * itself — so nothing ran the path a real program takes.
 *
 * The fixture's sharpest assertions are the two EMSGSIZE cases. POSIX requires
 * EMSGSIZE when a sent message exceeds the queue's `mq_msgsize`, and when a
 * receive capacity is smaller than it. Both have to be decided from the
 * queue's own attribute BEFORE anything sizes a buffer from the caller's
 * length; get the order wrong and an oversized send reports ENOMEM, or EINVAL
 * above a transport's capacity, instead.
 *
 * Running the same source for wasm32 and wasm64 is not redundant: `mq_attr` is
 * 32 bytes on one and 64 on the other, and one kernel instance serves both.
 */
import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";
import { ensureWasm64ExampleFixture } from "./wasm64-example-fixture";

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasm32Binary = join(__dirname, "../../examples/mqueue_test.wasm");

describe("POSIX message queues", () => {
  it.each(["wasm32", "wasm64"] as const)(
    "priority ordering, zero-length messages, and EMSGSIZE both ways (%s)",
    async (arch) => {
      const programPath = arch === "wasm64"
        ? ensureWasm64ExampleFixture("mqueue_test.c")
        : wasm32Binary;
      const result = await runCentralizedProgram({
        programPath,
        timeout: 20_000,
        useDefaultRootfs: false,
      });

      // The queue's own attribute decides both EMSGSIZE cases. These two
      // markers are what distinguish a correct refusal from an allocation
      // that failed for an unrelated reason.
      expect(result.stdout).toContain(
        "mq_send above mq_msgsize is EMSGSIZE: ok",
      );
      expect(result.stdout).toContain(
        "mq_receive below mq_msgsize is EMSGSIZE: ok",
      );
      // A refused receive must not consume the message it refused.
      expect(result.stdout).toContain(
        "a refused receive leaves the message queued: ok",
      );
      expect(result.stdout).toContain(
        "mq_receive returns the highest priority first: ok",
      );
      // A zero-length message is still a message, and its destination is
      // never dereferenced for zero bytes.
      expect(result.stdout).toContain("mq_receive zero length: ok");
      expect(result.stdout).toContain(
        "mq_receive on an empty non-blocking queue is EAGAIN: ok",
      );
      expect(result.stdout).toContain(
        "mq_send on a full non-blocking queue is EAGAIN: ok",
      );
      expect(result.stdout).toContain("ALL TESTS PASSED");
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
    },
  );
});
