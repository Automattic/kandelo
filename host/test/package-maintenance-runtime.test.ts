import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import { resolveBinary } from "../src/binary-resolver";
import { ERRNO, PACKAGE_MAINTENANCE_WIRE as wire } from "../src/generated/abi";
import { NodeKernelHost } from "../src/node-kernel-host";
import { PackageMaintenanceError } from "../src/package-maintenance";
import { softwareImage } from "./fixtures/package-upgrade-image";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function verify(host: NodeKernelHost, action: "verifyInstalled" | "verifyStaged") {
  for (let step = 0; step < 1000; step++) {
    if ((await host.packageMaintenance({ action, index: 64 * 1024 })).status === 1) return;
  }
  throw new Error(`${action} did not finish within the fixture bound`);
}

async function stage(host: NodeKernelHost, bodies: ReadonlyMap<string, Uint8Array>) {
  const progress = (await host.packageMaintenance({ action: "progress" })).data;
  const count = new DataView(progress.buffer).getUint32(wire.PROGRESS_FILE_COUNT_OFFSET, true);
  for (let index = 0; index < count; index++) {
    const result = (await host.packageMaintenance({ action: "stagingFile", index })).data;
    const view = new DataView(result.buffer);
    const kind = view.getUint32(wire.STAGING_KIND_OFFSET, true);
    if (kind === wire.STAGING_REMOVED) continue;
    if (kind === wire.STAGING_KERNEL) {
      await host.packageMaintenance({ action: "stage", index });
      continue;
    }
    const path = decoder.decode(result.subarray(wire.STAGING_HEADER_BYTES));
    const body = bodies.get(path);
    if (!body) throw new Error(`Missing fixture package bytes: ${path}`);
    await host.packageMaintenance({ action: "restartStagingFile", index });
    for (let offset = 0; offset < body.length || offset === 0; offset += 64 * 1024) {
      await host.packageMaintenance({ action: "stage", index, offset, data: body.subarray(offset, offset + 64 * 1024) });
    }
  }
}

async function image(): Promise<Uint8Array> {
  const filesystem = KandeloImageFs.create();
  filesystem.mkdir("/user", 0o755);
  filesystem.writeFile("/user/notes", encoder.encode("keep this user data"), 0o644);
  return filesystem.saveImage();
}

async function boot(bytes: Uint8Array, journal?: string, existing = false): Promise<NodeKernelHost> {
  const host = new NodeKernelHost({ rootfsImage: bytes,
    ...(journal === undefined ? {} : { experimentalResizablePersistencePath: journal, requireExistingRootfsPersistence: existing }),
  });
  const kernel = readFileSync(resolveBinary("kernel.wasm"));
  try {
    await host.init(Uint8Array.from(kernel).buffer);
    return host;
  } catch (error) {
    await host.destroy();
    throw error;
  }
}

