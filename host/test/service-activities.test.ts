import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import { copyImageTree, installServiceActivities } from "../../images/vfs/scripts/service-activities";
import { ensureDirRecursive, writeVfsFile } from "../../images/vfs/scripts/vfs-image-helpers";

const decode = (fs: KandeloImageFs, path: string) => new TextDecoder().decode(fs.readFile(path));

describe("image-owned service activities", () => {
  it("keeps the supervisor independent and separates current service state from boot enablement", () => {
    const fs = KandeloImageFs.create();
    ensureDirRecursive(fs, "/etc/dinit.d");
    writeVfsFile(fs, "/etc/dinit.d/web-php", "type = internal\n");
    installServiceActivities(fs, [{ target: "web-php", port: 8080 }], new Uint8Array([0]));
    expect(decode(fs, "/etc/dinit.d/machine")).toBe("type = internal\nrestart = false\n");
    expect(decode(fs, "/sbin/kandelo-init")).toContain("/sbin/dinit --container -p /run/kandelo-services/dinitctl machine");
    expect(fs.stat("/usr/local/bin/kandelo-service").mode & 0o7777).toBe(0o4755);
    const script = decode(fs, "/usr/local/libexec/kandelo-service");
    expect(script).toContain("control stop --ignore-unstarted");
    expect(script).toContain("control is-started");
    expect(script).toContain('control start "$other" || echo');
    expect(script).toContain("mv /etc/kandelo/enabled-service.pending /etc/kandelo/enabled-service");
    expect(script).toContain("Unknown service activity");
    expect(script).toContain("snapshot=$(control list)");
    expect(script).toContain('"ACTIVITY", "STATE", "NEXT BOOT"');
    expect(script).toContain('"not-loaded"');
    expect(script).toContain('"starting"');
    expect(script).toContain('"stopping"');
    expect(script).toContain('"failed"');
    expect(JSON.parse(decode(fs, "/etc/kandelo/services.json"))).toEqual({ version: 1, services: [{ id: "web-php", title: "web-php", port: 8080 }] });
  });
  it.each(["../bad", "-shutdown", "bad;reboot", ""]) ("refuses invalid target %j", target => {
    expect(() => installServiceActivities(KandeloImageFs.create(), [{ target, port: 8080 }], new Uint8Array([0]))).toThrow();
  });
  it("reports supervisor transitions, failure and unloaded activities without inferring them from boot preference", () => {
    const fs = KandeloImageFs.create();
    ensureDirRecursive(fs, "/etc/dinit.d");
    writeVfsFile(fs, "/etc/dinit.d/web-php", "type = internal\n");
    installServiceActivities(fs, [{ target: "web-php", port: 8080 }], new Uint8Array([0]));
    const script = decode(fs, "/usr/local/libexec/kandelo-service");
    const parser = script.split(' -v enabled="$enabled" \'\n')[1]?.split("\n    }'")[0];
    expect(parser).toBeDefined();
    for (const [snapshot, state] of [
      ["[[+]     ] web-php", "running"],
      ["[{s}     ] web-php", "skipped"],
      ["[[ ]<<   ] web-php", "starting"],
      ["[   >>{ }] web-php", "stopping"],
      ["[     {-}] web-php", "stopped"],
      ["[     {X}] web-php", "failed"],
      ["[[+]     ] machine", "not-loaded"],
    ]) {
      const result = spawnSync("awk", ["-v", "targets=web-php", "-v", "enabled=web-php", `${parser}\n    }`], { input: `${snapshot}\n`, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toMatch(new RegExp(`web-php\\s+${state}\\s+enabled`));
      const machine = spawnSync("awk", ["-v", "machine=1", "-v", "targets=web-php", "-v", "enabled=web-php", `${parser}\n    }`], { input: `${snapshot}\n`, encoding: "utf8" });
      expect(machine.status, machine.stderr).toBe(0);
      expect(machine.stdout).toBe(`KANDELO_SERVICES\t1\nweb-php\t${state}\tenabled\n`);
    }
  });
  it("requires real service definitions and valid endpoint declarations", () => {
    expect(() => installServiceActivities(KandeloImageFs.create(), [{ target: "web-php", port: 8080 }], new Uint8Array([0]))).toThrow();
    expect(() => installServiceActivities(KandeloImageFs.create(), [{ target: "web-php", port: 0 }], new Uint8Array([0]))).toThrow();
  });
  it("copies payloads, file modes, ownership and symbolic links through the Rust image writer", () => {
    const source = KandeloImageFs.create();
    const target = KandeloImageFs.create();
    ensureDirRecursive(source, "/app");
    writeVfsFile(source, "/app/file", "payload", 0o640);
    source.chown("/app/file", 1000, 1000);
    source.symlink("file", "/app/alias");
    copyImageTree(source, target, "/app", "/installed");
    expect(decode(target, "/installed/file")).toBe("payload");
    expect(target.stat("/installed/file")).toMatchObject({ uid: 1000, gid: 1000, mode: 0o100640 });
    expect(target.readlink("/installed/alias")).toBe("file");
    expect(decode(target, "/installed/alias")).toBe("payload");
  });
});
