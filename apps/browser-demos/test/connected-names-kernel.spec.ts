import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "../playwright-test";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";

// Actual browser workers and Rust/Wasm VFS. This does not run guest Node or DNS.
test("native connected-name files follow peer membership and boot lifetime", async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const kernelUrl = new URL("/connected-names-kernel.wasm", baseURL).href;
  const imageUrl = new URL("/connected-names.vfs", baseURL).href;
  const fs = KandeloImageFs.create();
  fs.mkdir("/etc", 0o755);
  fs.writeFile("/etc/hosts", new TextEncoder().encode("127.0.0.1 administrator.test\n"), 0o644);
  const image = await fs.saveImage();
  await page.route(kernelUrl, route => route.fulfill({ body: readFileSync(resolveBinary("kernel.wasm")) }));
  await page.route(imageUrl, route => route.fulfill({ body: Buffer.from(image) }));
  await page.goto(new URL("/pages/test-runner/?minimal=1", baseURL).href);
  await page.waitForFunction(() => (window as any).__testRunnerReady === true);
  const modulePath = fileURLToPath(new URL("../../../host/src/browser-kernel-host.ts", import.meta.url));
  const result = await page.evaluate(async ({ moduleUrl, kernelUrl, imageUrl }) => {
    const { BrowserKernel } = await import(moduleUrl);
    // This small filesystem fixture deliberately uses bounded kernel ceilings.
    const host = new BrowserKernel({ kernelOwnedFs: true, maxWorkers: 1, kernelMaxPages: 4096 });
    const peer = new BrowserKernel({ kernelOwnedFs: true, maxWorkers: 1, kernelMaxPages: 4096 });
    const path = "/run/kandelo/hosts-connected";
    const initialize = async (machine: InstanceType<typeof BrowserKernel>) => machine.initFromImage({
      kernelWasm: await (await fetch(kernelUrl)).arrayBuffer(),
      vfsImage: new Uint8Array(await (await fetch(imageUrl)).arrayBuffer()),
    });
    const read = async (machine: InstanceType<typeof BrowserKernel>) => {
      const bytes = await machine.readFileFromVfs(path);
      if (bytes === null) throw new Error("Connected-name file was not published");
      return new TextDecoder().decode(bytes);
    };
    try {
      await initialize(host); await initialize(peer);
      const initial = await read(host);
      const directory = await host.statVfsPath("/run/kandelo");
      const file = await host.statVfsPath(path);
      await host.hostRemoteNetwork();
      const { port1, port2 } = new MessageChannel();
      const joining = peer.joinRemoteNetwork({ port: port2, maxPayload: 65507, maxControlBytes: 65536 });
      await host.attachRemotePeer({ port: port1, maxPayload: 65507, maxControlBytes: 65536 });
      await joining;
      const joined = [await read(host), await read(peer)];
      const administrator = new TextDecoder().decode(await host.readFileFromVfs("/etc/hosts"));
      await peer.leaveRemoteNetwork();
      await host.leaveRemoteNetwork();
      const departed = [await read(host), await read(peer)];
      await host.destroy();
      await initialize(host);
      return { initial, directory, file, joined, departed, administrator, rebooted: await read(host) };
    } finally {
      try { await peer.destroy(); } finally { await host.destroy(); }
    }
  }, { moduleUrl: new URL(`/@fs/${modulePath}`, baseURL).href, kernelUrl, imageUrl });
  expect(result.initial).toBe("");
  expect(result.directory).toMatchObject({ mode: 0o040755, uid: 0, gid: 0 });
  expect(result.file).toMatchObject({ mode: 0o100644, uid: 0, gid: 0 });
  const joined = "10.89.0.1\thost\n10.89.0.2\tpeer-2\n";
  expect(result.joined).toEqual([joined, joined]);
  expect(result.departed).toEqual(["", ""]);
  expect(result.rebooted).toBe("");
  expect(result.administrator).toBe("127.0.0.1 administrator.test\n");
});