describe("real Node maintenance transport", () => {
  it("upgrades a producer-owned set after interruption, retains lazy bindings and user data, and rolls back", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-package-upgrade-"));
    const journal = join(directory, "journal");
    let host: NodeKernelHost | undefined;
    const lazyRequests: string[] = [];
    const server = createServer((request, response) => {
      lazyRequests.push(request.url ?? "");
      const body = encoder.encode("lazy package 2");
      response.writeHead(request.url === "/program-2" ? 200 : 404, { "Content-Length": body.length });
      response.end(body);
    });
    try {
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
      const before = await softwareImage(1, origin);
      const after = await softwareImage(2, origin);
      host = await boot(before.bytes, journal);
      await host.writeFileToVfs("/user/notes", encoder.encode("my retained data"));
      await host.writeFileToVfs("/software/config", encoder.encode("my unchanged-upstream config"));
      await host.packageMaintenance({ action: "enter" });
      await host.packageMaintenance({ action: "uploadInventory", data: after.inventory });
      await host.packageMaintenance({ action: "begin" });
      await verify(host, "verifyInstalled");
      await host.packageMaintenance({ action: "prepare" });
      expect((await host.packageMaintenance({ action: "recovery" })).status).toBe(wire.RECOVERY_PENDING);
      await expect(host.packageMaintenance({ action: "leave" })).rejects.toBeInstanceOf(PackageMaintenanceError);
      await host.destroy();
      host = await boot(before.bytes, journal, true);
      expect(await host.readFileFromVfs("/software/tool")).toEqual(before.bodies.get("/software/tool"));
      await host.packageMaintenance({ action: "enter" });
      await host.packageMaintenance({ action: "resume" });
      await verify(host, "verifyInstalled");
      await stage(host, after.bodies);
      await verify(host, "verifyStaged");
      await host.packageMaintenance({ action: "commit" });
      await host.packageMaintenance({ action: "cancel" });
      await host.packageMaintenance({ action: "leave" });
      expect(await host.readFileFromVfs("/software/lazy")).toEqual(after.lazy);
      await host.writeFileToVfs("/software/new/sub/user", encoder.encode("new user child"));
      await host.destroy();
      host = await boot(before.bytes, journal, true);
      expect(await host.readFileFromVfs("/software/tool")).toEqual(after.bodies.get("/software/tool"));
      expect(await host.readFileFromVfs("/software/remove")).toBeNull();
      expect(await host.readFileFromVfs("/var/lib/kandelo/packages/installed")).toEqual(after.inventory);
      const upgraded = KandeloImageFs.create();
      upgraded.loadImage(await host.exportRootfsImage());
      const lazy = upgraded.lazyEntries().files.find(file => file.path === "/software/lazy");
      expect(lazy?.uri).toBe(after.lazyUri);
      expect(await host.readFileFromVfs("/software/lazy")).toEqual(after.lazy);
      await host.packageMaintenance({ action: "enter" });
      await host.packageMaintenance({ action: "resume" });
      await verify(host, "verifyInstalled");
      await verify(host, "verifyStaged");
      await host.packageMaintenance({ action: "commit" });
      await host.packageMaintenance({ action: "cancel" });
      await host.packageMaintenance({ action: "leave" });
      await host.destroy();
      host = await boot(before.bytes, journal, true);
      expect(await host.readFileFromVfs("/software/tool")).toEqual(before.bodies.get("/software/tool"));
      expect(await host.readFileFromVfs("/software/remove")).toEqual(before.bodies.get("/software/remove"));
      expect(await host.readFileFromVfs("/var/lib/kandelo/packages/installed")).toEqual(before.inventory);
      expect(await host.readFileFromVfs("/software/new/sub/user")).toEqual(encoder.encode("new user child"));
      expect(await host.readFileFromVfs("/software/config")).toEqual(encoder.encode("my unchanged-upstream config"));
      expect(await host.readFileFromVfs("/user/notes")).toEqual(encoder.encode("my retained data"));
      expect(lazyRequests.length).toBeGreaterThan(0);
      expect(lazyRequests.every(url => url === "/program-2")).toBe(true);
    } finally {
      await host?.destroy();
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses an edited package file without changing package or user data", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-package-conflict-"));
    let host: NodeKernelHost | undefined;
    try {
      const before = await softwareImage(1);
      const after = await softwareImage(2);
      host = await boot(before.bytes, join(directory, "journal"));
      await host.writeFileToVfs("/software/tool", encoder.encode("user-edited program"));
      await host.packageMaintenance({ action: "enter" });
      await host.packageMaintenance({ action: "uploadInventory", data: after.inventory });
      await host.packageMaintenance({ action: "begin" });
      await expect(verify(host, "verifyInstalled")).rejects.toBeInstanceOf(PackageMaintenanceError);
      await host.packageMaintenance({ action: "cancel" });
      await host.packageMaintenance({ action: "leave" });
      expect(await host.readFileFromVfs("/software/tool")).toEqual(encoder.encode("user-edited program"));
      expect(await host.readFileFromVfs("/var/lib/kandelo/packages/installed")).toEqual(before.inventory);
      expect(await host.readFileFromVfs("/user/notes")).toEqual(encoder.encode("user data"));
    } finally {
      await host?.destroy();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses unsupported nonpersistent maintenance without creating a session", async () => {
    const host = await boot(await image());
    try {
      await expect(host.packageMaintenance({ action: "enter" })).rejects.toMatchObject({ errno: ERRNO.EOPNOTSUPP });
      await expect(host.packageMaintenance({ action: "progress" })).rejects.toMatchObject({ errno: ERRNO.EPERM });
      expect(await host.readFileFromVfs("/user/notes")).toEqual(encoder.encode("keep this user data"));
    } finally { await host.destroy(); }
  });

  it("binds the current kernel contract and preserves unmanaged data across refusal and persistent reopen", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-maintenance-runtime-"));
    const journal = join(directory, "journal");
    let host: NodeKernelHost | undefined;
    try {
      const bytes = await image();
      host = await boot(bytes, journal);
      expect((await host.packageMaintenance({ action: "enter" })).status).toBe(0);
      const progress = await host.packageMaintenance({ action: "progress" });
      expect(progress.status).toBe(wire.PROGRESS_HEADER_BYTES);
      expect(progress.data.byteLength).toBe(wire.PROGRESS_HEADER_BYTES);
      expect(new DataView(progress.data.buffer).getUint32(wire.PROGRESS_VERSION_OFFSET, true)).toBe(wire.VERSION);
      await expect(host.packageMaintenance({ action: "enter" })).rejects.toBeInstanceOf(PackageMaintenanceError);
      expect((await host.packageMaintenance({ action: "recovery" })).status).toBe(wire.RECOVERY_NONE);
      await expect(host.packageMaintenance({ action: "begin" })).rejects.toMatchObject({ errno: ERRNO.ENOENT });
      expect(await host.readFileFromVfs("/user/notes")).toEqual(encoder.encode("keep this user data"));
      await host.destroy();
      host = await boot(bytes, journal, true);
      expect(await host.readFileFromVfs("/user/notes")).toEqual(encoder.encode("keep this user data"));
      expect((await host.packageMaintenance({ action: "enter" })).status).toBe(0);
      expect((await host.packageMaintenance({ action: "recovery" })).status).toBe(wire.RECOVERY_NONE);
    } finally {
      await host?.destroy();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
