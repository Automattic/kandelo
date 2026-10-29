import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { ABI_SYSCALLS } from "../../../host/src/generated/abi";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";

// The ordinary interactive shell and coreutils, in a small real filesystem.
// The public shell demo is also checked manually; this keeps the regression
// independent of its service tree, gallery and terminal presentation.
test("PTY Ctrl-C interrupts a foreground kernel sleep with status 130", async ({ page, baseURL }) => {
  // Booting bash can take tens of seconds on a loaded machine; only the
  // Ctrl-C response below is timed strictly.
  test.setTimeout(180_000);
  const image = KandeloImageFs.create();
  image.mkdir("/bin", 0o755);
  image.mkdir("/tmp", 0o1777);
  image.writeFile("/bin/bash", readFileSync(resolveBinary("programs/bash.wasm")), 0o755);
  image.writeFile("/bin/sleep", readFileSync(resolveBinary("programs/coreutils.wasm")), 0o755);
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);
  const result = await page.evaluate(async ({ moduleUrl, imageBytes, sleepCalls }) => {
    const { BrowserKernel } = await import(/* @vite-ignore */ moduleUrl);
    let output = "";
    let sleepingPid: number | undefined;
    const exits = new Map<number, number | undefined>();
    const diagnostics: string[] = [];
    const kernel = new BrowserKernel({
      onProcessEvent: (event: { kind: string; pid: number; exitStatus?: number }) => {
        if (event.kind === "exit") exits.set(event.pid, event.exitStatus);
      },
      onHostDiagnostic: (event: { message: string }) => diagnostics.push(event.message),
    });
    const waitUntil = async (condition: () => boolean, timeout = 60_000) => {
      const deadline = performance.now() + timeout;
      while (!condition()) {
        if (performance.now() >= deadline) throw new Error(`PTY wait timed out: ${output}`);
        await new Promise((done) => setTimeout(done, 10));
      }
    };
    try {
      await kernel.initFromImage({ vfsImage: new Uint8Array(imageBytes) });
      const unsubscribe = kernel.subscribeSyscalls((event: { nr: number; pid: number }) => {
        if (sleepCalls.includes(event.nr)) sleepingPid = event.pid;
      });
      const shell = await kernel.spawnFromVfs("/bin/bash", ["bash", "--noprofile", "--norc", "-i"], {
        pty: true,
        env: ["PATH=/bin", "HOME=/", "PS1=INTERRUPT_PROMPT> ", "TERM=dumb"],
      });
      kernel.onPtyOutput(shell.pid, (data: Uint8Array) => { output += new TextDecoder().decode(data); });
      await waitUntil(() => output.includes("INTERRUPT_PROMPT> "));
      output = "";
      kernel.ptyWrite(shell.pid, new TextEncoder().encode("sleep 30\n"));
      // The trace arrives after dispatch, so this observes a parked sleep.
      await waitUntil(() => sleepingPid !== undefined);
      const started = performance.now();
      kernel.ptyWrite(shell.pid, new Uint8Array([3]));
      await waitUntil(() => output.includes("INTERRUPT_PROMPT> "), 1_000);
      const elapsedMs = performance.now() - started;
      await waitUntil(() => exits.get(sleepingPid!) === 130);
      output = "";
      kernel.ptyWrite(shell.pid, new TextEncoder().encode("printf 'INTERRUPT_%s:%s\\n' STATUS \"$?\"\n"));
      await waitUntil(() => output.includes("INTERRUPT_STATUS:130"));
      const transcript = output;
      kernel.ptyWrite(shell.pid, new TextEncoder().encode("exit\n"));
      await shell.exit;
      unsubscribe();
      return { elapsedMs, exitStatus: exits.get(sleepingPid!), transcript, diagnostics };
    } finally {
      await kernel.destroy();
    }
  }, {
    moduleUrl: new URL(`/@fs/${resolve(import.meta.dirname, "../../../host/src/browser-kernel-host.ts")}`, baseURL).href,
    imageBytes: Array.from(await image.saveImage()),
    sleepCalls: [ABI_SYSCALLS.Nanosleep, ABI_SYSCALLS.ClockNanosleep],
  });
  expect(result.elapsedMs).toBeLessThan(1_000);
  expect(result.exitStatus).toBe(130);
  expect(result.transcript).toContain("INTERRUPT_STATUS:130");
  expect(result.diagnostics).toEqual([]);
});
