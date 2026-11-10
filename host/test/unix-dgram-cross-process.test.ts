import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";

/**
 * syslog(3)'s sequence across a process boundary, end to end on the Node
 * host.
 *
 * Kandelo refused every AF_UNIX datagram whose peer lived in another process,
 * so making /dev/log bindable achieved nothing on its own: a daemon could bind
 * it and no other process could ever send to it. The Rust unit tests in
 * crates/runtime-core/src/syscalls.rs prove the routing and each refusal
 * against a two-process table. What only a guest can show, with the real
 * wasm32 kernel, musl's own socket calls and the host's argument staging, is
 * that connect() and send() to a path another process bound actually deliver.
 *
 * The guest (examples/unix_dgram_cross_process_test.c) judges its own result.
 * Its strongest assertion is the close-and-reuse case: a recorded association
 * outlives its peer's close(), and a freed socket slot goes to the next socket
 * that process allocates, so a stale send used to pass every validity check
 * and queue a log line into an unrelated socket. The guest arranges that
 * ordering for real — send, close, allocate, send again — and checks both that
 * the second send is refused and that the socket now holding the slot received
 * nothing.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const programPath = join(__dirname, "../../examples/unix_dgram_cross_process_test.wasm");

// Booting a kernel and forking a guest takes longer than Vitest's 5 s default
// on a loaded machine. A hang still fails, at this bound.
const TEST_TIMEOUT_MS = 90_000;

describe("cross-process AF_UNIX datagrams", () => {
  it("delivers syslog(3)'s connect-and-send to a peer another process bound", async () => {
    const result = await runCentralizedProgram({
      programPath,
      argv: ["unix_dgram_cross_process_test"],
      timeout: 60_000,
      useDefaultRootfs: false,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe("unix-dgram-cross-process-ok\n");
    expect(result.stderr).toBe("");
  }, TEST_TIMEOUT_MS);

  // The realistic arrangement: a privileged daemon owns /dev/log and its
  // clients do not. Binding the path needs write permission on /dev, so the
  // binder must be root, while the node is mode 0666 so any program linking
  // musl can log to it. The whole guest therefore starts as root and the
  // sender drops to uid 1000 after forking, which is the asymmetry a single
  // uid for the whole process could not express. Credentials must not change
  // where the datagram goes.
  it("routes a sender that has dropped privileges to the root-owned peer", async () => {
    const result = await runCentralizedProgram({
      programPath,
      argv: ["unix_dgram_cross_process_test", "unpriv"],
      timeout: 60_000,
      useDefaultRootfs: false,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe("unix-dgram-cross-process-ok\n");
    expect(result.stderr).toBe("");
  }, TEST_TIMEOUT_MS);
});
