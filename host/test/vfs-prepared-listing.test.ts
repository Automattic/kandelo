import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NodeKernelHost } from "../src/node-kernel-host";
import { inspectionImage, INSPECTION_MUTATION } from "./support/inspection-image";

const hosts: NodeKernelHost[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.destroy();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function machine(large = false, foreign = false): Promise<NodeKernelHost> {
  let extraMounts: Array<{ mountPoint: string; hostPath: string }> | undefined;
  if (foreign) {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-inspection-foreign-"));
    directories.push(directory);
    writeFileSync(join(directory, "data"), "foreign bytes");
    extraMounts = [{ mountPoint: "/foreign", hostPath: directory }];
  }
  const host = new NodeKernelHost({ rootfsImage: await inspectionImage(large), extraMounts });
  hosts.push(host);
  await host.init();
  return host;
}

describe("worker-side VFS listing and stat", () => {
  it("lists entries without following symlinks, and reports targets and real owners", async () => {
    const host = await machine();
    const entries = await host.readDirFromVfs("/inspection");
    const byName = new Map(entries!.map((entry) => [entry.name, entry]));
    expect([...byName.keys()].sort()).toEqual(["current", "foreign", "index.html", "site"]);
    expect(byName.get("site")).toMatchObject({ mode: 0o040750, uid: 12, gid: 34 });
    expect(byName.get("index.html")).toMatchObject({ mode: 0o100644, size: 5 });
    expect(byName.get("current")).toMatchObject({ mode: 0o120777, uid: 56, gid: 78, target: "site" });
    expect(byName.get("site")!.target).toBeUndefined();
  }, 60_000);

  it("stats through a symlink, unlike a listing entry", async () => {
    const host = await machine();
    await expect(host.statVfsPath("/inspection/current")).resolves.toMatchObject({ mode: 0o040750, uid: 12, gid: 34 });
    await expect(host.statVfsPath("/inspection/index.html")).resolves.toMatchObject({ size: 5, uid: 0, gid: 0 });
  }, 60_000);

  it("answers a missing path with null instead of an empty listing or zero stat", async () => {
    const host = await machine();
    await expect(host.readDirFromVfs("/absent")).resolves.toBeNull();
    await expect(host.statVfsPath("/absent")).resolves.toBeNull();
    await expect(host.readDirFromVfs("/inspection/index.html/child")).resolves.toBeNull();
  }, 60_000);

  it("inspects guest writes through symlinks crossing into native scratch mounts", async () => {
    const host = await machine();
    const { exit } = await host.spawnFromVfs("/usr/bin/bash", ["bash", "-c", INSPECTION_MUTATION], { env: ["PATH=/bin:/usr/bin"] });
    expect(await exit).toBe(0);
    await expect(host.statVfsPath("/inspection/guest/data")).resolves.toMatchObject({ mode: 0o100640, uid: 123, gid: 456, size: 16 });
    const entries = await host.readDirFromVfs("/inspection/guest");
    expect(entries).toMatchObject([{ name: "data", uid: 123, gid: 456, size: 16 }]);
    expect(new TextDecoder().decode((await host.readFileFromVfs("/inspection/guest/data"))!)).toBe("live guest bytes");
  }, 60_000);

  it("inspects a foreign mount through the kernel namespace, including a link into it", async () => {
    const host = await machine(false, true);
    expect((await host.readDirFromVfs("/inspection/foreign"))?.map((entry) => entry.name)).toEqual(["data"]);
    await expect(host.statVfsPath("/inspection/foreign/data")).resolves.toMatchObject({ size: 13 });
    expect(new TextDecoder().decode((await host.readFileFromVfs("/inspection/foreign/data"))!)).toBe("foreign bytes");
  }, 60_000);

  it("streams directory metadata larger than one kernel scratch lease", async () => {
    const host = await machine(true);
    const entries = await host.readDirFromVfs("/large");
    expect(entries).toHaveLength(800);
    expect(entries![0].name).toBe(`0000-${"x".repeat(96)}`);
    expect(entries![799].name).toBe(`0799-${"x".repeat(96)}`);
    expect(entries!.every(({ size, mode }) => size === 1 && mode === 0o100644)).toBe(true);
    await expect(host.readDirFromVfs("/inspection/site")).resolves.toEqual([]);
    expect((await host.readDirFromVfs("/large"))?.length).toBe(800);
  }, 60_000);
});
