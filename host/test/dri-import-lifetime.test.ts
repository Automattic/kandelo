import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { NodeKernelHost } from "../src/node-kernel-host";
import { compileSdkFixture } from "./support/compile-sdk-fixture";

let fixture: ReturnType<typeof compileSdkFixture>;
let gemFixture: ReturnType<typeof compileSdkFixture>;
let inheritedFixture: ReturnType<typeof compileSdkFixture>;
beforeAll(() => {
  fixture = compileSdkFixture(new URL("./fixtures/kms-import-lifetime.c", import.meta.url), [], {
    forkInstrument: true,
  });
  gemFixture = compileSdkFixture(new URL("./fixtures/dri-gem-namespace.c", import.meta.url), [], {
    forkInstrument: true,
  });
  inheritedFixture = compileSdkFixture(new URL("./fixtures/dri-kms-inheritance.c", import.meta.url), [], {
    forkInstrument: true,
  });
}, 120_000);
afterAll(() => { fixture?.cleanup(); gemFixture?.cleanup(); inheritedFixture?.cleanup(); });

async function ownedOutput(host: NodeKernelHost, id: string) {
  // Owned command output is deliberately withheld from terminal callbacks.
  // Read the bounded public stream, including its actual retirement state.
  const state = await host.readOwnedJob(id, 0, 65536);
  if (state.expired) throw new Error(`Owned fixture output expired: ${id}`);
  expect(state.hasMore || state.truncated, "small fixture output is complete").toBe(false);
  const text = (stream: "stdout" | "stderr") => state.chunks
    .filter(chunk => chunk.stream === stream)
    .map(chunk => new TextDecoder().decode(chunk.bytes)).join("");
  return { ...state, stdout: text("stdout"), stderr: text("stderr") };
}

// Both guests retain a kernel handle and cursor reference. Mapping the
// import before allocator exit must not decide whether that handle survives.
it.each(["unmapped-owner", "mapped-owner", "terminate-owner", "trap-owner"])(
  "retains an imported cursor after allocator retirement (%s)", async mode => {
    let stdout = "", stderr = "", rootPid = 0;
    let resolveReady!: (pid: number) => void;
    const allocatorReady = new Promise<number>(resolve => { resolveReady = resolve; });
    let resolveAllocator!: (pid: number) => void;
    const allocatorReaped = new Promise<number>(resolve => { resolveAllocator = resolve; });
    const host = new NodeKernelHost({
      onStdout: (_pid, data) => {
        stdout += new TextDecoder().decode(data);
        const match = stdout.match(/allocator-reaped=(\d+)/);
        if (match) resolveAllocator(Number(match[1]));
        const ready = stdout.match(/allocator-ready=(\d+)/);
        if (ready) resolveReady(Number(ready[1]));
      },
      onStderr: (_pid, data) => { stderr += new TextDecoder().decode(data); },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await host.init();
      const exit = host.spawn(Uint8Array.from(readFileSync(fixture.programPath)).buffer,
        ["kms-import-lifetime", mode], {
          uid: 1000, gid: 1000,
          onStarted: pid => { rootPid = pid; },
        });
      if (mode === "terminate-owner") {
        const allocator = await Promise.race([allocatorReady,
          exit.then(status => { throw new Error(`Guest exited before forced removal: ${status} ${stdout} ${stderr}`); })]);
        await host.terminateProcess(allocator, 0);
      }
      if (mode !== "terminate-owner") {
        const allocator = await Promise.race([
          allocatorReaped,
          exit.then(status => { throw new Error(`Guest exited early (${status}): ${stdout} ${stderr}`); }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Guest phase timed out")), 30_000);
          }),
        ]);
        // stdout/waitpid proves guest exit, not asynchronous host retirement.
        // Await the public teardown acknowledgement before releasing the peer.
        await host.terminateProcess(allocator, 0);
      }
      host.appendStdinData(rootPid, new TextEncoder().encode("g"));
      expect(await exit, stderr + stdout).toBe(0);
      expect(stdout).toContain("imported cursor after allocator exit: ok");
    } finally {
      if (timer) clearTimeout(timer);
      await host.destroy();
    }
  }, 45_000,
);

