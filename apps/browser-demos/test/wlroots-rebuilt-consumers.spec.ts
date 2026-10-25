import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { sessionRootfs } from "../../../host/test/wlroots-session";
import { installBrowserMemoryBoundaryProbe, memoryBoundaryFailures } from "./support/browser-memory-boundary";

test.use({ serviceWorkers: "block", viewport: { width: 800, height: 600 } });
const text = (value: string) => new TextEncoder().encode(value);
const program = (path: string) => new Uint8Array(readFileSync(resolveBinary(path)));

// This is an earlier consumer gate over the normal packages, kernel and image
// builder. The gallery's complete shell image and UI gates remain separate.
for (const compositor of ["cage", "sway"] as const) {
  test(`rebuilt ${compositor} renders, routes input and restarts with GLES2`, async ({ page, baseURL, browserName }) => {
    test.setTimeout(180_000);
    const shell = "printf 'READY\\n'; read x; printf 'GOT[%s]\\n' \"$x\"; read y\n";
    const files = [
      { path: `/usr/bin/${compositor}`, bytes: program(`programs/${compositor}/${compositor}.wasm`), mode: 0o755 },
      { path: "/usr/bin/wlterm", bytes: program("programs/wayland-demo/wlterm.wasm"), mode: 0o755 },
      { path: "/bin/bash", bytes: program("programs/bash.wasm"), mode: 0o755 },
      { path: "/bin/sh", bytes: program("programs/dash.wasm"), mode: 0o755 },
      { path: "/usr/bin/session", bytes: text(shell), mode: 0o755 },
      { path: "/usr/share/fonts/Inconsolata-Regular.ttf", bytes: new Uint8Array(readFileSync(new URL("../../../third_party/Inconsolata-Regular.ttf", import.meta.url))), mode: 0o644 },
      { path: "/etc/fonts/fonts.conf", bytes: text('<fontconfig><dir>/usr/share/fonts</dir><cachedir>/tmp/fontconfig</cachedir><alias><family>monospace</family><prefer><family>Inconsolata</family></prefer></alias></fontconfig>'), mode: 0o644 },
    ];
    if (compositor === "sway") files.push(
      { path: "/usr/bin/swaymsg", bytes: program("programs/sway/swaymsg.wasm"), mode: 0o755 },
      { path: "/etc/sway/config", bytes: text("font pango:monospace 10\nexec /usr/bin/wlterm --watch READY --watch GOT[a] /bin/bash /usr/bin/session\n"), mode: 0o644 },
    );
    const imageBytes = await sessionRootfs(compositor, files);
    const kernelBytes = readFileSync(resolveBinary("kernel.wasm"));
    await page.route("**/__wlroots_rebuilt_kernel", route => route.fulfill({ body: kernelBytes }));
    await page.route("**/__wlroots_rebuilt_image", route => route.fulfill({ body: Buffer.from(imageBytes) }));
    await installBrowserMemoryBoundaryProbe(page);
    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.goto(new URL("/trap-signal-test.html", baseURL).href);
    const modulePath = fileURLToPath(new URL("../../../host/src/browser-kernel-host.ts", import.meta.url));
    const evidence: unknown[] = [];
    try {
      await page.evaluate(async moduleUrl => {
        const { BrowserKernel } = await import(moduleUrl);
        const scope = globalThis as any;
        scope.__wlrootsState = { output: "", exit: null, diagnostics: [], processes: [] };
        const kernel = new BrowserKernel({ kernelOwnedFs: true,
          onStdout: (bytes: Uint8Array) => { scope.__wlrootsState.output += new TextDecoder().decode(bytes); },
          onStderr: (bytes: Uint8Array) => { scope.__wlrootsState.output += new TextDecoder().decode(bytes); },
          onHostDiagnostic: (value: unknown) => scope.__wlrootsState.diagnostics.push(value),
          onProcessEvent: (event: unknown) => scope.__wlrootsState.processes.push(event),
        });
        scope.__wlrootsKernel = kernel;
        await kernel.initFromImage({
          kernelWasm: await (await fetch("/__wlroots_rebuilt_kernel")).arrayBuffer(),
          vfsImage: new Uint8Array(await (await fetch("/__wlroots_rebuilt_image")).arrayBuffer()),
        });
        const canvas = document.createElement("canvas");canvas.id = "wlroots-screen";canvas.width = 640;canvas.height = 480;
        document.body.replaceChildren(canvas);
        const stats = new SharedArrayBuffer(48);scope.__wlrootsStats = new Int32Array(stats);
        kernel.setInputCanvasDims(640, 480);kernel.kmsSetDisplaySize(1, 640, 480);
        kernel.kmsAttachCanvas(1, canvas.transferControlToOffscreen(), stats, { mode: "webgl2-scanout" });
      }, new URL(`/@fs${modulePath}`, baseURL).href);
      const tap = (key: number) => page.evaluate(key => {
        (globalThis as any).__wlrootsKernel.injectInputEventBatch([
          {device:0,ev_type:1,code:key,value:1},{device:0,ev_type:0,code:0,value:0},
          {device:0,ev_type:1,code:key,value:0},{device:0,ev_type:0,code:0,value:0},
        ]);
      }, key);
      const state = () => page.evaluate(() => (globalThis as any).__wlrootsState);
      for (let cycle = 0; cycle < 2; cycle++) {
        await page.evaluate(async compositor => {
          const scope = globalThis as any;scope.__wlrootsState.output = "";scope.__wlrootsState.exit = null;
          const args = compositor === "cage" ? ["cage", "-d", "--", "/usr/bin/wlterm", "--watch", "READY", "--watch", "GOT[a]", "/bin/bash", "/usr/bin/session"] : ["sway", "-d"];
          scope.__wlrootsEnv = ["LIBSEAT_BACKEND=noop", "XDG_RUNTIME_DIR=/tmp", "PATH=/usr/bin:/bin", "HOME=/root", "TERM=vt100", "SWAYSOCK=/tmp/sway-ipc.sock"];
          const child = await scope.__wlrootsKernel.spawnFromVfs(`/usr/bin/${compositor}`, args, {uid:1000,gid:1000,env:scope.__wlrootsEnv});
          child.exit.then((code: number) => { scope.__wlrootsState.exit = code; });
        }, compositor);
        await expect.poll(async () => {
          const value = await state();if (value.exit !== null) throw new Error(JSON.stringify(value));return value.output;
        }, {timeout:45_000}).toContain('WLTERM_GRID "READY"');
        expect((await state()).output).toContain("Creating GLES2 renderer");
        await expect.poll(() => page.evaluate(() => Atomics.load((globalThis as any).__wlrootsStats,7))).toBe(3);
        const screen = page.locator("#wlroots-screen"), before = await screen.screenshot();
        await tap(30);await tap(28);
        await expect.poll(async () => (await state()).output, {timeout:30_000}).toContain('WLTERM_GRID "GOT[a]"');
        await expect.poll(async () => (await screen.screenshot()).equals(before), {timeout:15_000}).toBe(false);
        const rendered = await screen.screenshot();
        writeFileSync(new URL(`../../../.context/${compositor}-${browserName}-${cycle}.png`, import.meta.url), rendered);
        const colors = await page.evaluate(async encoded => {
          const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(encoded), c=>c.charCodeAt(0))],{type:"image/png"}));
          const context = new OffscreenCanvas(bitmap.width,bitmap.height).getContext("2d")!;context.drawImage(bitmap,0,0);
          const data = context.getImageData(0,0,bitmap.width,bitmap.height).data;const colors = new Set<number>();
          for(let i=0;i<data.length;i+=4)colors.add((data[i]<<16)|(data[i+1]<<8)|data[i+2]);bitmap.close();return colors.size;
        }, rendered.toString("base64"));
        expect(colors).toBeGreaterThan(3);
        await tap(28);
        await expect.poll(async () => (await state()).output, {timeout:30_000}).toContain("WLTERM_EXIT code=0");
        if (compositor === "sway") await page.evaluate(async () => {
          const scope = globalThis as any;
          const child = await scope.__wlrootsKernel.spawnFromVfs("/usr/bin/swaymsg",["swaymsg","exit"],{uid:1000,gid:1000,env:scope.__wlrootsEnv});
          await child.exit;
        });
        await expect.poll(state, {timeout:30_000}).toMatchObject({exit:0});
        await expect.poll(() => page.evaluate(() => Atomics.load((globalThis as any).__wlrootsStats,8))).toBe(0);
        evidence.push({cycle,colors,...await state()});
      }
    } finally {
      const finalState = await page.evaluate(async () => {
        const scope = globalThis as any;
        return {...scope.__wlrootsState, procs: await scope.__wlrootsKernel?.enumProcs()};
      });
      writeFileSync(new URL(`../../../.context/${compositor}-${browserName}-final-state.json`, import.meta.url), JSON.stringify(finalState,null,2)+"\n");
      await page.evaluate(() => (globalThis as any).__wlrootsKernel?.destroy());
    }
    writeFileSync(new URL(`../../../.context/${compositor}-${browserName}-guest.json`, import.meta.url), JSON.stringify({
      compositor,engine:browserName,kernelSha256:createHash("sha256").update(kernelBytes).digest("hex"),evidence,
    },null,2)+"\n");
    expect(pageErrors).toEqual([]);expect(await memoryBoundaryFailures(page)).toEqual([]);
  });
}
