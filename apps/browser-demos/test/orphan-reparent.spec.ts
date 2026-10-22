import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const browserKernelModulePath = resolve(
  repoRoot,
  "host/src/browser-kernel-host.ts",
);
const kernelBootHelpersModulePath = resolve(
  repoRoot,
  "apps/browser-demos/lib/kernel-owned-boot.ts",
);
const orphanReparentWasmPath = resolve(
  repoRoot,
  "examples/orphan_reparent_test.wasm",
);

test("browser reparents orphans to PID 1, reaps them, and hangs up orphaned stopped groups", async ({
  page,
  baseURL,
  browserName,
}) => {
  test.skip(
    browserName === "webkit",
    "Vite dev module workers are blocked by WebKit COEP; bundled WebKit demos have separate smoke coverage",
  );
  expect(baseURL).toBeTruthy();
  const runtimeErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(message.text());
  });
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);

  const result = await page.evaluate(
    async ({ browserKernelUrl, bootHelpersUrl, programBytes }) => {
      const { BrowserKernel } = await import(/* @vite-ignore */ browserKernelUrl);
      const { createEmptyBuildFs, finalizeKernelOwnedImage } = await import(
        /* @vite-ignore */ bootHelpersUrl
      );
      const vfsImage = await finalizeKernelOwnedImage(await createEmptyBuildFs());
      let stdout = "";
      let stderr = "";
      const decoder = new TextDecoder();
      const kernel = new BrowserKernel({
        kernelOwnedFs: true,
        onStdout: (data: Uint8Array) => {
          stdout += decoder.decode(data, { stream: true });
        },
        onStderr: (data: Uint8Array) => {
          stderr += new TextDecoder().decode(data);
        },
      });

      try {
        await kernel.initFromImage({ vfsImage });
        let rootPid = 0;
        const exit: Promise<number> = kernel.spawn(
          new Uint8Array(programBytes).buffer,
          ["orphan_reparent_test", "--hold"],
          {
            onStarted(pid: number) {
              rootPid = pid;
            },
          },
        );

        let earlyExit: number | undefined;
        void exit.then((status) => {
          earlyExit = status;
        });
        // A failed guest check exits instead of holding.
        const deadline = performance.now() + 20_000;
        while (
          !/HOLD \d+ \d+ \d+/.test(stdout)
          && earlyExit === undefined
          && performance.now() < deadline
        ) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
        }
        const hold = stdout.match(/HOLD (\d+) (\d+) (\d+)/);
        if (!hold) {
          return { stdout, stderr: `exit ${earlyExit}: ${stderr}`, held: false };
        }

        // Proc maps stay addressable until Rust releases a process record,
        // including an Exited zombie that enumProcs() hides. These are the
        // daemon grandchild, the adopted zombie, and the group member the
        // default SIGHUP action terminated.
        const retainedAdopted: number[] = [];
        for (const pid of hold.slice(1).map(Number)) {
          if (await kernel.readProcMaps(pid) !== null) retainedAdopted.push(pid);
        }
        const processes: Array<{ pid: number; ppid: number }> =
          await kernel.enumProcs();
        const pids = new Set(processes.map((process) => process.pid));
        const danglingParents = processes
          .filter((process) =>
            process.ppid !== 0 && process.ppid !== 1 && !pids.has(process.ppid)
          )
          .map((process) => `${process.pid}->${process.ppid}`);

        kernel.setStdinData(rootPid, new Uint8Array());
        const exitCode = await exit;
        return {
          stdout,
          stderr,
          held: true,
          retainedAdopted,
          rootListed: pids.has(rootPid),
          danglingParents,
          exitCode,
        };
      } finally {
        await kernel.destroy();
      }
    },
    {
      browserKernelUrl: new URL(`/@fs/${browserKernelModulePath}`, baseURL).href,
      bootHelpersUrl: new URL(`/@fs/${kernelBootHelpersModulePath}`, baseURL).href,
      programBytes: Array.from(readFileSync(orphanReparentWasmPath)),
    },
  );

  const context = [result.stderr, ...runtimeErrors].join("\n");
  expect(result.held, context).toBe(true);
  expect(result.stdout, context).toContain("PASS: ORPHAN_REPARENT");
  expect(result.stdout).toMatch(/DAEMON_GRANDCHILD \d+ PPID 1\n/);
  expect(result.stdout).toContain("ORPHANED_GROUP_SIGHUP");
  expect(result.retainedAdopted).toEqual([]);
  expect(result.rootListed).toBe(true);
  expect(result.danglingParents).toEqual([]);
  expect(result.exitCode, context).toBe(0);
  expect(result.stderr).toBe("");
});
