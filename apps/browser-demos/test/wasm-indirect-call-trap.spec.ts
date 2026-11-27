import { expect, test } from "../playwright-test";
import { resolve } from "node:path";
import { signalExitStatus, SIGILL } from "../../../host/src/trap-signals";
import { indirectCallTrapImage } from "../../../host/test/support/indirect-call-trap-image";

let image: number[];

test.beforeAll(async () => {
  test.setTimeout(240_000);
  image = Array.from(await indirectCallTrapImage());
});

test("records a terminal-only indirect call trap in guest dmesg", async ({ page, baseURL }) => {
  test.setTimeout(90_000);
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);
  const result = await page.evaluate(async ({ moduleUrl, image }) => {
    const browserKernel = await import(/* @vite-ignore */ moduleUrl) as
      typeof import("../../../host/src/browser-kernel-host");
    let log = "";
    const kernel = new browserKernel.BrowserKernel({
      onStdout: (bytes) => { log += new TextDecoder().decode(bytes); },
    });
    try {
      await kernel.initFromImage({ vfsImage: new Uint8Array(image) });
      const probe = "/bin/indirect-call-trap-test";
      const pipe = await kernel.spawnFromVfs(probe, [probe]);
      const pipeStatus = await pipe.exit;
      const tty = await kernel.spawnFromVfs(probe, [probe], { pty: true });
      const ttyStatus = await tty.exit;
      const unreachable = await kernel.spawnFromVfs(probe, [probe, "unreachable"]);
      const unreachableStatus = await unreachable.exit;
      const dmesg = await kernel.spawnFromVfs("/bin/dmesg", ["dmesg", "-r"]);
      const dmesgStatus = await dmesg.exit;
      const rawLog = log;
      const dmesgOnTty = await kernel.spawnFromVfs("/bin/dmesg", ["dmesg"], {
        pty: true, env: ["TERM=xterm"],
      });
      return {
        pipeStatus, ttyStatus, unreachableStatus, dmesgStatus,
        dmesgTtyStatus: await dmesgOnTty.exit, ttyPid: tty.pid, unreachablePid: unreachable.pid, log: rawLog,
      };
    } finally {
      await kernel.destroy();
    }
  }, {
    moduleUrl: new URL(`/@fs/${resolve(import.meta.dirname, "../../../host/src/browser-kernel-host.ts")}`, baseURL).href,
    image,
  });
  expect(result.pipeStatus).toBe(0);
  expect(result.ttyStatus).toBe(signalExitStatus(SIGILL));
  expect(result.unreachableStatus).toBe(signalExitStatus(SIGILL));
  expect(result.dmesgStatus).toBe(0);
  expect(result.dmesgTtyStatus).toBe(0);
  expect(result.log).toMatch(RegExp(
    `process ${result.ttyPid} killed by signal 4 \\(SIGILL\\): Wasm indirect call trap \\((?:null table entry or )?signature mismatch\\)`,
  ));
  expect(result.log.split("Wasm indirect call trap")).toHaveLength(2);
  expect(result.log).toMatch(RegExp(`process ${result.unreachablePid} killed by signal 4 \\(SIGILL\\)$`, "m"));
});
