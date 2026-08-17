import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parsePackageRuntimeFileContract,
  readPackageRuntimeFileContract,
} from "../../scripts/package-runtime-file";
import { findRepoRoot } from "../src/binary-resolver";

function metadata(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    artifact: "icu.dat",
    guest_path: "/usr/lib/php/icu.dat",
    mode: 0o644,
    mirror_path: "php/icu.dat",
    closure_mirror_paths: ["php/php.wasm", "php/intl.so", "php/icu.dat"],
    ...overrides,
  });
}

describe("package runtime-file closure metadata", () => {
  it("reports every declared PHP output and runtime file", () => {
    const contract = readPackageRuntimeFileContract(
      findRepoRoot(),
      "php",
      "icu.dat",
    );
    expect(contract.closureMirrorPaths).toEqual([
      "php/php.wasm",
      "php/php-fpm.wasm",
      "php/opcache.so",
      "php/curl.so",
      "php/phar.so",
      "php/zend_test.so",
      "php/zip.so",
      "php/intl.so",
      "php/icu.dat",
    ]);
  }, 120_000);

  it("uses an explicitly prepared xtask without ambient host tools", () => {
    const root = mkdtempSync(join(tmpdir(), "kandelo-runtime-metadata-"));
    const xtask = join(root, "xtask");
    writeFileSync(
      xtask,
      `#!/bin/sh
[ "$#" = 4 ]
[ "$1" = build-deps ]
[ "$2" = runtime-file-metadata ]
[ "$3" = php ]
[ "$4" = icu.dat ]
printf '%s\\n' '${metadata()}'
`,
    );
    chmodSync(xtask, 0o755);
    const savedXtask = process.env.WASM_POSIX_XTASK_BIN;
    const hadSavedXtask = Object.prototype.hasOwnProperty.call(
      process.env,
      "WASM_POSIX_XTASK_BIN",
    );
    const savedPath = process.env.PATH;
    const hadSavedPath = Object.prototype.hasOwnProperty.call(
      process.env,
      "PATH",
    );
    process.env.WASM_POSIX_XTASK_BIN = xtask;
    process.env.PATH = "";
    try {
      expect(readPackageRuntimeFileContract(findRepoRoot(), "php", "icu.dat"))
        .toEqual({
          artifact: "icu.dat",
          guestPath: "/usr/lib/php/icu.dat",
          mode: 0o644,
          mirrorPath: "php/icu.dat",
          closureMirrorPaths: [
            "php/php.wasm",
            "php/intl.so",
            "php/icu.dat",
          ],
        });
    } finally {
      if (hadSavedXtask) {
        process.env.WASM_POSIX_XTASK_BIN = savedXtask ?? "";
      } else {
        delete process.env.WASM_POSIX_XTASK_BIN;
      }
      if (hadSavedPath) {
        process.env.PATH = savedPath ?? "";
      } else {
        delete process.env.PATH;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a prepared xtask path that is not a regular file", () => {
    const root = mkdtempSync(join(tmpdir(), "kandelo-runtime-metadata-"));
    const savedXtask = process.env.WASM_POSIX_XTASK_BIN;
    const hadSavedXtask = Object.prototype.hasOwnProperty.call(
      process.env,
      "WASM_POSIX_XTASK_BIN",
    );
    process.env.WASM_POSIX_XTASK_BIN = root;
    try {
      expect(() =>
        readPackageRuntimeFileContract(findRepoRoot(), "php", "icu.dat")
      ).toThrow(/Prepared xtask is not a regular file/);
    } finally {
      if (hadSavedXtask) {
        process.env.WASM_POSIX_XTASK_BIN = savedXtask ?? "";
      } else {
        delete process.env.WASM_POSIX_XTASK_BIN;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects duplicate or incomplete closure path metadata", () => {
    expect(() => parsePackageRuntimeFileContract(
      metadata({
        closure_mirror_paths: ["php/php.wasm", "php/icu.dat", "php/icu.dat"],
      }),
      "php",
      "icu.dat",
    )).toThrow(/invalid runtime-file metadata/);

    expect(() => parsePackageRuntimeFileContract(
      metadata({ closure_mirror_paths: ["php/php.wasm", "php/intl.so"] }),
      "php",
      "icu.dat",
    )).toThrow(/invalid runtime-file metadata/);
  });

  it("rejects closure mirror traversal before binary resolution", () => {
    expect(() => parsePackageRuntimeFileContract(
      metadata({
        closure_mirror_paths: ["php/php.wasm", "../outside", "php/icu.dat"],
      }),
      "php",
      "icu.dat",
    )).toThrow(/invalid runtime-file metadata/);
  });
});
