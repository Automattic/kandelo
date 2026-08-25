import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import { NodeKernelHost } from "../src/node-kernel-host";
import {
  ensureDirRecursive,
  writeVfsBinary,
  writeVfsFile,
} from "../src/vfs/image-helpers";
import { tryResolveBinary } from "../src/binary-resolver";
import { prewarmOpcache } from "../../images/vfs/scripts/opcache-prewarm";

const phpPath = tryResolveBinary("programs/php/php.wasm");
const opcachePath = tryResolveBinary("programs/php/opcache.so");
const OPCACHE_AVAILABLE =
  !!phpPath && existsSync(phpPath) &&
  !!opcachePath && existsSync(opcachePath);

const PHP_RUNTIME_INI_ARGS = [
  "-d", "extension_dir=/usr/lib/php/extensions",
  "-d", "zend_extension=opcache",
  "-d", "opcache.enable=1",
  "-d", "opcache.enable_cli=1",
  "-d", "opcache.file_cache=/var/cache/opcache",
  "-d", "opcache.file_cache_only=1",
  "-d", "opcache.validate_timestamps=0",
];

describe.skipIf(!OPCACHE_AVAILABLE)("opcache prewarmer", () => {
  it("splits compile groups that contain duplicate declarations", async () => {
    const previousSkip = process.env.KANDELO_NO_OPCACHE_PREWARM;
    delete process.env.KANDELO_NO_OPCACHE_PREWARM;

    try {
      const fs = MemoryFileSystem.create(new SharedArrayBuffer(64 * 1024 * 1024));
      for (const dir of [
        "/tmp",
        "/var/www",
        "/var/cache",
        "/usr/lib/php/extensions",
      ]) {
        ensureDirRecursive(fs, dir);
      }

      writeVfsBinary(
        fs,
        "/usr/lib/php/extensions/opcache.so",
        readFileSync(opcachePath!),
        0o755,
      );
      writeVfsFile(
        fs,
        "/var/www/a.php",
        "<?php function duplicate_for_prewarm_test() { return 1; }\n",
      );
      writeVfsFile(
        fs,
        "/var/www/b.php",
        "<?php function duplicate_for_prewarm_test() { return 2; }\n",
      );

      const written = await prewarmOpcache(fs, {
        sourceRoots: ["/var/www"],
        label: "duplicate-declarations-test",
      });
      expect(written).toBeGreaterThanOrEqual(2);
    } finally {
      if (previousSkip === undefined) {
        delete process.env.KANDELO_NO_OPCACHE_PREWARM;
      } else {
        process.env.KANDELO_NO_OPCACHE_PREWARM = previousSkip;
      }
    }
  }, 60_000);

  it("writes cache files that a later PHP process can consume", async () => {
    const previousSkip = process.env.KANDELO_NO_OPCACHE_PREWARM;
    delete process.env.KANDELO_NO_OPCACHE_PREWARM;

    try {
      const fs = createPrewarmFs();
      writeVfsFile(fs, "/var/www/hit.php", "<?php echo 'cached-ok';\n");

      const written = await prewarmOpcache(fs, {
        sourceRoots: ["/var/www"],
        label: "cache-consumption-test",
      });
      expect(written).toBeGreaterThanOrEqual(1);

      writeVfsFile(fs, "/var/www/hit.php", "<?php this is invalid php ;\n");

      const { exitCode, stdout, stderr } = await runPhpFromImage(
        await fs.saveImage(),
        "require '/var/www/hit.php';",
      );
      expect(stderr).toBe("");
      expect(stdout).toBe("cached-ok");
      expect(exitCode).toBe(0);
    } finally {
      if (previousSkip === undefined) {
        delete process.env.KANDELO_NO_OPCACHE_PREWARM;
      } else {
        process.env.KANDELO_NO_OPCACHE_PREWARM = previousSkip;
      }
    }
  }, 60_000);
});

function createPrewarmFs(): MemoryFileSystem {
  const fs = MemoryFileSystem.create(new SharedArrayBuffer(64 * 1024 * 1024));
  for (const dir of [
    "/tmp",
    "/var/www",
    "/var/cache",
    "/usr/lib/php/extensions",
  ]) {
    ensureDirRecursive(fs, dir);
  }
  writeVfsBinary(
    fs,
    "/usr/lib/php/extensions/opcache.so",
    readFileSync(opcachePath!),
    0o755,
  );
  return fs;
}

async function runPhpFromImage(
  imageBytes: Uint8Array,
  script: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const phpBytes = readFileSync(phpPath!);
  const programBytes = phpBytes.buffer.slice(
    phpBytes.byteOffset,
    phpBytes.byteOffset + phpBytes.byteLength,
  ) as ArrayBuffer;

  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];
  const host = new NodeKernelHost({
    rootfsImage: imageBytes,
    onStdout: (_pid, data) => stdoutChunks.push(new Uint8Array(data)),
    onStderr: (_pid, data) => stderrChunks.push(new Uint8Array(data)),
  });

  await host.init();
  try {
    const exitCode = await host.spawn(
      programBytes,
      ["php", ...PHP_RUNTIME_INI_ARGS, "-r", script],
      { env: ["HOME=/tmp", "TMPDIR=/tmp"] },
    );
    return {
      exitCode,
      stdout: Buffer.concat(stdoutChunks).toString(),
      stderr: Buffer.concat(stderrChunks).toString(),
    };
  } finally {
    await host.destroy().catch(() => {});
  }
}
