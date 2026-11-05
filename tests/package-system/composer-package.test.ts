import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { extractZipEntry, parseZipCentralDirectory } from "../../host/src/vfs/zip";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kandelo-composer-")));
  roots.push(root);
  for (const dir of ["source", "php", "work", "out"]) mkdirSync(join(root, dir));
  const phar = Buffer.from("<?php __HALT_COMPILER(); ?>\0signed PHAR bytes\xff", "binary");
  writeFileSync(join(root, "source/source.phar"), phar);
  writeFileSync(join(root, "source.archive"), phar);
  for (const name of ["phar", "curl", "zip"]) {
    writeFileSync(join(root, `php/${name}.so`), `${name} side-module fixture`);
  }
  const env = {
    ...process.env,
    WASM_POSIX_RESOLUTION_POLICY: "source-only-v1",
    WASM_POSIX_DEP_TARGET_ARCH: "wasm32",
    WASM_POSIX_DEP_OUT_DIR: join(root, "out"),
    WASM_POSIX_DEP_WORK_DIR: join(root, "work"),
    WASM_POSIX_DEP_SOURCE_DIR: join(root, "source"),
    WASM_POSIX_DEP_SOURCE_ARCHIVE: join(root, "source.archive"),
    WASM_POSIX_DEP_PHP_DIR: join(root, "php"),
  };
  return { root, phar, env };
}

it("packages exact PHAR and extension bytes with a runnable launcher reproducibly", () => {
  const outputs: Buffer[] = [];
  for (let index = 0; index < 2; index += 1) {
    const { root, phar, env } = fixture();
    execFileSync("bash", ["packages/registry/composer/build-composer.sh"], { cwd: repo, env });
    const bytes = readFileSync(join(root, "out/composer.zip"));
    outputs.push(bytes);
    const entries = parseZipCentralDirectory(bytes);
    const entry = (name: string) => {
      const found = entries.find((candidate) => candidate.fileName === name);
      expect(found, name).toBeDefined();
      return found!;
    };
    expect(Buffer.from(extractZipEntry(bytes, entry("share/composer/composer.phar")))).toEqual(phar);
    for (const name of ["phar", "curl", "zip"]) {
      expect(Buffer.from(extractZipEntry(bytes, entry(`lib/composer/${name}.so`))))
        .toEqual(readFileSync(join(root, `php/${name}.so`)));
    }
    expect(entry("bin/composer").mode & 0o777).toBe(0o755);
    expect(Buffer.from(extractZipEntry(bytes, entry("bin/composer"))))
      .toEqual(readFileSync(join(repo, "packages/registry/composer/composer")));
  }
  expect(outputs[0]).toEqual(outputs[1]);
});

it("rejects a symlink in place of a resolver-owned PHP extension", () => {
  const { root, env } = fixture();
  rmSync(join(root, "php/phar.so"));
  symlinkSync("curl.so", join(root, "php/phar.so"));
  const result = spawnSync("bash", ["packages/registry/composer/build-composer.sh"], {
    cwd: repo, env, encoding: "utf8",
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("PHP phar extension");
});
