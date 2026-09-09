/**
 * Acceptance harness for @kandelo/web, consumed from a clean Vite project.
 *
 * Proves, with nothing imported beyond the published package:
 *   1. `import { BrowserKernel, fetchKandeloBinaries } from "@kandelo/web"` resolves.
 *   2. The loader fetches kernel + rootfs + php from the binaries release
 *      (index.toml -> .tar.zst -> sha256 verify -> fzstd -> untar). NO binaries
 *      are bundled in the package.
 *   3. The kernel boots (worker + fetched kernel.wasm) with a VFS image.
 *   4. `spawnFromVfs("/usr/bin/php", ["-v"])` runs php, printing to onStdout.
 *   5. A file is written AND read back in the VFS from the MAIN THREAD via the
 *      public synchronous host FS API (`kernel.hostFs`).
 *
 * To point at a fork or self-hosted binaries instead of the canonical release,
 * pass a source: `fetchKandeloBinaries({ repo: "myorg/fork" })` or
 * `fetchKandeloBinaries({ baseUrl: "/bins/" })`.
 */
import {
  BrowserKernel,
  MemoryFileSystem,
  writeVfsBinary,
  ensureDirRecursive,
  fetchKandeloIndex,
  fetchKandeloBinaries,
  fetchKandeloPackage,
  BINARIES_RELEASE_TAG,
} from "@kandelo/web";

const outEl = document.getElementById("out")!;
const print = (s: string) => {
  outEl.textContent += s;
};
const line = (s: string) => print(s + "\n");

async function main() {
  line(`@kandelo/web — fetching binaries release: ${BINARIES_RELEASE_TAG}`);

  // The canonical release lives on GitHub, but its CDN sends no CORS/CORP
  // headers, so under COEP:require-corp the browser cannot fetch it
  // cross-origin. This app proxies it same-origin at /kandelo-binaries/
  // (see vite.config.ts) and points the loader there via `baseUrl`.
  const source = { baseUrl: "/kandelo-binaries/" };

  // 1. Fetch the release index once, then pull the kernel and the php program
  //    archive from it. All ABI-verified and sha256-checked.
  const index = await fetchKandeloIndex(source);
  line(`index ok (abi ${index.abiVersion}, ${index.packages.size} packages)`);

  const { kernelWasm } = await fetchKandeloBinaries({ index });
  line(`fetched kernel.wasm (${kernelWasm.byteLength} bytes)`);

  const php = await fetchKandeloPackage("php", { index });
  const phpWasm = php.artifacts["php.wasm"];
  if (!phpWasm) throw new Error("php archive missing artifacts/php.wasm");
  line(`fetched php ${php.version}-rev${php.revision} (php.wasm ${phpWasm.byteLength} bytes)`);

  // 2. Build a VFS image with php installed at /usr/bin/php.
  const sab = new SharedArrayBuffer(16 * 1024 * 1024, {
    maxByteLength: 512 * 1024 * 1024,
  });
  const fs = MemoryFileSystem.create(sab, 512 * 1024 * 1024);
  ensureDirRecursive(fs, "/usr/bin");
  writeVfsBinary(fs, "/usr/bin/php", phpWasm, 0o755);
  const vfsImage = await fs.saveImage();
  line(`built VFS image (${vfsImage.byteLength} bytes) with /usr/bin/php`);

  // 3. Boot the kernel worker with the fetched kernel bytes. The worker entries
  //    come from the package's own bundled defaults — no `?worker&url` wiring.
  const kernel = new BrowserKernel({
    // Step 5 reads and writes the live VFS from the main thread. Off by
    // default because it makes the main thread a co-owner of the VFS SAB.
    exposeHostFs: true,
    onStdout: (d) => print(new TextDecoder().decode(d)),
    onStderr: (d) => print(new TextDecoder().decode(d)),
  });
  await kernel.boot({ kernelWasm, vfsImage, argv: ["/usr/bin/php", "--version"] });

  // 4. Run php -v explicitly through spawnFromVfs (reads the binary out of the
  //    kernel-owned VFS — no bytes shipped across the worker boundary).
  line("\n--- spawnFromVfs('/usr/bin/php', ['-v']) ---");
  const { exit } = await kernel.spawnFromVfs("/usr/bin/php", ["-v"]);
  const code = await exit;
  line(`\n[php exited ${code}]`);

  // 5. Main-thread VFS round-trip via the public synchronous host FS API.
  const path = "/tmp/hello-from-main.txt";
  const payload = new TextEncoder().encode("written from the main thread\n");
  ensureDirRecursive(kernel.hostFs, "/tmp");
  const fd = kernel.hostFs.open(path, /* O_WRONLY|O_CREAT|O_TRUNC */ 0o1101, 0o644);
  kernel.hostFs.write(fd, payload, 0, payload.length);
  kernel.hostFs.close(fd);

  const rfd = kernel.hostFs.open(path, /* O_RDONLY */ 0, 0);
  const buf = new Uint8Array(256);
  const n = kernel.hostFs.read(rfd, buf, null, buf.length);
  kernel.hostFs.close(rfd);
  const readBack = new TextDecoder().decode(buf.subarray(0, n));
  line(`\nhostFs round-trip ${path}: ${JSON.stringify(readBack)}`);
  line(readBack === "written from the main thread\n" ? "✅ ACCEPTANCE PASSED" : "❌ mismatch");
}

main().catch((err) => {
  line("\n❌ " + (err?.stack ?? String(err)));
});
