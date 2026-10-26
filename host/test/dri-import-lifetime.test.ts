import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { NodeKernelHost } from "../src/node-kernel-host";
import { compileSdkFixture } from "./support/compile-sdk-fixture";

let fixture: ReturnType<typeof compileSdkFixture>;
let gemFixture: ReturnType<typeof compileSdkFixture>;
beforeAll(() => {
  fixture = compileSdkFixture(new URL("./fixtures/kms-import-lifetime.c", import.meta.url), [], {
    forkInstrument: true,
  });
  gemFixture = compileSdkFixture(new URL("./fixtures/dri-gem-namespace.c", import.meta.url), [], {
    forkInstrument: true,
  });
}, 120_000);
afterAll(() => { fixture?.cleanup(); gemFixture?.cleanup(); });

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
          ownedJob: { id: "cursor-import", timeoutMs: 30_000 },
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
  let stdout = "", stderr = "";
  const diagnostics: unknown[] = [];
  const host = new NodeKernelHost({
    onStdout: (_pid, data) => { stdout += new TextDecoder().decode(data); },
    onStderr: (_pid, data) => { stderr += new TextDecoder().decode(data); },
    onHostDiagnostic: diagnostic => diagnostics.push(diagnostic),
  });
  try {
    await host.init();
    const code = await host.spawn(Uint8Array.from(readFileSync(gemFixture.programPath)).buffer,
      ["dri-gem-namespace", mode], {
        uid: 1000, gid: 1000,
        ownedJob: { id: "gem-namespace", timeoutMs: 15_000 },
      });
    expect(code, stdout + stderr).toBe(0);
    expect(stdout).toContain(mode === "prime" ? "prime namespace: ok" : "inherited namespace: ok");
    expect(stderr).toBe("");
  } finally {
    await host.destroy();
  }
  expect(diagnostics).toEqual([]);
}, 25_000);
