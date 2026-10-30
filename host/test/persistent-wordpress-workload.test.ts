import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { NodeKernelHost } from "../src/node-kernel-host";
import { resolveBinary } from "../src/binary-resolver";
import { HostFileSystem } from "../src/vfs/host-fs";
import { OverlayStorageFile } from "../src/vfs/overlay-storage";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import { configureWordPressRuntime } from "../../packages/registry/service-vfs-demo";
import { parseFilesystemMemory, validateFilesystemMemoryBounds } from "./fixtures/filesystem-memory";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");

it("runs MariaDB mixed writes and source-free live recovery through the Node host", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kandelo-node-wordpress-workload-"));
  const rawPath = join(directory, "source.vfs");
  const configuredPath = join(directory, "configured.vfs");
  const checkedPath = join(directory, "checked.base");
  const port = 59341;
  const timings: Array<{ phase: string; elapsedMs: number; kernelPages: number; hostPeak: number }> = [];
  const memory: Array<{ phase: string; report: ReturnType<typeof parseFilesystemMemory> }> = [];
  let host: NodeKernelHost | undefined;
  let cleanShutdown = true;
  let logs = "";
  const accept = (_pid: number, bytes: Uint8Array) => { logs = (logs + decoder.decode(bytes)).slice(-131072); };
  const command = async (source: string) => {
    const offset = logs.length;
    const child = await host!.spawnFromVfs("/bin/bash", ["bash", "-c", source], {
      cwd: "/", env: ["HOME=/root", "PATH=/usr/local/bin:/usr/bin:/bin:/sbin:/usr/sbin"],
      ownedJob: { id: `persistence-workload-${randomUUID()}`, timeoutMs: 180_000 },
    });
    expect(await child.exit, logs).toBe(0);
    return logs.slice(offset);
  };
  try {
    const preparationStarted = performance.now();
    const rawDescriptor = openSync(rawPath, "wx");
    try {
      const decompression = spawnSync("zstd", ["-d", "-c", resolveBinary("programs/wasm32/lamp.vfs.zst")], {
        stdio: ["ignore", rawDescriptor, "pipe"], timeout: 180_000,
      });
      if (decompression.error) throw decompression.error;
      expect(decompression.status, String(decompression.stderr)).toBe(0);
    } finally { closeSync(rawDescriptor); }
    const sourceDescriptor = openSync(rawPath, "r");
    const filesystem = KandeloImageFs.createFromPositionedImage(
      new Uint8Array(readFileSync(join(import.meta.dirname, "../../local-binaries/kandelo_image_module_positioned32.wasm"))),
      statSync(rawPath).size, (offset, destination) => readSync(sourceDescriptor, destination, 0, destination.length, offset));
    let binding;
    try {
      configureWordPressRuntime(filesystem, { port, freshSqliteDatabase: false, phpFpmWorkers: 1 });
      const target = OverlayStorageFile.open(new HostFileSystem(directory), "/checked.base");
      try {
        const result = await filesystem.exportPersistentImageTo(target, "crc32c");
        binding = { identitySha256: result.identitySha256, dataCachePages: 0, indexCachePages: 0 };
      } finally { target.close(); }
      const configuredDescriptor = openSync(configuredPath, "wx");
      try {
        for (const chunk of filesystem.exportImageChunks(65536)) {
          let written = 0;
          while (written < chunk.length) {
            const count = writeSync(configuredDescriptor, chunk, written, chunk.length - written);
            if (count <= 0) throw new Error("configured image made no write progress");
            written += count;
          }
        }
      } finally { closeSync(configuredDescriptor); }
    } finally {
      try { filesystem.reset(); } finally { closeSync(sourceDescriptor); }
    }
    const preparationMs = performance.now() - preparationStarted;
    let postId = 0;
    let mediaPath = "";
    const title = `Node live persistence ${randomUUID()}`;
    const digest = createHash("sha256");
    for (let block = 0; block < 128; block++) digest.update(Buffer.alloc(65536));
    const blobHash = digest.digest("hex");
    for (const phase of ["memory-baseline", "persistent-install", "persistent-reopen"] as const) {
      logs = "";
      const persistent = phase !== "memory-baseline";
      const started = performance.now();
      host = new NodeKernelHost({ maxWorkers: 16, maxPages: 4096, kernelMaxPages: 12288,
        ...(persistent ? { rootfsImageFile: checkedPath, rootfsPersistentImageBinding: binding,
          experimentalResizablePersistencePath: join(directory, "journal"),
          requireExistingRootfsPersistence: phase === "persistent-reopen" } : {
          rootfsImage: new Uint8Array(readFileSync(configuredPath)),
        }), onStdout: accept, onStderr: accept });
      await host.init();
      let serviceExited = false;
      const service = await host.spawnFromVfs("/sbin/dinit", ["dinit", "--container", "-p", "/tmp/dinitctl", "nginx"], {
        cwd: "/", env: ["HOME=/root", "PATH=/usr/local/bin:/usr/bin:/bin:/sbin:/usr/sbin", "WP_APP_PATH=/", "WP_PROTO=http"],
      });
      void service.exit.then(() => { serviceExited = true; });
      let cookie = "";
      const request = async (url: string, method = "GET", body: Uint8Array | null = null, headers: Record<string, string> = {}) => {
        return host!.fetchInKernel(port, { method, url, body, headers: { Host: `localhost:${port}`, Cookie: cookie, ...headers } },
          { timeoutMs: 30_000, maxResponseBytes: 8 * 1024 * 1024 });
      };
      const deadline = Date.now() + 240_000;
      for (;;) {
        const response = await request("/").catch(() => null);
        if (response?.status === 200 && /WordPress on Kandelo|Hello world/i.test(decoder.decode(response.body))) break;
        if (serviceExited || Date.now() >= deadline) throw new Error(`MariaDB ${phase} did not become ready: ${logs}`);
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      const usage = await host.getStorageMetadataMemoryUsage();
      const kernelPages = await host.getKernelMemoryPages();
      expect(kernelPages).toBeLessThanOrEqual(12288);
      expect(usage.peak).toBeLessThanOrEqual(usage.limit);
      timings.push({ phase, elapsedMs: performance.now() - started, kernelPages, hostPeak: usage.peak });
      if (phase === "persistent-install") {
        const login = await request("/wp-login.php", "POST", encoder.encode(new URLSearchParams({ log: "admin", pwd: "password", testcookie: "1" }).toString()),
          { "Content-Type": "application/x-www-form-urlencoded", Cookie: "wordpress_test_cookie=WP%20Cookie%20check" });
        cookie = Object.entries(login.headers).filter(([name]) => name.toLowerCase() === "set-cookie")
          .flatMap(([, value]) => value.split("\n")).map(value => value.split(";")[0]).join("; ");
        expect(cookie).toContain("wordpress_logged_in_");
        const editor = await request("/wp-admin/post-new.php");
        expect(editor.status, decoder.decode(editor.body).slice(0, 500)).toBe(200);
        const editorHtml = decoder.decode(editor.body);
        const settings = /\bwpApiSettings\s*=\s*(\{[^<]*?\})\s*;/.exec(editorHtml)?.[1];
        const nonce = settings === undefined
          ? /createNonceMiddleware\(\s*"([^"]+)"\s*\)/.exec(editorHtml)?.[1]
          : (JSON.parse(settings) as { nonce?: string }).nonce;
        expect(nonce).toBeDefined();
        const post = await request("/index.php?rest_route=/wp/v2/posts", "POST",
          encoder.encode(JSON.stringify({ title, content: "Node MariaDB live journal recovery", status: "publish" })),
          { "Content-Type": "application/json", "X-WP-Nonce": nonce! });
        expect(post.status, decoder.decode(post.body)).toBe(201);
        postId = JSON.parse(decoder.decode(post.body)).id;
        const upload = await request("/index.php?rest_route=/wp/v2/media", "POST", png,
          { "Content-Type": "image/png", "Content-Disposition": 'attachment; filename="node-persistence.png"', "X-WP-Nonce": nonce! });
        expect(upload.status, decoder.decode(upload.body)).toBe(201);
        mediaPath = new URL(JSON.parse(decoder.decode(upload.body)).source_url).pathname;
        const mutationStarted = performance.now();
        await command(`set -eu
mkdir -p /home/projects/node-workload
for ((index=0; index<4; index++)); do dd if=/dev/zero of=/home/projects/node-workload/blob-$index bs=65536 count=128; done
for ((index=0; index<64; index++)); do printf 'value-%s\\n' "$index" > /home/projects/node-workload/file-$index; done
sync`);
        timings.push({ phase: "guest-write-and-sync-32MiB", elapsedMs: performance.now() - mutationStarted,
          kernelPages: await host.getKernelMemoryPages(), hostPeak: (await host.getStorageMetadataMemoryUsage()).peak });
      }
      if (persistent) {
        const post = await request(`/index.php?rest_route=/wp/v2/posts/${postId}`);
        expect(post.status).toBe(200);
        expect(JSON.parse(decoder.decode(post.body)).title.rendered).toBe(title);
        const upload = await request(mediaPath);
        expect(upload.status).toBe(200);
        expect(upload.body).toEqual(new Uint8Array(png));
        const readStarted = performance.now();
        await command(`set -eu
for ((index=0; index<4; index++)); do test "$(sha256sum /home/projects/node-workload/blob-$index | cut -d ' ' -f 1)" = ${blobHash}; done
for ((index=0; index<64; index++)); do test "$(cat /home/projects/node-workload/file-$index)" = "value-$index"; done`);
        timings.push({ phase: `${phase}:read-32MiB`, elapsedMs: performance.now() - readStarted,
          kernelPages: await host.getKernelMemoryPages(), hostPeak: (await host.getStorageMetadataMemoryUsage()).peak });
        const report = parseFilesystemMemory(await command("printf 'FS_MEMORY_BEGIN\\n'; cat /proc/kandelo/fs_memory; printf 'FS_MEMORY_END\\n'"));
        validateFilesystemMemoryBounds(report);
        memory.push({ phase, report });
      }
      await host.destroy();
      cleanShutdown = host.getPersistenceShutdownFailure() === null;
      expect(cleanShutdown, logs).toBe(true);
      host = undefined;
      if (phase === "persistent-install") {
        rmSync(rawPath);
        rmSync(configuredPath);
      }
    }
    console.info("Node MariaDB persistence workload", JSON.stringify({ preparationMs, policy: "crc32c",
      physicalBaseBytes: statSync(checkedPath).size, configuredKernelPages: 12288, configuredProcessPages: 4096,
      timings, memory, imageCheckpoints: 0,
      interpretation: "Sequential desktop diagnostics. The memory baseline starts from image state, not the warmed database; not a matched speedup or mobile measurement." }));
  } finally {
    if (host !== undefined) {
      await host.destroy();
      cleanShutdown = host.getPersistenceShutdownFailure() === null;
    }
    if (cleanShutdown) rmSync(directory, { recursive: true, force: true });
    else console.error(`Retained uncertain Node workload storage: ${directory}`);
  }
}, 600_000);
