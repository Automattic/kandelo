import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect, it } from "vitest";
import { NodeKernelHost } from "../src/node-kernel-host";
import { buildKifsGuestFixture, capacityProgram, kifsGuestPath, kifsGuestSuccess } from "./fixtures/kifs-v3-guest";

import { compareSavedShell, requireSavedShellSpeedTarget, savedShellComputer, type ShellBootPhase } from "./fixtures/kifs-saved-shell-workload";
import { readSavedShellPrograms, shellWorkloadCount, stagePartialShell, writeCheckedPartialShell } from "./fixtures/kifs-v3-shell";
import { compareWarmSavedStat } from "./fixtures/kifs-warm-stat-workload";

it("preserves guest file and directory identities across namespace changes and restart on a KIFS v3 Node volume", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kandelo-kifs-v3-guest-"));
  try {
    const fixture = buildKifsGuestFixture(directory);
    const inputs = readSavedShellPrograms(capacityProgram);
    const kernel = Uint8Array.from(inputs.kernel).buffer;
    const snapshot = join(directory, "snapshot.kifs");
    const boot = async (path: string, ...args: string[]) => {
      const output: string[] = [];
      const decoder = new TextDecoder();
      const host = new NodeKernelHost({
        rootfsImageFile: path,
        rootfsLazyAssets: fixture.assets,
        experimentalKifsV3Identity: fixture.identity,
        exchange: { activation: "off" },
        onStdout: (_pid, bytes) => output.push(decoder.decode(bytes)),
        onStderr: (_pid, bytes) => output.push(decoder.decode(bytes)),
      });
      try {
        await host.init(kernel);
        if (args[0] === "snapshot") {
          const exported = await host.exportRootfsImageToFile(snapshot);
          expect(exported.length).toBe(statSync(snapshot).size);
          expect(exported.length).toBeLessThan(statSync(path).size);
          expect(Buffer.from(await host.exportRootfsImage())).toEqual(readFileSync(snapshot));
        } else if (args[0] === "fill") {
          const code = await host.spawn(Uint8Array.from(inputs.guest).buffer,
            ["kifs-capacity", "fill", "/opt"], { uid: 0, gid: 0 });
          expect(code, output.join("")).toBe(0);
        } else {
          const { exit } = await host.spawnFromVfs(kifsGuestPath, [kifsGuestPath, ...args], { uid: 0, gid: 0 });
          const status = await exit;
          expect(status, output.join("")).toBe(0);
        }
      } finally {
        await host.destroy();
      }
      expect(host.getPersistenceShutdownFailure()).toBeNull();
      return output.join("").trim();
    };
    expect(await boot(fixture.path, "fill")).toContain("capacity exhaustion passed");
    const created = await boot(fixture.path, "create");
    expect(created).toContain(kifsGuestSuccess);
    expect(created).toContain("KIFS v3 guest directory descriptors passed");
    const inode = created.match(/^KIFS v3 guest persisted inode ([0-9]+)$/m)?.[1];
    if (inode === undefined) {
      throw new Error(`Missing guest inode from create run: ${created}`);
    }
    await boot(fixture.path, "snapshot");
    for (const path of [snapshot, fixture.path]) {
      expect(await boot(path, "verify", inode)).toBe(`KIFS v3 guest verified attributes of linked inode ${inode}`);
    }
    console.info("KIFS v3 Node guest", { imageSha256: fixture.sha256, imageBytes: fixture.image.length, inode });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 120_000);

const count = shellWorkloadCount();
it.skipIf(count === undefined)("creates small files on a 1 GiB staged package shell and reopens it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kandelo-kifs-shell-"));
  try {
    const fixture = stagePartialShell(directory);
    const initialBytes = statSync(fixture.path).size;
    const inputs = readSavedShellPrograms(capacityProgram);
    const kernel = Uint8Array.from(inputs.kernel).buffer;
    const program = Uint8Array.from(inputs.guest).buffer;
    const snapshot = join(directory, "snapshot.kifs");
    for (const round of ["create", "restart", "snapshot"]) {
      const initial = round === "create";
      const path = round === "snapshot" ? snapshot : fixture.path;
      const decoder = new TextDecoder();
      let output = "";
      const write = (_pid: number, bytes: Uint8Array) => { output += decoder.decode(bytes); };
      const host = new NodeKernelHost({ rootfsImageFile: path, experimentalKifsV3Identity: fixture.identity,
        exchange: { activation: "off" }, onStdout: write, onStderr: write });
      try {
        const start = performance.now();
        await host.init(kernel);
        const bootMs = performance.now() - start;
        const bootPages = await host.getKernelMemoryPages();
        if (round === "restart") {
          const started = performance.now();
          const result = await host.exportRootfsImageToFile(snapshot);
          console.info("KIFS shell snapshot", { bytes: result.length, imageSha256: result.imageSha256,
            compactMs: performance.now() - started, pages: await host.getKernelMemoryPages() });
        }
        const running = performance.now();
        const last = `/home/capacity-test/entry-${String(count! - 1).padStart(8, "0")}`;
        const status = initial
          ? await host.spawn(program, ["kifs-capacity", "entries", "/home", String(count)], { uid: 0, gid: 0 })
          : await (await host.spawnFromVfs("/bin/bash", ["bash", "--noprofile", "--norc", "-c",
            'test -s "$1" && test -s /home/capacity-test/entry-00000000 && echo restart-passed', "bash", last])).exit;
        expect(status, output).toBe(0);
        expect(output).toContain(initial ? `capacity entries=${count} ` : "restart-passed");
        console.info("KIFS shell capacity", { round, source: fixture.identity, initialBytes, output: output.trim(),
          bootMs, bootPages, workloadMs: performance.now() - running, finalPages: await host.getKernelMemoryPages(),
          transportMemory: await host.getStorageMetadataMemoryUsage(), fileBytes: statSync(path).size });
      } finally {
        await host.destroy();
      }
      expect(host.getPersistenceShutdownFailure()).toBeNull();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 40 * 60_000);

it.skipIf(process.env.KANDELO_KIFS_COMPARE !== "1")("compares a saved package shell before and after shared KIFS upgrade", async () => {
  const reverseOrder = process.env.KANDELO_KIFS_V3_FIRST === "1";
  const warmStat = process.env.KANDELO_KIFS_WARM_STAT === "1";
  const requireSpeed = process.env.KANDELO_KIFS_REQUIRE_SPEED_TARGET === "1";
  if (warmStat && requireSpeed) throw new Error("Warm stat diagnostic cannot qualify the saved-shell speed target");
  const directory = mkdtempSync(join(tmpdir(), "kifs-saved-shell-"));
  const controlDirectory = join(directory, basename(directory) + "-control");
  const stateDirectory = (phase: ShellBootPhase) =>
    savedShellComputer(phase) === "control" ? controlDirectory : directory;
  try {
    mkdirSync(controlDirectory);
    const checked = await writeCheckedPartialShell(directory);
    const controlBase = join(controlDirectory, "base.img");
    if (warmStat) copyFileSync(checked.path, controlBase);
    const inputs = readSavedShellPrograms(capacityProgram);
    const kernel = Uint8Array.from(inputs.kernel).buffer;
    const program = Uint8Array.from(inputs.guest).buffer;
    const boot = async (phase: ShellBootPhase, write: (bytes: Uint8Array) => void) => {
      const seeding = phase === "seed" || phase === "seed-control";
      const host = new NodeKernelHost({ rootfsImageFile: warmStat && savedShellComputer(phase) === "control" ? controlBase : checked.path,
        rootfsPersistentImageBinding: { identitySha256: checked.identity, dataCachePages: 1, indexCachePages: 1 },
        experimentalResizablePersistencePath: join(stateDirectory(phase), "computer"),
        requireExistingRootfsPersistence: !seeding, kifsUpgradeProfile: phase === "upgrade" ? "development" : seeding || phase === "legacy" ? "legacy" : undefined,
        exchange: { activation: "off" }, onStdout: (_pid, bytes) => write(bytes), onStderr: (_pid, bytes) => write(bytes) });
      try { await host.init(kernel); return host; }
      catch (error) { await host.destroy(); throw error; }
    };
    const observer = process.env.KANDELO_KIFS_IO_PROFILE === "1" ? (phase: ShellBootPhase) => basename(stateDirectory(phase)) : undefined;
    if (warmStat) {
      const result = await compareWarmSavedStat(program, boot, reverseOrder, observer);
      console.info("KIFS warm saved stat " + JSON.stringify({ source: checked.source, ...inputs.digests, ...result }));
      return;
    }
    const rounds = await compareSavedShell(program, boot, async phase => readdirSync(stateDirectory(phase))
      .filter(name => name === "computer" || name.startsWith("computer.") && !name.endsWith(".lock"))
      .reduce((sum, name) => sum + statSync(join(stateDirectory(phase), name)).size, 0), shellWorkloadCount(), process.memoryUsage.rss,
      observer,
      process.env.KANDELO_KIFS_TMPFS_CONTROL === "1", process.env.KANDELO_KIFS_PROFILE_READS === "1", reverseOrder);
    console.info("KIFS saved shell IO " + JSON.stringify({ source: checked.source, ...inputs.digests, rounds }));
    if (requireSpeed) requireSavedShellSpeedTarget(rounds);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, shellWorkloadCount() === undefined ? 900_000 : 3_600_000);
