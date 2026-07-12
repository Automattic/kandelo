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
