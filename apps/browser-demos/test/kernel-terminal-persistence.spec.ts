import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { ABI_SYSCALLS } from "../../../host/src/generated/abi";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";

for (const { stopped, resume } of [
  { stopped: false, resume: false },
  { stopped: true, resume: false },
  { stopped: false, resume: true },
]) {
  test(`persistent shutdown retires a ${stopped ? "stopped" : "sleeping"} daemon${resume ? " after audio activation" : ""} and permits strict recovery`, async ({ playwright, browserName, baseURL }, testInfo) => {
    test.setTimeout(90_000);
    const filesystem = KandeloImageFs.create();
    filesystem.setImageCapacity(8 * 1024 * 1024);
    filesystem.writeFile("/state", new TextEncoder().encode("before"));
    const image = await filesystem.saveImage();
    const projectUse = testInfo.project.use;
    const profile = mkdtempSync(join(tmpdir(), "kandelo-terminal-persistence-"));
    try {
      const context = await playwright[browserName].launchPersistentContext(profile, {
        channel: projectUse.channel,
        proxy: projectUse.proxy,
        extraHTTPHeaders: projectUse.extraHTTPHeaders,
        ...(projectUse.launchOptions ?? {}),
      });
      try {
        const page = context.pages()[0] ?? await context.newPage();
        const kernelUrl = new URL("/terminal-persistence-kernel.wasm", baseURL).href;
        const programUrl = new URL("/terminal-persistence-daemon.wasm", baseURL).href;
        const imageUrl = new URL("/terminal-persistence.vfs", baseURL).href;
        await page.route(kernelUrl, route => route.fulfill({ body: readFileSync(resolveBinary("kernel.wasm")) }));
        await page.route(programUrl, route => route.fulfill({ body: readFileSync(resolveBinary("programs/wasm32/coreutils.wasm")) }));
        await page.route(imageUrl, route => route.fulfill({ body: Buffer.from(image) }));
        await page.goto(new URL("/trap-signal-test.html", baseURL).href);
        const hostPath = fileURLToPath(new URL("../../../host/src/browser-kernel-host.ts", import.meta.url));
        await page.evaluate(async ({ hostUrl, kernelUrl, programUrl, imageUrl, sleepingSyscalls }) => {
          const { BrowserKernel } = await import(hostUrl);
          const diagnostics: string[] = [];
          const exits: number[] = [];
          const audioFailures: string[] = [];
          let sleeping = false;
          let pid = -1;
          const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("kandelo-persistent-overlay", { create: true });
          const name = `terminal-persistence-${crypto.randomUUID()}`;
          const imageFile = await directory.getFileHandle(`${name}.base`, { create: true });
          const writer = await imageFile.createWritable();
          await writer.write(await (await fetch(imageUrl)).arrayBuffer());
          await writer.close();
          const kernelWasm = await (await fetch(kernelUrl)).arrayBuffer();
          const boot = async (requireExisting: boolean) => {
            const kernel = new BrowserKernel({
              kernelOwnedFs: true,
              maxWorkers: 4,
              onHostDiagnostic: (event: { message: string }) => diagnostics.push(event.message),
              onProcessEvent: (event: { kind: string; exitStatus?: number }) => {
                if (event.kind === "exit") exits.push(event.exitStatus ?? -1);
              },
            });
            try {
              await kernel.initFromOpfsImage({ kernelWasm, vfsImageFile: imageFile,
                experimentalResizablePersistenceName: name, persistentComputerName: name,
                requireExistingRootfsPersistence: requireExisting });
              return kernel;
            } catch (error) {
              await kernel.destroy();
              throw error;
            }
          };
          const kernel = await boot(false);
          (window as any).__terminalPersistence = {
            snapshot: () => ({ sleeping, pid, exits, diagnostics, audioFailures, audioState: kernel.getAudioState() }),
            stop: () => kernel.signalProcess(pid, 19),
            processes: () => kernel.enumProcs(),
            destroy: () => kernel.destroy(),
            async recover() {
              const recovered = await boot(true);
              try {
                return new TextDecoder().decode(await recovered.readFileFromVfs("/state"));
              } finally {
                await recovered.destroy();
              }
            },
          };
          const activateAudio = document.createElement("button");
          activateAudio.textContent = "Activate test audio";
          activateAudio.onclick = () => {
            void kernel.resumeAudio().catch((error: Error) => audioFailures.push(error.message));
          };
          document.body.append(activateAudio);
          await kernel.writeFileToVfs("/state", new TextEncoder().encode("accepted before shutdown"));
          kernel.subscribeSyscalls((event: { nr: number }) => {
            if (sleepingSyscalls.includes(event.nr)) sleeping = true;
          });
          void kernel.spawn(await (await fetch(programUrl)).arrayBuffer(), ["sleep", "1000000"], {
            onStarted: (value: number) => { pid = value; },
          }).catch((error: Error) => diagnostics.push(error.message));
        }, {
          hostUrl: new URL(`/@fs/${hostPath}`, baseURL).href,
          kernelUrl, programUrl, imageUrl,
          sleepingSyscalls: [ABI_SYSCALLS.Nanosleep, ABI_SYSCALLS.ClockNanosleep],
        });
        try {
          await expect.poll(() => page.evaluate(() => (window as any).__terminalPersistence.snapshot()), { timeout: 15_000 })
            .toMatchObject({ sleeping: true });
          if (resume) {
            await page.getByRole("button", { name: "Activate test audio", exact: true }).click();
            if (browserName !== "firefox" || process.platform !== "darwin") {
              await expect.poll(() => page.evaluate(() => (window as any).__terminalPersistence.snapshot().audioState))
                .toBe("running");
            }
          }
          if (stopped) {
            expect(await page.evaluate(() => (window as any).__terminalPersistence.stop())).toBe(true);
            await expect.poll(() => page.evaluate(async () => {
              const state = (window as any).__terminalPersistence;
              return (await state.processes()).find((entry: { pid: number }) => entry.pid === state.snapshot().pid)?.state;
            })).toBe("T");
          }
          await page.evaluate(() => (window as any).__terminalPersistence.destroy());
          const afterShutdown = await page.evaluate(() => (window as any).__terminalPersistence.snapshot());
          expect(afterShutdown.exits).toEqual([137]);
          expect(afterShutdown.diagnostics.every((message: string) => message.includes("PCM audio context is quarantined"))).toBe(true);
          if (resume && browserName === "firefox" && process.platform === "darwin") {
            expect(afterShutdown.diagnostics.some((message: string) => message.includes("PCM audio context is quarantined"))).toBe(true);
          } else {
            expect(afterShutdown.diagnostics).toEqual([]);
          }
          await page.route(imageUrl, route => route.abort("failed"));
          expect(await page.evaluate(() => (window as any).__terminalPersistence.recover()))
            .toBe("accepted before shutdown");
          const afterRecovery = await page.evaluate(() => (window as any).__terminalPersistence.snapshot());
          expect(afterRecovery.exits).toEqual([137]);
          expect(afterRecovery.diagnostics.every((message: string) => message.includes("PCM audio context is quarantined"))).toBe(true);
          expect(afterRecovery.audioFailures.every((message: string) => message === "PCM output is closed")).toBe(true);
        } finally {
          await page.evaluate(() => (window as any).__terminalPersistence?.destroy());
        }
      } finally {
        await context.close();
      }
    } finally {
      rmSync(profile, { recursive: true, force: true });
    }
  });
}
