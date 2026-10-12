import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import { resolveBinary } from "../src/binary-resolver";
import { NodeKernelHost } from "../src/node-kernel-host";
import type { VfsChangeEvent } from "../src/vfs/types";
import { assertVfsWatchPrefix, vfsPathIsWithin } from "../src/vfs/vfs";

const guestErrors = new WeakMap<NodeKernelHost, string[]>();

async function boot(): Promise<NodeKernelHost> {
  const fs = KandeloImageFs.create();
  fs.mkdir("/bin", 0o755);
  fs.mkdir("/etc", 0o755);
  fs.mkdir("/etc/mcp", 0o755);
  fs.mkdir("/tmp", 0o1777);
  fs.writeFile("/bin/bash", readFileSync(resolveBinary("programs/bash.wasm")), 0o755);
  fs.writeFile("/bin/coreutils", readFileSync(resolveBinary("programs/coreutils.wasm")), 0o755);
  for (const command of ["mv", "rm", "cat"]) fs.symlink("/bin/coreutils", `/bin/${command}`);
  const stderr: string[] = [];
  const host = new NodeKernelHost({
    rootfsImage: await fs.saveImage(),
    onStderr: (_pid, bytes) => stderr.push(new TextDecoder().decode(bytes)),
    onHostDiagnostic: diagnostic => stderr.push(JSON.stringify(diagnostic)),
  });
  guestErrors.set(host, stderr);
  const bytes = readFileSync(resolveBinary("kernel.wasm"));
  await host.init(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return host;
}

async function run(host: NodeKernelHost, script: string) {
  const process = await host.spawnFromVfs("/bin/bash", ["bash", "-c", `set -e; ${script}`], { env: ["PATH=/bin"] });
  expect(await process.exit, guestErrors.get(host)?.join("")).toBe(0);
}

const paths = (events: VfsChangeEvent[]) => events.map(({ kind, path }) => ({ kind, path }));

describe("native filesystem change events", () => {
  it("observes guest closes, rename and unlink in rootfs and tmpfs", async () => {
    const host = await boot();
    const events: VfsChangeEvent[] = [];
    try {
      const offRoot = host.subscribeVfsChanges("/etc/mcp", event => events.push(event));
      const offTmp = host.subscribeVfsChanges("/tmp", event => events.push(event));
      await run(host, "printf '{}' > /etc/mcp/a.json; printf '{}' > /tmp/a.json");
      await expect.poll(() => paths(events)).toEqual([
        { kind: "modify", path: "/etc/mcp/a.json" },
        { kind: "modify", path: "/tmp/a.json" },
      ]);
      expect(events.every(event => Number.isFinite(event.t))).toBe(true);
      events.length = 0;
      await run(host, "mv /etc/mcp/a.json /etc/mcp/b.json; mv /tmp/a.json /tmp/b.json");
      await expect.poll(() => paths(events)).toEqual([
        { kind: "delete", path: "/etc/mcp/a.json" },
        { kind: "modify", path: "/etc/mcp/b.json" },
        { kind: "delete", path: "/tmp/a.json" },
        { kind: "modify", path: "/tmp/b.json" },
      ]);
      events.length = 0;
      await run(host, "rm /etc/mcp/b.json; rm /tmp/b.json");
      await expect.poll(() => paths(events)).toEqual([
        { kind: "delete", path: "/etc/mcp/b.json" },
        { kind: "delete", path: "/tmp/b.json" },
      ]);
      offRoot(); offTmp();
      events.length = 0;
      await run(host, "printf '{}' > /etc/mcp/c.json; printf '{}' > /tmp/c.json");
      expect(events).toEqual([]);
    } finally { await host.destroy(); }
  }, 60_000);

  it("delivers a new write made by a change observer", async () => {
    const host = await boot();
    const events: VfsChangeEvent[] = [];
    let followup: Promise<void> | undefined;
    try {
      const off = host.subscribeVfsChanges("/etc/mcp", event => {
        events.push(event);
        if (event.path === "/etc/mcp/first.json") {
          followup = host.writeFileToVfs("/etc/mcp/second.json", new TextEncoder().encode("{}"));
        }
      });
      await host.writeFileToVfs("/etc/mcp/first.json", new TextEncoder().encode("{}"));
      await expect.poll(() => paths(events)).toEqual([
        { kind: "modify", path: "/etc/mcp/first.json" },
        { kind: "modify", path: "/etc/mcp/second.json" },
      ]);
      await followup;
      off();
    } finally { await host.destroy(); }
  }, 60_000);

  it("refreshes the new name when a renamed writable descriptor closes", async () => {
    const host = await boot();
    const events: VfsChangeEvent[] = [];
    try {
      for (const { dir, old, renamed, replaceOldName } of [
        { dir: "/etc/mcp", old: "/etc/mcp/open.json", renamed: "/etc/mcp/renamed.json", replaceOldName: false },
        { dir: "/tmp", old: "/tmp/open.json", renamed: "/tmp/renamed.json", replaceOldName: false },
        { dir: "/etc/mcp", old: "/etc/outside.json", renamed: "/etc/mcp/imported.json", replaceOldName: false },
        { dir: "/etc/mcp", old: "/etc/mcp/open.json", renamed: "/etc/mcp/replaced.json", replaceOldName: true },
      ]) {
        const off = host.subscribeVfsChanges(dir, event => events.push(event));
        events.length = 0;
        let pid = 0;
        const bytes = readFileSync(resolveBinary("programs/bash.wasm"));
        const exit = host.spawn(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), ["bash", "-c",
          `set -e; exec 3>${old}; printf first >&3; mv ${old} ${renamed}; ${replaceOldName ? `printf other > ${old};` : ""} read continue; printf second >&3; exec 3>&-`,
        ], { env: ["PATH=/bin"], onStarted: started => { pid = started; } });
        // Observe rename before permitting the final write. A buffered rename
        // hint must not accidentally cover a later close under a stale name.
        await expect.poll(() => events.some(event => event.path === renamed),
          { timeout: 10_000 }).toBe(true);
        if (replaceOldName) {
          await expect.poll(() => events.some(event => event.kind === "modify" && event.path === old),
            { timeout: 10_000 }).toBe(true);
        }
        expect(new TextDecoder().decode(await host.readFileFromVfs(renamed))).toBe("first");
        events.length = 0;
        host.appendStdinData(pid, new TextEncoder().encode("continue\n"));
        expect(await exit, guestErrors.get(host)?.join("")).toBe(0);
        expect(new TextDecoder().decode(await host.readFileFromVfs(renamed))).toBe("firstsecond");
        await expect.poll(() => events.some(event => event.path === dir || event.path === renamed),
          { timeout: 10_000 }).toBe(true);
        off();
      }
    } finally { await host.destroy(); }
  }, 60_000);

  it("does not refresh unrelated directories when an unlinked inode closes", async () => {
    const host = await boot();
    const events: VfsChangeEvent[] = [];
    try {
      const off = host.subscribeVfsChanges("/etc/mcp", event => events.push(event));
      let pid = 0;
      const bytes = readFileSync(resolveBinary("programs/bash.wasm"));
      const exit = host.spawn(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), ["bash", "-c",
        "set -e; exec 3>/etc/mcp/unnamed.json; printf first >&3; rm /etc/mcp/unnamed.json; read continue; printf second >&3; exec 3>&-",
      ], { env: ["PATH=/bin"], onStarted: started => { pid = started; } });
      await expect.poll(() => events.some(event => event.kind === "delete" && event.path === "/etc/mcp/unnamed.json"),
        { timeout: 10_000 }).toBe(true);
      events.length = 0;
      host.appendStdinData(pid, new TextEncoder().encode("continue\n"));
      expect(await exit, guestErrors.get(host)?.join("")).toBe(0);
      // A later observed write is a completion barrier for prior hints.
      await host.writeFileToVfs("/etc/mcp/sentinel.json", new TextEncoder().encode("{}"));
      await expect.poll(() => events.some(event => event.path === "/etc/mcp/sentinel.json"),
        { timeout: 10_000 }).toBe(true);
      expect(paths(events)).toEqual([{ kind: "modify", path: "/etc/mcp/sentinel.json" }]);
      off();
    } finally { await host.destroy(); }
  }, 60_000);

  it("reports staged writes, skips read-only closes and matches whole components", async () => {
    const host = await boot();
    const events: VfsChangeEvent[] = [];
    try {
      const off = host.subscribeVfsChanges("/etc/mcp", event => events.push(event));
      await host.writeFileToVfs("/etc/mcp/a.json", new TextEncoder().encode("{}"));
      await expect.poll(() => paths(events)).toEqual([{ kind: "modify", path: "/etc/mcp/a.json" }]);
      events.length = 0;
      await run(host, "cat /etc/mcp/a.json > /dev/null; printf other > /etc/other.json");
      expect(events).toEqual([]);
      off();
    } finally { await host.destroy(); }
  }, 60_000);
});

describe("vfsPathIsWithin", () => {
  it("refuses ambiguous watch names before sending them to a worker", () => {
    const host = new NodeKernelHost();
    for (const prefix of ["relative", "/etc/../mcp", "/etc//mcp", "/etc/mcp/", "/a\0b"]) {
      expect(() => assertVfsWatchPrefix(prefix)).toThrow("canonical absolute");
      expect(() => host.subscribeVfsChanges(prefix, () => {})).toThrow("canonical absolute");
    }
    expect(() => assertVfsWatchPrefix("/")).not.toThrow();
  });
  it("matches a prefix itself and its descendants, including root", () => {
    expect(vfsPathIsWithin("/etc/mcp", "/etc/mcp")).toBe(true);
    expect(vfsPathIsWithin("/etc/mcp", "/etc/mcp/a.json")).toBe(true);
    expect(vfsPathIsWithin("/etc/mcp", "/etc/mcp-old/a.json")).toBe(false);
    expect(vfsPathIsWithin("/", "/etc/mcp/a.json")).toBe(true);
  });
});