it.each(["namespace", "prime"])("preserves the guest DRM file contract (%s)", async mode => {
  const diagnostics: unknown[] = [];
  const host = new NodeKernelHost({
    onHostDiagnostic: diagnostic => diagnostics.push(diagnostic),
  });
  try {
    await host.init();
    const code = await host.spawn(Uint8Array.from(readFileSync(gemFixture.programPath)).buffer,
      ["dri-gem-namespace", mode], {
        uid: 1000, gid: 1000,
        ownedJob: { id: "gem-namespace", timeoutMs: 15_000 },
      });
    let output = await ownedOutput(host, "gem-namespace");
    expect(code, output.stdout + output.stderr).toBe(0);
    await expect.poll(async () => {
      output = await ownedOutput(host, "gem-namespace");
      return output.terminationObserved;
    }, { timeout: 15_000, interval: 10 }).toBe(true);
    expect(output.status).toBe("completed");
    expect(output.exitCode).toBe(0);
    expect(output.stdout).toContain(mode === "prime" ? "prime namespace: ok" : "inherited namespace: ok");
    expect(output.stderr).toBe("");
  } finally {
    await host.destroy();
  }
  expect(diagnostics).toEqual([]);
}, 25_000);

it.each(["master", "cursor"])("retains the inherited KMS file after opener Worker retirement (%s)", async mode => {
  let stdout = "", stderr = "", openerPid = 0, childPid = 0;
  const diagnostics: unknown[] = [];
  let resolveChildExit!: (status: number | undefined) => void;
  const childExit = new Promise<number | undefined>(resolve => { resolveChildExit = resolve; });
  const host = new NodeKernelHost({
    onHostDiagnostic: diagnostic => diagnostics.push(diagnostic),
    onProcessEvent: event => {
      if (event.kind === "exit" && event.pid === childPid) resolveChildExit(event.exitStatus);
    },
  });
  const observeOutput = async () => {
    const output = await ownedOutput(host, "kms-inherited-file");
    stdout = output.stdout;
    stderr = output.stderr;
    const match = stdout.match(/kms-inherited-child=(\d+)/);
    if (match) childPid = Number(match[1]);
    return output;
  };
  try {
    await host.init();
    const openerExit = await host.spawn(Uint8Array.from(readFileSync(inheritedFixture.programPath)).buffer,
      ["dri-kms-inheritance", mode], {
        uid: 1000, gid: 1000,
        ownedJob: { id: "kms-inherited-file", timeoutMs: 15_000 },
        onStarted: pid => { openerPid = pid; },
      });
    await observeOutput();
    expect(openerExit, stdout + stderr).toBe(0);
    expect(childPid).toBeGreaterThan(0);
    await host.terminateProcess(openerPid, 0);
    // Address the originally registered host input stream. That pipe remains
    // live while the orphaned child retains its read end; PPID no longer
    // identifies its source after the opener has been reaped.
    host.appendStdinData(openerPid, new TextEncoder().encode("g"));
    await expect.poll(async () => {
      const output = await observeOutput();
      if (output.status !== "running") {
        throw new Error(`Family ended before ready (${output.status}): ${stdout} ${stderr}`);
      }
      return stdout.includes(`inherited ${mode} after opener retirement: ready`);
    }, { timeout: 15_000, interval: 10 }).toBe(true);
    host.appendStdinData(openerPid, new TextEncoder().encode("q"));
    expect(await childExit, stdout + stderr).toBe(0);
    await host.terminateProcess(childPid, 0);
    await expect.poll(async () => (await observeOutput()).terminationObserved,
      { timeout: 15_000, interval: 10 }).toBe(true);
    expect(stdout).toContain("inherited KMS file: ok");
    expect(stderr).toBe("");
  } finally {
    await host.destroy();
  }
  expect(diagnostics).toEqual([]);
}, 25_000);
