import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { inspectionImage, INSPECTION_MUTATION } from "../../../host/test/support/inspection-image";

test("worker inspection reports native guest writes, mount-crossing links and large directories", async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const kernelUrl = new URL("/inspection-kernel.wasm", baseURL).href;
  const imageUrl = new URL("/inspection.vfs", baseURL).href;
  await page.route(kernelUrl, (route) => route.fulfill({ body: readFileSync(resolveBinary("kernel.wasm")) }));
  const image = await inspectionImage(true);
  await page.route(imageUrl, (route) => route.fulfill({ body: Buffer.from(image) }));
  await page.goto(new URL("/pages/test-runner/?minimal=1", baseURL).href);
  await page.waitForFunction(() => (window as any).__testRunnerReady === true);
  const modulePath = fileURLToPath(new URL("../../../host/src/browser-kernel-host.ts", import.meta.url));
  const result = await page.evaluate(async ({ moduleUrl, kernelUrl, imageUrl, command }) => {
    const { BrowserKernel } = await import(moduleUrl);
    const kernel = new BrowserKernel({ kernelOwnedFs: true });
    try {
      await kernel.initFromImage({
        kernelWasm: await (await fetch(kernelUrl)).arrayBuffer(),
        vfsImage: new Uint8Array(await (await fetch(imageUrl)).arrayBuffer()),
      });
      const base = await kernel.readDirFromVfs("/inspection");
      const followed = await kernel.statVfsPath("/inspection/current");
      const missingDir = await kernel.readDirFromVfs("/missing");
      const missingStat = await kernel.statVfsPath("/missing");
      const large = await kernel.readDirFromVfs("/large");
      const { exit } = await kernel.spawnFromVfs("/usr/bin/bash", ["bash", "-c", command], { env: ["PATH=/bin:/usr/bin"] });
      const status = await exit;
      const changed = await kernel.statVfsPath("/inspection/guest/data");
      const listing = await kernel.readDirFromVfs("/inspection/guest");
      const bytes = await kernel.readFileFromVfs("/inspection/guest/data");
      return { base, followed, missingDir, missingStat, large, status, changed, listing, text: new TextDecoder().decode(bytes) };
    } finally { await kernel.destroy(); }
  }, { moduleUrl: new URL(`/@fs/${modulePath}`, baseURL).href, kernelUrl, imageUrl, command: INSPECTION_MUTATION });
  expect(result.base.find((entry: any) => entry.name === "current")).toMatchObject({ mode: 0o120777, target: "site", uid: 56, gid: 78 });
  expect(result.followed).toMatchObject({ mode: 0o040750, uid: 12, gid: 34 });
  expect(result.missingDir).toBeNull();
  expect(result.missingStat).toBeNull();
  expect(result.large).toHaveLength(800);
  expect(result.large[799].name).toBe(`0799-${"x".repeat(96)}`);
  expect(result.status).toBe(0);
  expect(result.changed).toMatchObject({ mode: 0o100640, uid: 123, gid: 456, size: 16 });
  expect(result.listing).toMatchObject([{ name: "data", uid: 123, gid: 456, size: 16 }]);
  expect(result.text).toBe("live guest bytes");
});


test("worker inspection lists live procfs descriptors and devfs through guest close and exit", async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const kernelUrl = new URL("/inspection-kernel.wasm", baseURL).href;
  const imageUrl = new URL("/inspection.vfs", baseURL).href;
  await page.route(kernelUrl, (route) => route.fulfill({ body: readFileSync(resolveBinary("kernel.wasm")) }));
  await page.route(imageUrl, (route) => route.fulfill({ body: Buffer.from(await inspectionImage()) }));
  await page.goto(new URL("/pages/test-runner/?minimal=1", baseURL).href);
  await page.waitForFunction(() => (window as any).__testRunnerReady === true);
  const modulePath = fileURLToPath(new URL("../../../host/src/browser-kernel-host.ts", import.meta.url));
  const helperPath = fileURLToPath(new URL("../../../host/test/support/virtual-inspection.ts", import.meta.url));
  const result = await page.evaluate(async ({ moduleUrl, helperUrl, kernelUrl, imageUrl }) => {
    const { BrowserKernel } = await import(moduleUrl);
    const { virtualInspection } = await import(helperUrl);
    const kernel = new BrowserKernel({ kernelOwnedFs: true });
    try {
      await kernel.initFromImage({ kernelWasm: await (await fetch(kernelUrl)).arrayBuffer(), vfsImage: new Uint8Array(await (await fetch(imageUrl)).arrayBuffer()) });
      return await virtualInspection(kernel, (pid, listener) => kernel.onPtyOutput(pid, listener));
    } finally { await kernel.destroy(); }
  }, { moduleUrl: new URL(`/@fs/${modulePath}`, baseURL).href, helperUrl: new URL(`/@fs/${helperPath}`, baseURL).href, kernelUrl, imageUrl });
  expect(result.status).toBe(0);
  expect(result.proc!.find((entry) => entry.name === String(result.pid))).toMatchObject({ mode: 0o040555 });
  expect(result.proc!.find((entry) => entry.name === "self")).toMatchObject({ mode: 0o120777, target: "1" });
  expect(result.process!.find((entry) => entry.name === "cwd")).toMatchObject({ mode: 0o120777, target: "/" });
  expect(result.fds!.find((entry) => entry.name === "9")).toMatchObject({ mode: 0o120777, target: "/tmp/inspection-open-fd" });
    expect(result.fds!.length).toBeGreaterThanOrEqual(803);
    expect(result.fds!.find((entry) => entry.name === "809")).toMatchObject({ mode: 0o120777, target: "/tmp/inspection-open-fd" });
    expect(result.fdinfo!.find((entry) => entry.name === "809")!.mode & 0o170000).toBe(0o100000);
  expect(result.fdinfo!.find((entry) => entry.name === "9")!.mode & 0o170000).toBe(0o100000);
  expect(result.closedFds!.some((entry) => entry.name === "9")).toBe(false);
  expect(result.closedInfo!.some((entry) => entry.name === "9")).toBe(false);
  expect(result.initFds).toEqual([]);
  expect(result.devFds).toEqual([]);
  expect(result.dev!.find((entry) => entry.name === "stdin")).toMatchObject({ mode: 0o120777, size: 9, target: "/dev/fd/0" });
  expect(result.dev!.find((entry) => entry.name === "null")!.mode & 0o170000).toBe(0o020000);
  expect(result.input!.map((entry) => entry.name)).toEqual(["mice", "event0", "event1"]);
  expect(result.dri!.map((entry) => entry.name)).toEqual(["card0", "renderD128"]);
  expect(result.kandelo!.map((entry) => entry.name)).toEqual(["clipboard"]);
  expect(result.shm).toEqual([]);
  expect(result.pts!.length).toBe(result.initialPts!.length + 2);
    expect(result.closedPts!.length).toBe(result.initialPts!.length + 1);
    // The host's implicit master remains open until machine destruction.
    // Guest-owned master close must remove only its own live device entry.
  expect(result.finalPts).toEqual(result.closedPts);
  expect(result.finalProc!.some((entry) => entry.name === String(result.pid))).toBe(false);
  expect(result.vanished).toBeNull();
});
