import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
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
      const fs = KandeloImageFs.create();
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

  // The nginx-php image keeps opcache.validate_timestamps=1, so its runtime
  // discards (and unlinks) any entry whose recorded source mtime differs
  // from the shipped file's. The shipped mtime is SOURCE_DATE_EPOCH — set
  // here to the Nix dev shell's value, which differs from the reference
  // instant the live tree carries — so the prewarm must compile against the
  // timestamps the image is exported with.
  it("writes entries a timestamp-validating runtime accepts", async () => {
    const previousSkip = process.env.KANDELO_NO_OPCACHE_PREWARM;
    const previousEpoch = process.env.SOURCE_DATE_EPOCH;
    delete process.env.KANDELO_NO_OPCACHE_PREWARM;
    process.env.SOURCE_DATE_EPOCH = "315532800";

    try {
      const fs = createPrewarmFs();
      writeVfsFile(fs, "/var/www/hit.php", "<?php echo 'cached-ok';\n");

      const written = await prewarmOpcache(fs, {
        sourceRoots: ["/var/www"],
        label: "validated-timestamps-test",
      });
      expect(written).toBeGreaterThanOrEqual(1);

      // Replace the source. A runtime that accepts the prewarmed entry still
      // prints the cached output; one that rejects it recompiles and fails.
      // The export below stamps the same instant the shipped image carries.
      writeVfsFile(fs, "/var/www/hit.php", "<?php this is invalid php ;\n");

      const { exitCode, stdout, stderr } = await runPhpFromImage(
        await fs.saveImage({ normalizeTimestampsMs: 315532800 * 1000 }),
        "require '/var/www/hit.php';",
        ["-d", "opcache.validate_timestamps=1", "-d", "opcache.revalidate_freq=0"],
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
      if (previousEpoch === undefined) {
        delete process.env.SOURCE_DATE_EPOCH;
      } else {
        process.env.SOURCE_DATE_EPOCH = previousEpoch;
      }
    }
  }, 60_000);

  // Image packages ship the prewarmed cache, so the prewarm must be a pure
  // function of its inputs: two runs over the same tree, seconds apart, must
  // write byte-identical .bin files. Timestamp validation stays at PHP's
  // default (on), as in the nginx-php image, because that is the mode in
  // which opcache records per-compile wall-clock state
  // (`dynamic_members.revalidate`); packages/registry/php/build-php.sh keeps
  // it out of the file cache.
  it("writes byte-identical cache files when run again later", async () => {
    const previousSkip = process.env.KANDELO_NO_OPCACHE_PREWARM;
    delete process.env.KANDELO_NO_OPCACHE_PREWARM;

    try {
      const runOnce = async (): Promise<Map<string, string>> => {
        const fs = createPrewarmFs();
        writeVfsFile(
          fs,
          "/var/www/index.php",
          "<?php function greet($n) { return \"hi $n\"; }\necho greet('x');\n",
        );
        const written = await prewarmOpcache(fs, {
          sourceRoots: ["/var/www"],
          label: "reproducibility-test",
        });
        expect(written).toBeGreaterThanOrEqual(1);
        return cacheFileDigests(fs);
      };

      const first = await runOnce();
      // PHP's request time has one-second resolution; make sure the second
      // run cannot share the first run's second.
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      const second = await runOnce();

      expect(first.size).toBeGreaterThanOrEqual(1);
      expect([...second.entries()]).toEqual([...first.entries()]);
    } finally {
      if (previousSkip === undefined) {
        delete process.env.KANDELO_NO_OPCACHE_PREWARM;
      } else {
        process.env.KANDELO_NO_OPCACHE_PREWARM = previousSkip;
      }
    }
  }, 120_000);
});

/** `path -> sha256` for every file the prewarm wrote under /var/cache/opcache. */
function cacheFileDigests(fs: KandeloImageFs): Map<string, string> {
  const digests = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const name of fs.readDirNames(dir).sort()) {
      if (name === "." || name === "..") continue;
      const path = `${dir}/${name}`;
      if ((fs.lstat(path).mode & 0o170000) === 0o040000) {
        walk(path);
      } else {
        digests.set(
          path,
          createHash("sha256").update(fs.readFile(path)).digest("hex"),
        );
      }
    }
  };
  walk("/var/cache/opcache");
  return digests;
}

function createPrewarmFs(): KandeloImageFs {
  const fs = KandeloImageFs.create();
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
  extraIniArgs: string[] = [],
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
      ["php", ...PHP_RUNTIME_INI_ARGS, ...extraIniArgs, "-r", script],
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
