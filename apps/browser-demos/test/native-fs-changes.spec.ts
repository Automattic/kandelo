import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";

test.use({ serviceWorkers: "block" });

test("native filesystem notifications observe guest exec and observer writes", async ({ page, baseURL }) => {
  const image = KandeloImageFs.create();
  for (const path of ["/bin", "/etc", "/etc/mcp", "/tmp"]) image.mkdir(path, 0o755);
  for (const program of ["bash", "coreutils"]) {
    image.writeFile(`/bin/${program}`, readFileSync(resolveBinary(`programs/${program}.wasm`)), 0o755);
  }
  for (const command of ["mv", "rm", "cat"]) image.symlink("/bin/coreutils", `/bin/${command}`);
  const imageBytes = await image.saveImage();
  const kernelUrl = new URL("/__fs_changes_kernel.wasm", baseURL).href;
  const imageUrl = new URL("/__fs_changes_image.vfs", baseURL).href;
  await page.route(kernelUrl, route => route.fulfill({ body: readFileSync(resolveBinary("kernel.wasm")) }));
  await page.route(imageUrl, route => route.fulfill({ body: Buffer.from(imageBytes) }));
  await page.goto(new URL("/pages/test-runner/?minimal=1", baseURL).href);
  await page.waitForFunction(() => (window as any).__testRunnerReady === true);
  const modulePath = fileURLToPath(new URL("../../../host/src/browser-kernel-host.ts", import.meta.url));
  const result = await page.evaluate(async ({ moduleUrl, kernelUrl, imageUrl }) => {
    const { BrowserKernel } = await import(moduleUrl);
    let stderr = "";
    const kernel = new BrowserKernel({
      kernelOwnedFs: true,
      onStderr: (bytes: Uint8Array) => { stderr += new TextDecoder().decode(bytes); },
    });
    const events: Array<{ kind: string; path: string }> = [];
    const waiters = new Map<string, { kind?: string; deliver: () => void }>();
    const observe = (event: { kind: string; path: string }) => {
      events.push({ kind: event.kind, path: event.path });
      const waiter = waiters.get(event.path);
      if (waiter && (!waiter.kind || waiter.kind === event.kind)) waiter.deliver();
    };
    const seen = (path: string, kind?: string) => new Promise<void>((resolve, reject) => {
      if (events.some(event => event.path === path && (!kind || event.kind === kind))) { resolve(); return; }
      const timeout = setTimeout(() => reject(new Error(`No notification for ${path}`)), 10_000);
      waiters.set(path, { kind, deliver: () => { clearTimeout(timeout); waiters.delete(path); resolve(); } });
    });
    const run = async (script: string) => {
      const child = await kernel.spawnFromVfs("/bin/bash", ["bash", "-c", `set -e; ${script}`], { env: ["PATH=/bin"] });
      const code = await child.exit;
      if (code !== 0) throw new Error(`Guest exit ${code}: ${stderr}`);
    };
    try {
      await kernel.initFromImage({
        kernelWasm: await (await fetch(kernelUrl)).arrayBuffer(),
        vfsImage: new Uint8Array(await (await fetch(imageUrl)).arrayBuffer()),
      });
      const offRoot = kernel.subscribeVfsChanges("/etc/mcp", observe);
      const offTmp = kernel.subscribeVfsChanges("/tmp", observe);
      await run("printf '{}' > /etc/mcp/a.json; printf '{}' > /tmp/a.json");
      await Promise.all([seen("/etc/mcp/a.json"), seen("/tmp/a.json")]);
      const closes = events.splice(0);
      await run("mv /etc/mcp/a.json /etc/mcp/b.json; mv /tmp/a.json /tmp/b.json");
      await Promise.all([seen("/etc/mcp/b.json"), seen("/tmp/b.json")]);
      const renames = events.splice(0);
      await run("cat /tmp/b.json > /dev/null; rm /etc/mcp/b.json; rm /tmp/b.json");
      await Promise.all([seen("/etc/mcp/b.json"), seen("/tmp/b.json")]);
      const deletes = events.splice(0);
      let followup: Promise<void> | undefined;
      const offFollowup = kernel.subscribeVfsChanges("/etc/mcp", (event: { path: string }) => {
        if (event.path === "/etc/mcp/first.json") {
          followup = kernel.writeFileToVfs("/etc/mcp/second.json", new TextEncoder().encode("{}"));
        }
      });
      await kernel.writeFileToVfs("/etc/mcp/first.json", new TextEncoder().encode("{}"));
      await seen("/etc/mcp/second.json");
      await followup;
      const observerWrites = events.splice(0);
      offFollowup(); offRoot(); offTmp();
      await kernel.writeFileToVfs("/etc/mcp/unwatched.json", new TextEncoder().encode("{}"));
      const unwatched = events.splice(0);
      const bash = await kernel.readFileFromVfs("/bin/bash");
      const renamedOpen = [];
      for (const { dir, old, renamed, replaceOldName } of [
        { dir: "/etc/mcp", old: "/etc/mcp/open.json", renamed: "/etc/mcp/renamed.json", replaceOldName: false },
        { dir: "/tmp", old: "/tmp/open.json", renamed: "/tmp/renamed.json", replaceOldName: false },
        { dir: "/etc/mcp", old: "/etc/outside.json", renamed: "/etc/mcp/imported.json", replaceOldName: false },
        { dir: "/etc/mcp", old: "/etc/mcp/open.json", renamed: "/etc/mcp/replaced.json", replaceOldName: true },
      ]) {
        const off = kernel.subscribeVfsChanges(dir, observe);
        let pid = 0;
        const exit = kernel.spawn(bash.buffer.slice(bash.byteOffset, bash.byteOffset + bash.byteLength), ["bash", "-c",
          `set -e; exec 3>${old}; printf first >&3; mv ${old} ${renamed}; ${replaceOldName ? `printf other > ${old};` : ""} read continue; printf second >&3; exec 3>&-`,
        ], { env: ["PATH=/bin"], onStarted: (started: number) => { pid = started; } });
        await seen(renamed, "modify");
        if (replaceOldName) await seen(old, "modify");
        const before = new TextDecoder().decode(await kernel.readFileFromVfs(renamed));
        events.length = 0;
        kernel.appendStdinData(pid, new TextEncoder().encode("continue\n"));
        const code = await exit;
        await seen(dir, "modify");
        const after = new TextDecoder().decode(await kernel.readFileFromVfs(renamed));
        renamedOpen.push({ code, before, after, refreshed: events.some(event => event.path === dir) });
        events.length = 0;
        off();
      }
      const offUnlinked = kernel.subscribeVfsChanges("/etc/mcp", observe);
      let unlinkedPid = 0;
      const unlinkedExit = kernel.spawn(bash.buffer.slice(bash.byteOffset, bash.byteOffset + bash.byteLength), ["bash", "-c",
        "set -e; exec 3>/etc/mcp/unnamed.json; printf first >&3; rm /etc/mcp/unnamed.json; read continue; printf second >&3; exec 3>&-",
      ], { env: ["PATH=/bin"], onStarted: (pid: number) => { unlinkedPid = pid; } });
      await seen("/etc/mcp/unnamed.json", "delete");
      events.length = 0;
      kernel.appendStdinData(unlinkedPid, new TextEncoder().encode("continue\n"));
      const unlinkedCode = await unlinkedExit;
      await kernel.writeFileToVfs("/etc/mcp/sentinel.json", new TextEncoder().encode("{}"));
      await seen("/etc/mcp/sentinel.json", "modify");
      const unlinkedEvents = events.splice(0);
      offUnlinked();
      return { closes, renames, deletes, observerWrites, unwatched, renamedOpen, unlinkedCode, unlinkedEvents, stderr };
    } finally { await kernel.destroy(); }
  }, { moduleUrl: new URL(`/@fs/${modulePath}`, baseURL).href, kernelUrl, imageUrl });
  expect(result.closes).toEqual([{ kind: "modify", path: "/etc/mcp/a.json" }, { kind: "modify", path: "/tmp/a.json" }]);
  expect(result.renames).toEqual([
    { kind: "delete", path: "/etc/mcp/a.json" }, { kind: "modify", path: "/etc/mcp/b.json" },
    { kind: "delete", path: "/tmp/a.json" }, { kind: "modify", path: "/tmp/b.json" },
  ]);
  expect(result.deletes).toEqual([{ kind: "delete", path: "/etc/mcp/b.json" }, { kind: "delete", path: "/tmp/b.json" }]);
  expect(result.observerWrites).toEqual([{ kind: "modify", path: "/etc/mcp/first.json" }, { kind: "modify", path: "/etc/mcp/second.json" }]);
  expect(result.unwatched).toEqual([]);
  expect(result.renamedOpen).toEqual(Array.from({ length: 4 }, () => ({ code: 0, before: "first", after: "firstsecond", refreshed: true })));
  expect(result.unlinkedCode).toBe(0);
  expect(result.unlinkedEvents).toEqual([{ kind: "modify", path: "/etc/mcp/sentinel.json" }]);
  expect(result.stderr).toBe("");
});
