import { readFileSync } from "node:fs";
import { MessageChannel } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import { resolveBinary } from "../src/binary-resolver";
import { NodeKernelHost } from "../src/node-kernel-host";
import { CONNECTED_NAMES_PATH } from "../src/networking/connected-names-file";

// Real production workers and Rust/Wasm VFS, using the normal kernel product.
// No guest Node program or DNS query runs here; those gates remain separate.
const kernelBytes = readFileSync(resolveBinary("kernel.wasm"));
const kernel = () => Uint8Array.from(kernelBytes).buffer;

async function machine(): Promise<NodeKernelHost> {
  const fs = KandeloImageFs.create();
  fs.mkdir("/etc", 0o755);
  fs.writeFile("/etc/hosts", new TextEncoder().encode("127.0.0.1 administrator.test\n"), 0o644);
  return new NodeKernelHost({ maxWorkers: 1, rootfsImage: await fs.saveImage() });
}

async function contents(host: NodeKernelHost): Promise<string> {
  const bytes = await host.readFileFromVfs(CONNECTED_NAMES_PATH);
  expect(bytes).not.toBeNull();
  return new TextDecoder().decode(bytes!);
}

describe("connected names in the Node-host kernel VFS", () => {
  it("publishes before boot readiness and starts a new boot with empty membership", async () => {
    const host = await machine();
    try {
      await host.init(kernel());
      expect(await contents(host)).toBe("");
      const directory = await host.statVfsPath("/run/kandelo");
      expect(directory).toMatchObject({ uid: 0, gid: 0 });
      expect(directory!.mode & 0o7777).toBe(0o755);
      const file = await host.statVfsPath(CONNECTED_NAMES_PATH);
      expect(file).toMatchObject({ uid: 0, gid: 0 });
      expect(file!.mode & 0o7777).toBe(0o644);
      await host.hostRemoteNetwork();
      expect(await contents(host)).toBe("10.89.0.1\thost\n");
      expect(new TextDecoder().decode((await host.readFileFromVfs("/etc/hosts"))!))
        .toBe("127.0.0.1 administrator.test\n");
      await host.destroy();
      await host.init(kernel());
      expect(await contents(host)).toBe("");
      expect((await host.readDirFromVfs("/run/kandelo"))!.map((entry) => entry.name))
        .not.toEqual(expect.arrayContaining([expect.stringMatching(/hosts-connected\.staged-/)]));
    } finally { await host.destroy(); }
  }, 60_000);

  it("publishes actual peer membership and explicit departure before control replies", async () => {
    const host = await machine();
    const peer = await machine();
    try {
      await host.init(kernel());
      await peer.init(kernel());
      await host.hostRemoteNetwork();
      const { port1, port2 } = new MessageChannel();
      const joining = peer.joinRemoteNetwork({ port: port2, maxPayload: 65507, maxControlBytes: 65536 });
      expect(await host.attachRemotePeer({ port: port1, maxPayload: 65507, maxControlBytes: 65536 })).toBe(2);
      expect(await joining).toBe("10.89.0.2");
      const expected = "10.89.0.1\thost\n10.89.0.2\tpeer-2\n";
      expect(await contents(host)).toBe(expected);
      expect(await contents(peer)).toBe(expected);
      await peer.leaveRemoteNetwork();
      expect(await contents(peer)).toBe("");
      await host.leaveRemoteNetwork();
      expect(await contents(host)).toBe("");
    } finally {
      await peer.destroy();
      await host.destroy();
    }
  }, 60_000);
});
