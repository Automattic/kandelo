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
const helloWasmPath = resolve(repoRoot, "examples/hello.wasm");
const spawnSmokeWasmPath = resolve(repoRoot, "examples/spawn-smoke.wasm");

test("browser preserves descendant wait/reap and reuses a kernel without retained processes", async ({
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
    async ({ browserKernelUrl, bootHelpersUrl, helloBytes, spawnSmokeBytes }) => {
      const { BrowserKernel } = await import(/* @vite-ignore */ browserKernelUrl);
      const { createEmptyBuildFs, finalizeKernelOwnedImage } = await import(
        /* @vite-ignore */ bootHelpersUrl
      );
      const buildFs = createEmptyBuildFs();
      buildFs.mkdir("/usr", 0o755);
      buildFs.mkdir("/usr/bin", 0o755);
      buildFs.createFileWithOwner(
        "/usr/bin/hello",
        0o755,
        0,
        0,
        new Uint8Array(helloBytes),
      );
      const vfsImage = await finalizeKernelOwnedImage(buildFs);
      const processEvents: Array<{
        kind: "spawn" | "exec" | "exit";
        pid: number;
        ppid?: number;
      }> = [];
      const kernel = new BrowserKernel({
        kernelOwnedFs: true,
        onProcessEvent: (event: {
          kind: "spawn" | "exec" | "exit";
          pid: number;
          ppid?: number;
        }) => processEvents.push(event),
      });

      try {
        await kernel.initFromImage({ vfsImage });
        const launches: Array<{
          exitCode: number;
          pids: number[];
          parentMatches: boolean;
          retainedPids: number[];
        }> = [];

        for (let launch = 0; launch < 2; launch += 1) {
          const eventStart = processEvents.length;
          const exitCode = await kernel.spawn(
            new Uint8Array(spawnSmokeBytes).buffer,
            ["spawn-smoke", "/usr/bin/hello"],
          );
          const launchEvents = processEvents.slice(eventStart);
          const pids = Array.from(new Set(
            launchEvents
              .filter((event) => event.kind === "spawn")
              .map((event) => event.pid),
          ));
          const root = launchEvents.find(
            (event) => event.kind === "spawn" && event.ppid === undefined,
          );
          const child = launchEvents.find(
            (event) => event.kind === "spawn" && event.ppid !== undefined,
          );

          // The exit notification intentionally arrives before asynchronous
          // Worker teardown completes. Poll the authoritative process table,
          // not enumProcs() (which omits Exited entries), until both the
          // host-owned root and its waitpid-consumed guest child are absent.
          const deadline = performance.now() + 5_000;
          let retainedPids = pids;
          while (retainedPids.length > 0 && performance.now() < deadline) {
            retainedPids = [];
            for (const pid of pids) {
              if (await kernel.readProcMaps(pid) !== null) retainedPids.push(pid);
            }
            if (retainedPids.length > 0) {
              await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
            }
          }
          launches.push({
            exitCode,
            pids,
            parentMatches: child?.ppid === root?.pid,
            retainedPids,
          });
        }

        return { launches };
      } finally {
        await kernel.destroy();
      }
    },
    {
      browserKernelUrl: new URL(`/@fs/${browserKernelModulePath}`, baseURL).href,
      bootHelpersUrl: new URL(`/@fs/${kernelBootHelpersModulePath}`, baseURL).href,
      helloBytes: Array.from(readFileSync(helloWasmPath)),
      spawnSmokeBytes: Array.from(readFileSync(spawnSmokeWasmPath)),
    },
  );

  expect(result.launches, runtimeErrors.join("\n")).toHaveLength(2);
  for (const launch of result.launches) {
    expect(launch.exitCode, runtimeErrors.join("\n")).toBe(0);
    expect(launch.pids).toHaveLength(2);
    expect(launch.parentMatches).toBe(true);
    expect(launch.retainedPids).toEqual([]);
  }
  expect(Math.min(...result.launches[1].pids)).toBeGreaterThan(
    Math.max(...result.launches[0].pids),
  );
});
