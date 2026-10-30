import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { persistentBaseFixture, preparePersistentBaseFixtures } from "./fixtures/persistent-base-image";
import { NodeKernelHost } from "../src/node-kernel-host";
import type { PersistentImageReadBinding } from "../src/vfs/image-integrity";
import { resolveBinary } from "../src/binary-resolver";

const kernelPath = resolveBinary("kernel.wasm");

beforeAll(() => preparePersistentBaseFixtures(), 180_000);

async function boot(path: string, binding: PersistentImageReadBinding, journal: string, requireExisting = false): Promise<NodeKernelHost> {
  const host = new NodeKernelHost({
    rootfsImageFile: path, rootfsPersistentImageBinding: binding,
    experimentalResizablePersistencePath: journal,
    requireExistingRootfsPersistence: requireExisting,
  });
  try {
    const kernel = readFileSync(kernelPath);
    await host.init(kernel.buffer.slice(kernel.byteOffset, kernel.byteOffset + kernel.byteLength) as ArrayBuffer);
    return host;
  } catch (error) {
    await host.destroy();
    throw error;
  }
}

describe("Rust-verified persistent base through a real Node kernel worker", () => {
  it("reopens home and service files from the journal with their image-owned directories", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-persistent-homes-"));
    const paths = ["/home/maker/state", "/root/state", "/srv/state"];
    try {
      const { path, binding } = await persistentBaseFixture(directory, "crc32c");
      const journal = join(directory, "computer.journal");
      const committed = join(directory, "committed.journal");
      const first = await boot(path, binding, journal);
      try {
        for (const target of paths) await first.writeFileToVfs(target, new TextEncoder().encode(target), 0o600);
        copyFileSync(journal, committed);
      } finally { await first.destroy(); }
      const reopened = await boot(path, binding, committed, true);
      try {
        for (const target of paths) expect(new TextDecoder().decode((await reopened.readFileFromVfs(target))!)).toBe(target);
        expect((await reopened.statVfsPath("/home/maker"))!.uid).toBe(1000);
        expect((await reopened.statVfsPath("/root"))!.mode & 0o7777).toBe(0o700);
      } finally { await reopened.destroy(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 90000);

  it.each([0, 17, 4196020])("makes acknowledged host file writes durable before shutdown (%i bytes)", async length => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-host-file-publication-"));
    const journal = join(directory, "computer.journal");
    const committedJournal = join(directory, "committed.journal");
    const bytes = Uint8Array.from({ length }, (_, offset) => (offset * 17 + Math.floor(offset / 4096)) & 255);
    const digest = createHash("sha256").update(bytes).digest("hex");
    try {
      const { path, binding } = await persistentBaseFixture(directory, "crc32c", 0, undefined, 64 * 1024 * 1024);
      const first = await boot(path, binding, journal);
      try {
        await first.writeFileToVfs("/published", bytes, 0o640);
        expect(createHash("sha256").update((await first.readFileFromVfs("/published"))!).digest("hex")).toBe(digest);
        copyFileSync(journal, committedJournal);
      } finally { await first.destroy(); }
      const reopened = await boot(path, binding, committedJournal, true);
      try {
        const actual = await reopened.readFileFromVfs("/published");
        expect(actual?.byteLength).toBe(length);
        expect(createHash("sha256").update(actual!).digest("hex")).toBe(digest);
        expect((await reopened.statVfsPath("/published"))!.mode & 0o7777).toBe(0o640);
      } finally { await reopened.destroy(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 90000);

  it.each(["crc32c", "sha256"] as const)("boots and replays a resizable journal with %s checking", async policy => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-verified-base-"));
    try {
      const { path, binding, content } = await persistentBaseFixture(directory, policy);
      const journal = join(directory, "journal");
      const first = await boot(path, binding, journal);
      try {
        expect(new TextDecoder().decode((await first.readFileFromVfs("/link"))!)).toBe("original");
        expect(await first.readFileFromVfs("/large")).toEqual(content);
        await first.writeFileToVfs("/state", new TextEncoder().encode("persisted"), 0o640);
      } finally { await first.destroy(); }
      const second = await boot(path, binding, journal, true);
      try {
        expect(new TextDecoder().decode((await second.readFileFromVfs("/link"))!)).toBe("persisted");
        expect(await second.readFileFromVfs("/large")).toEqual(content);
      } finally { await second.destroy(); }
      const wrong = { ...binding, identitySha256: (binding.identitySha256[0] === "0" ? "1" : "0") + binding.identitySha256.slice(1) };
      const savedJournal = readFileSync(journal);
      await expect(boot(path, wrong, journal, true)).rejects.toThrow();
      expect(readFileSync(journal)).toEqual(savedJournal);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 180_000);
});
