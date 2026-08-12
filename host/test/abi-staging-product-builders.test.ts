import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zstdCompressSync } from "node:zlib";
import { gzipSync, zipSync, type Zippable } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRepositoryPathBundle,
} from "../../images/vfs/scripts/staged-product-inputs";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import { derivePackageDeferredZipTree } from "../src/vfs/package-deferred-tree";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const catalogPath = join(repoRoot, "images/vfs/products/generated/catalog.json");
const cleanupDirectories = new Set<string>();
const SOURCE = {
  repository: "kandelo-dev/kandelo",
  commit: "a".repeat(40),
  tree: "b".repeat(40),
};
const TARGET_ABI = {
  version: 7,
  snapshot_sha256: "c".repeat(64),
};

afterEach(() => {
  for (const directory of cleanupDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  cleanupDirectories.clear();
});

describe("ABI staging product builders", () => {
  it("builds platform-rootfs only from its exact declared source and package inputs", () => {
    const fixture = platformRootfsFixture();
    const result = runBuilder(
      "packages/registry/rootfs/build-rootfs-package.sh",
      fixture,
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(existsSync(fixture.outputPath)).toBe(true);
    expect(existsSync(fixture.reportPath)).toBe(true);
    const report = JSON.parse(readFileSync(fixture.reportPath, "utf8"));
    expect(report.capture).toEqual({ complete: true, unreported_reads: [] });
    expect(report.inputs.map((input: { id: string }) => input.id)).toEqual(
      fixture.inputIds,
    );
    expect(report.output.abi).toEqual(TARGET_ABI);

    const bytes = new Uint8Array(readFileSync(fixture.outputPath));
    expect(MemoryFileSystem.readImageMetadata(bytes)).toMatchObject({
      kernelAbi: TARGET_ABI.version,
      abiSnapshotSha256: TARGET_ABI.snapshot_sha256,
    });
    const fs = MemoryFileSystem.fromImage(bytes);
    expect(fs.isPathDeferred("/usr/bin/dash")).toBe(true);
    expect(fs.getLazyEntry("/usr/bin/dash")?.url).toMatch(
      /^https:\/\/artifacts\.example\.test\/.+sha256=[0-9a-f]{64}$/,
    );
    expect(readVfsFile(fs, "/usr/share/misc/magic.mgc")).toBe(
      "embedded file-magic\n",
    );
    expect(readVfsFile(fs, "/etc/os-release")).toContain('NAME="kandelo"');
  }, 30_000);

  it("fails before output for an omitted repository input or undeclared package input", () => {
    const omitted = platformRootfsFixture();
    const omittedDocument = JSON.parse(
      readFileSync(omitted.inputsPath, "utf8"),
    );
    omittedDocument.inputs = omittedDocument.inputs.filter(
      (input: { id: string }) => input.id !== "repository-rootfs-source",
    );
    writeFileSync(omitted.inputsPath, canonicalJson(omittedDocument));
    const missingResult = runBuilder(
      "packages/registry/rootfs/build-rootfs-package.sh",
      omitted,
    );
    expect(missingResult.status).not.toBe(0);
    expect(missingResult.stderr).toMatch(/rootfs-source|not declared/);
    expect(existsSync(omitted.outputPath)).toBe(false);
    expect(existsSync(omitted.reportPath)).toBe(false);

    const extra = platformRootfsFixture();
    const extraDocument = JSON.parse(readFileSync(extra.inputsPath, "utf8"));
    const contents = "undeclared package bytes";
    const digest = sha256(contents);
    extraDocument.inputs.push({
      architecture: "wasm32",
      bytes: Buffer.byteLength(contents),
      declared_materialization: "lazy",
      effective_materialization: "lazy-reference",
      id: "package-undeclared-output-extra",
      kind: "package-output",
      reference: `https://artifacts.example.test/extra?sha256=${digest}`,
      role: "runtime",
      sha256: digest,
    });
    extraDocument.inputs.sort(
      (left: { id: string }, right: { id: string }) =>
        left.id.localeCompare(right.id),
    );
    writeFileSync(extra.inputsPath, canonicalJson(extraDocument));
    const extraResult = runBuilder(
      "packages/registry/rootfs/build-rootfs-package.sh",
      extra,
    );
    expect(extraResult.status).not.toBe(0);
    expect(extraResult.stderr).toContain("unconsumed resolved package output");
    expect(existsSync(extra.outputPath)).toBe(false);
    expect(existsSync(extra.reportPath)).toBe(false);
  }, 30_000);

  it("builds browser-main-shell with embedded Bash and lazy browser demo layers", async () => {
    const fixture = await browserMainShellFixture();
    const result = runBuilder(
      "scripts/build-homebrew-main-shell-product.sh",
      fixture,
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const report = JSON.parse(readFileSync(fixture.reportPath, "utf8"));
    expect(report.capture).toEqual({ complete: true, unreported_reads: [] });
    expect(report.inputs.map((input: { id: string }) => input.id)).toEqual(
      fixture.inputIds,
    );
    expect(report.output.abi).toEqual(TARGET_ABI);

    const image = new Uint8Array(readFileSync(fixture.outputPath));
    const fs = MemoryFileSystem.fromImage(image);
    await fs.verifyImportedLazyAtomicGroupSeals();
    expect(MemoryFileSystem.readImageMetadata(image)).toMatchObject({
      kernelAbi: TARGET_ABI.version,
      abiSnapshotSha256: TARGET_ABI.snapshot_sha256,
    });
    expect(fs.isPathDeferred("/opt/kandelo/homebrew/bin/bash")).toBe(false);
    expect(fs.isPathDeferred("/opt/kandelo/homebrew/bin/fbdoom")).toBe(true);
    expect(fs.isPathDeferred("/opt/kandelo/homebrew/bin/modeset")).toBe(true);
    expect(fs.isPathDeferred("/usr/bin/dash")).toBe(true);
    expect(fs.readlink("/usr/bin/dash")).toBe(
      "/opt/kandelo/homebrew/bin/dash",
    );
    expect(fs.readlink("/usr/local/bin/fbdoom")).toBe(
      "/opt/kandelo/homebrew/bin/fbdoom",
    );
    expect(fs.readlink("/usr/local/bin/modeset")).toBe(
      "/opt/kandelo/homebrew/bin/modeset",
    );
    expect(fs.readlink("/usr/bin/brew")).toBe(
      "/opt/kandelo/homebrew/bin/brew",
    );
    expect(fs.isPathDeferred("/opt/kandelo/homebrew/bin/brew")).toBe(true);
    expect(readVfsFile(fs, "/etc/homebrew/brew.env")).toContain(
      "HOMEBREW_KANDELO_BOTTLE_TAG=wasm32_kandelo",
    );
    expect(readVfsFile(fs, "/etc/kandelo/shell.json")).toContain(
      "/opt/kandelo/homebrew/bin/bash",
    );
    expect(readVfsFile(fs, "/etc/kandelo/demo.json")).toContain("doom");
    expect(
      fs.exportLazyArchiveEntries().every((entry) =>
        entry.content?.transports.every((url) =>
          url.includes(`homebrew-tap-core-abi-${TARGET_ABI.version}-candidates/`) ||
          url.includes("package-candidates/")
        ) ?? true
      ),
    ).toBe(true);
  }, 30_000);

  it("rebuilds browser-main-shell from canonical bottle and product references", async () => {
    const fixture = await browserMainShellFixture("canonical");
    const result = runBuilder(
      "scripts/build-homebrew-main-shell-product.sh",
      fixture,
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const image = new Uint8Array(readFileSync(fixture.outputPath));
    const fs = MemoryFileSystem.fromImage(image);
    await fs.verifyImportedLazyAtomicGroupSeals();
    const transports = fs.exportLazyArchiveEntries().flatMap(
      (entry) => entry.content?.transports ?? [],
    );
    expect(transports.some((url) =>
      url.includes(`homebrew-tap-core-abi-${TARGET_ABI.version}-candidates/`)
    )).toBe(false);
    expect(transports.some((url) =>
      url.includes(`homebrew-tap-core-abi-${TARGET_ABI.version}/`)
    )).toBe(true);
  }, 30_000);

  it("rejects a main-shell bottle whose closure proof names an undeclared root", async () => {
    const fixture = await browserMainShellFixture();
    const inputs = JSON.parse(readFileSync(fixture.inputsPath, "utf8"));
    const fbdoom = inputs.inputs.find(
      (input: { id: string }) => input.id === "homebrew-fbdoom",
    );
    const descriptorPath = join(fixture.directory, fbdoom.descriptor.path);
    const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8"));
    descriptor.required_by = ["rogue"];
    const descriptorText = canonicalJson(descriptor);
    writeFileSync(descriptorPath, descriptorText);
    const descriptorSha = sha256(descriptorText);
    fbdoom.descriptor.bytes = Buffer.byteLength(descriptorText);
    fbdoom.descriptor.sha256 = descriptorSha;
    fbdoom.descriptor.reference =
      `https://artifacts.example.test/homebrew-tap-core-abi-${TARGET_ABI.version}-candidates/fbdoom-metadata?sha256=${descriptorSha}`;
    writeFileSync(fixture.inputsPath, canonicalJson(inputs));

    const result = runBuilder(
      "scripts/build-homebrew-main-shell-product.sh",
      fixture,
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/dependency roots.*product-declared/);
    expect(existsSync(fixture.outputPath)).toBe(false);
    expect(existsSync(fixture.reportPath)).toBe(false);
  }, 30_000);

  it("rejects a bottle descriptor from a candidate namespace for another ABI", async () => {
    const fixture = await browserMainShellFixture();
    const inputs = JSON.parse(readFileSync(fixture.inputsPath, "utf8"));
    const fbdoom = inputs.inputs.find(
      (input: { id: string }) => input.id === "homebrew-fbdoom",
    );
    const descriptorPath = join(fixture.directory, fbdoom.descriptor.path);
    const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8"));
    const wrongNamespace =
      `homebrew-tap-core-abi-${TARGET_ABI.version + 1}-candidates/`;
    descriptor.tree.transports[0].url =
      descriptor.tree.transports[0].url.replace(
        `homebrew-tap-core-abi-${TARGET_ABI.version}-candidates/`,
        wrongNamespace,
      );
    const descriptorText = canonicalJson(descriptor);
    writeFileSync(descriptorPath, descriptorText);
    const descriptorSha = sha256(descriptorText);
    fbdoom.descriptor.bytes = Buffer.byteLength(descriptorText);
    fbdoom.descriptor.sha256 = descriptorSha;
    fbdoom.descriptor.reference =
      `https://artifacts.example.test/${wrongNamespace}fbdoom-metadata?sha256=${descriptorSha}`;
    fbdoom.reference = fbdoom.reference.replace(
      `homebrew-tap-core-abi-${TARGET_ABI.version}-candidates/`,
      wrongNamespace,
    );
    writeFileSync(fixture.inputsPath, canonicalJson(inputs));

    const result = runBuilder(
      "scripts/build-homebrew-main-shell-product.sh",
      fixture,
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/exact target ABI namespace/);
    expect(existsSync(fixture.outputPath)).toBe(false);
    expect(existsSync(fixture.reportPath)).toBe(false);
  }, 30_000);

  it("builds browser service products from their complete declared inputs", async () => {
    const shellFixture = await browserMainShellFixture();
    const shellResult = runBuilder(
      "scripts/build-homebrew-main-shell-product.sh",
      shellFixture,
    );
    expect(
      shellResult.status,
      `${shellResult.stdout}\n${shellResult.stderr}`,
    ).toBe(0);
    const shellImage = new Uint8Array(readFileSync(shellFixture.outputPath));

    for (const productId of [
      "browser-node",
      "browser-nginx",
      "browser-nginx-php",
    ]) {
      const fixture = serviceProductFixture(productId, shellImage);
      const result = runBuilder(productBuilder(productId), fixture);
      expect(
        result.status,
        `${productId}\n${result.stdout}\n${result.stderr}`,
      ).toBe(0);
      const report = JSON.parse(readFileSync(fixture.reportPath, "utf8"));
      expect(report.capture).toEqual({ complete: true, unreported_reads: [] });
      expect(report.inputs.map((input: { id: string }) => input.id)).toEqual(
        fixture.inputIds,
      );
      expect(report.output.abi).toEqual(TARGET_ABI);
      const fs = MemoryFileSystem.fromImage(
        new Uint8Array(readFileSync(fixture.outputPath)),
      );
      const principal = productId === "browser-node"
        ? "/usr/bin/node"
        : "/usr/sbin/nginx";
      expect(fs.stat(principal).size).toBeGreaterThan(0);
      if (productId !== "browser-node") {
        expect(fs.stat("/sbin/dinit").size).toBeGreaterThan(0);
        expect(readVfsFile(fs, "/etc/services")).toMatch(/http\s+80\/tcp/);
      }
    }
  }, 90_000);

  it.each([
    "browser-node",
    "browser-nginx",
    "browser-nginx-php",
    "browser-wordpress",
    "browser-lamp",
  ])("rejects an undeclared input before building %s", (productId) => {
    const fixture = serviceProductFixture(
      productId,
      new TextEncoder().encode("unread invalid shell fixture"),
    );
    const document = JSON.parse(readFileSync(fixture.inputsPath, "utf8"));
    const contents = new TextEncoder().encode("undeclared input");
    const path = join(fixture.directory, "files", "undeclared-input");
    writeFileSync(path, contents);
    document.inputs.push({
      architecture: "wasm32",
      bytes: contents.byteLength,
      declared_materialization: "build-only",
      effective_materialization: "build-only",
      id: "package-undeclared-output-extra",
      kind: "package-output",
      path: relative(fixture.directory, path),
      role: "build",
      sha256: sha256(contents),
    });
    document.inputs.sort(
      (left: { id: string }, right: { id: string }) =>
        left.id.localeCompare(right.id),
    );
    writeFileSync(fixture.inputsPath, canonicalJson(document));

    const result = runBuilder(productBuilder(productId), fixture);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("resolved input IDs differ");
    expect(existsSync(fixture.outputPath)).toBe(false);
    expect(existsSync(fixture.reportPath)).toBe(false);
  }, 30_000);

  it("rejects a missing exact PHP build program before ambient resolution", () => {
    const fixture = serviceProductFixture(
      "browser-nginx-php",
      new TextEncoder().encode("unread invalid shell fixture"),
    );
    const document = JSON.parse(readFileSync(fixture.inputsPath, "utf8"));
    document.inputs = document.inputs.filter(
      (input: { id: string }) =>
        input.id !== "package-php-output-php",
    );
    writeFileSync(fixture.inputsPath, canonicalJson(document));

    const result = runBuilder(productBuilder("browser-nginx-php"), fixture);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("package-php-output-php");
    expect(existsSync(fixture.outputPath)).toBe(false);
    expect(existsSync(fixture.reportPath)).toBe(false);
  });

  it("rejects an exact source archive that escapes its single root", () => {
    const fixture = serviceProductFixture(
      "browser-node",
      new TextEncoder().encode("unread invalid shell fixture"),
    );
    const document = JSON.parse(readFileSync(fixture.inputsPath, "utf8"));
    const input = document.inputs.find(
      (item: { id: string }) => item.id === "archive-npm-runtime",
    );
    const path = join(fixture.directory, input.path);
    const unsafe = gzipSync(tarBytes([{
      path: "package/../escape.js",
      contents: new TextEncoder().encode("escape\n"),
      mode: 0o644,
    }]), { level: 9 });
    writeFileSync(path, unsafe);
    input.bytes = unsafe.byteLength;
    input.sha256 = sha256(unsafe);
    writeFileSync(fixture.inputsPath, canonicalJson(document));

    const result = runBuilder(productBuilder("browser-node"), fixture);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/unsafe|canonical relative path/);
    expect(existsSync(fixture.outputPath)).toBe(false);
    expect(existsSync(fixture.reportPath)).toBe(false);
  });

  it("builds standalone products from exact embedded and lazy inputs", () => {
    const principals = new Map([
      ["browser-mariadb-wasm32", "/usr/sbin/mariadbd"],
      ["browser-mariadb-wasm64", "/usr/sbin/mariadbd"],
      ["browser-python", "/usr/bin/python3"],
      ["browser-perl", "/usr/bin/perl"],
      ["browser-redis", "/usr/local/bin/redis-server"],
      [
        "browser-erlang",
        "/usr/local/lib/erlang/erts-16.1.2/bin/beam.smp",
      ],
    ]);

    for (const [productId, principal] of principals) {
      const fixture = standaloneProductFixture(productId);
      const result = runBuilder(productBuilder(productId), fixture);
      expect(
        result.status,
        `${productId}\n${result.stdout}\n${result.stderr}`,
      ).toBe(0);
      const report = JSON.parse(readFileSync(fixture.reportPath, "utf8"));
      expect(report.capture).toEqual({ complete: true, unreported_reads: [] });
      expect(report.inputs.map((input: { id: string }) => input.id)).toEqual(
        fixture.inputIds,
      );
      expect(report.output.abi).toEqual(TARGET_ABI);

      const image = new Uint8Array(readFileSync(fixture.outputPath));
      expect(MemoryFileSystem.readImageMetadata(image)).toMatchObject({
        kernelAbi: TARGET_ABI.version,
        abiSnapshotSha256: TARGET_ABI.snapshot_sha256,
      });
      const fs = MemoryFileSystem.fromImage(image);
      expect(fs.stat(principal).size).toBeGreaterThan(0);
      if (productId === "browser-perl") {
        expect(fs.isPathDeferred(principal)).toBe(true);
        expect(readVfsFile(fs, "/usr/lib/perl5/5.40.3/strict.pm")).toContain(
          "strict",
        );
      } else {
        expect(fs.isPathDeferred(principal)).toBe(false);
      }
      if (productId === "browser-python") {
        expect(readVfsFile(fs, "/usr/lib/python3.13/os.py")).toContain(
          "fixture",
        );
      }
      if (productId.startsWith("browser-mariadb") || productId === "browser-redis") {
        expect(fs.stat("/sbin/dinit").size).toBeGreaterThan(0);
        expect(readVfsFile(fs, "/etc/services")).toMatch(/http\s+80\/tcp/);
      }
    }
  }, 90_000);

  it.each([
    ["browser-mariadb-wasm32", "package-mariadb-source-role-system-tables"],
    ["browser-redis", "package-dinit-output-dinit"],
    ["browser-erlang", "package-erlang-output-erlang-otp"],
  ])("rejects a missing exact standalone input for %s", (productId, inputId) => {
    const fixture = standaloneProductFixture(productId);
    if (productId === "browser-redis") {
      const undeclaredCache = join(
        fixture.directory,
        ".cache",
        "kandelo",
        "dinit.wasm",
      );
      mkdirSync(dirname(undeclaredCache), { recursive: true });
      writeFileSync(undeclaredCache, minimalWasm());
    }
    const document = JSON.parse(readFileSync(fixture.inputsPath, "utf8"));
    document.inputs = document.inputs.filter(
      (input: { id: string }) => input.id !== inputId,
    );
    writeFileSync(fixture.inputsPath, canonicalJson(document));

    const result = runBuilder(productBuilder(productId), fixture);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(inputId);
    expect(existsSync(fixture.outputPath)).toBe(false);
    expect(existsSync(fixture.reportPath)).toBe(false);
  });

  it("rejects an extra MariaDB source role before building", () => {
    const fixture = standaloneProductFixture("browser-mariadb-wasm32");
    const document = JSON.parse(readFileSync(fixture.inputsPath, "utf8"));
    const id = "package-mariadb-source-role-undeclared";
    const path = join(fixture.directory, "files", `${id}.tar.gz`);
    const bytes = sourceRoleArchive("mariadb", "undeclared");
    writeFileSync(path, bytes);
    document.inputs.push({
      architecture: "wasm32",
      bytes: bytes.byteLength,
      declared_materialization: "embedded",
      effective_materialization: "embedded",
      id,
      kind: "package-output",
      path: relative(fixture.directory, path),
      role: "runtime",
      sha256: sha256(bytes),
    });
    document.inputs.sort(
      (left: { id: string }, right: { id: string }) =>
        left.id.localeCompare(right.id),
    );
    writeFileSync(fixture.inputsPath, canonicalJson(document));

    const result = runBuilder(
      productBuilder("browser-mariadb-wasm32"),
      fixture,
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("resolved input IDs differ");
    expect(existsSync(fixture.outputPath)).toBe(false);
    expect(existsSync(fixture.reportPath)).toBe(false);
  });

  it("rejects eager Perl bytes and a cross-architecture MariaDB input", () => {
    const perl = standaloneProductFixture("browser-perl");
    const perlDocument = JSON.parse(readFileSync(perl.inputsPath, "utf8"));
    const perlInput = perlDocument.inputs.find(
      (input: { id: string }) => input.id === "package-perl-output-perl",
    );
    const perlPath = join(perl.directory, "files", perlInput.id);
    perlInput.effective_materialization = "embedded";
    perlInput.path = relative(perl.directory, perlPath);
    delete perlInput.reference;
    writeFileSync(perl.inputsPath, canonicalJson(perlDocument));
    const perlResult = runBuilder(productBuilder("browser-perl"), perl);
    expect(perlResult.status).not.toBe(0);
    expect(perlResult.stderr).toMatch(/materialization|lazy/);
    expect(existsSync(perl.outputPath)).toBe(false);

    const mariadb = standaloneProductFixture("browser-mariadb-wasm64");
    const mariadbDocument = JSON.parse(
      readFileSync(mariadb.inputsPath, "utf8"),
    );
    mariadbDocument.inputs[0].architecture = "wasm32";
    writeFileSync(mariadb.inputsPath, canonicalJson(mariadbDocument));
    const mariadbResult = runBuilder(
      productBuilder("browser-mariadb-wasm64"),
      mariadb,
    );
    expect(mariadbResult.status).not.toBe(0);
    expect(mariadbResult.stderr).toMatch(/architecture/);
    expect(existsSync(mariadb.outputPath)).toBe(false);
  });

  it("rejects incomplete Perl source and mismatched Erlang executables", () => {
    const perl = standaloneProductFixture("browser-perl");
    replaceResolvedInputBytes(
      perl,
      "package-perl-source-role-standard-library",
      gzipSync(tarBytes([{
        path: "standard-library/lib/strict.pm",
        contents: new TextEncoder().encode("package strict;\n"),
        mode: 0o644,
      }]), { level: 9 }),
    );
    const perlResult = runBuilder(productBuilder("browser-perl"), perl);
    expect(perlResult.status).not.toBe(0);
    expect(perlResult.stderr).toMatch(/cpan|ENOENT|no such file/i);
    expect(existsSync(perl.outputPath)).toBe(false);

    const erlang = standaloneProductFixture("browser-erlang");
    replaceResolvedInputBytes(
      erlang,
      "package-erlang-output-erlang",
      new TextEncoder().encode("different executable"),
    );
    const erlangResult = runBuilder(productBuilder("browser-erlang"), erlang);
    expect(erlangResult.status).not.toBe(0);
    expect(erlangResult.stderr).toContain(
      "differs from the OTP runtime boot executable",
    );
    expect(existsSync(erlang.outputPath)).toBe(false);
  });

  it("builds SDK and upstream-test products from every exact declared input", async () => {
    for (const productId of [
      "developer-kandelo-sdk",
      "test-mariadb",
      "test-php",
      "test-sqlite",
    ]) {
      const fixture = await sdkTestProductFixture(productId);
      const result = runBuilder(productBuilder(productId), fixture);
      expect(result.status, `${productId}\n${result.stdout}\n${result.stderr}`).toBe(0);

      const report = JSON.parse(readFileSync(fixture.reportPath, "utf8"));
      expect(report.capture).toEqual({ complete: true, unreported_reads: [] });
      expect(report.inputs.map((input: { id: string }) => input.id)).toEqual(
        fixture.inputIds,
      );
      expect(report.output.abi).toEqual(TARGET_ABI);
      const bytes = new Uint8Array(readFileSync(fixture.outputPath));
      expect(MemoryFileSystem.readImageMetadata(bytes)).toMatchObject({
        kernelAbi: TARGET_ABI.version,
        abiSnapshotSha256: TARGET_ABI.snapshot_sha256,
      });
      const fs = MemoryFileSystem.fromImage(bytes);
      if (productId === "developer-kandelo-sdk") {
        expect(readVfsFile(fs, "/usr/wasm32posix/sysroot/lib/libc.a")).toBe(
          "fixture libc\n",
        );
        expect(readVfsFile(fs, "/usr/wasm32posix/sysroot/lib/libc++.a")).toBe(
          "fixture libc++\n",
        );
        expect(readVfsFile(fs, "/usr/lib/llvm/lib/clang/21/include/stddef.h"))
          .toBe("/* fixture clang header */\n");
        expect(fs.stat("/usr/wasm32posix/glue-objects/channel_syscall.o").size)
          .toBeGreaterThan(0);
      } else if (productId === "test-mariadb") {
        const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
        const product = catalog.products.find(
          (entry: { manifest: { id: string } }) =>
            entry.manifest.id === "test-mariadb",
        );
        expect(product?.manifest.boot.argv).toEqual([
          "/sbin/dinit",
          "--container",
          "-p",
          "/tmp/dinitctl",
          "mariadb",
        ]);
        expect(fs.stat("/usr/bin/mysqltest").size).toBeGreaterThan(0);
        expect(readVfsFile(fs, "/mysql-test/main/1st.test")).toContain("1st");
        expect(readVfsFile(fs, "/etc/services")).toContain("mysql");
      } else if (productId === "test-php") {
        expect(fs.stat("/usr/local/bin/php").size).toBeGreaterThan(0);
        expect(fs.stat("/usr/local/sbin/php-fpm").size).toBeGreaterThan(0);
        for (const extension of [
          "opcache", "curl", "phar", "zend_test", "zip", "intl",
        ]) {
          expect(fs.stat(`/usr/lib/php/extensions/${extension}.so`).size)
            .toBeGreaterThan(0);
        }
        expect(fs.stat("/usr/lib/php/icu.dat").size).toBeGreaterThan(0);
        expect(readVfsFile(fs, "/php-src/ext/example/tests/basic.phpt"))
          .toContain("--TEST--");
        expect(existsSync(`${fixture.outputPath}.meta.json`)).toBe(false);
      } else {
        expect(fs.stat("/usr/bin/testfixture").size).toBeGreaterThan(0);
        expect(readVfsFile(fs, "/sqlite/test/basic.test")).toContain("fixture");
        expect(readVfsFile(fs, "/usr/lib/tcl8.6/init.tcl")).toContain("fixture");
      }
    }
  });

  it("rejects missing, ambient, substituted, or out-of-root SDK/test inputs", async () => {
    const missingToolchain = await sdkTestProductFixture("developer-kandelo-sdk");
    mutateResolvedInputs(missingToolchain, (document) => {
      document.inputs = document.inputs.filter(
        (input: { id: string }) => input.id !== "toolchain-clang-resource-headers",
      );
    });
    let result = runBuilder(productBuilder("developer-kandelo-sdk"), missingToolchain);
    expect(result.status).not.toBe(0);
    expect(existsSync(missingToolchain.outputPath)).toBe(false);
    expect(existsSync(missingToolchain.reportPath)).toBe(false);

    const ambientHeaders = await sdkTestProductFixture("developer-kandelo-sdk");
    mutateResolvedInputs(ambientHeaders, (document) => {
      const input = document.inputs.find(
        (item: { id: string }) => item.id === "toolchain-clang-resource-headers",
      );
      input.path = "/usr/include";
    });
    result = runBuilder(productBuilder("developer-kandelo-sdk"), ambientHeaders);
    expect(result.status).not.toBe(0);
    expect(existsSync(ambientHeaders.outputPath)).toBe(false);

    const missingMariaRole = await sdkTestProductFixture("test-mariadb");
    mutateResolvedInputs(missingMariaRole, (document) => {
      document.inputs = document.inputs.filter(
        (input: { id: string }) =>
          input.id !== "package-mariadb-source-role-test-suite",
      );
    });
    result = runBuilder(productBuilder("test-mariadb"), missingMariaRole);
    expect(result.status).not.toBe(0);
    expect(existsSync(missingMariaRole.outputPath)).toBe(false);

    const extraPhpFixture = await sdkTestProductFixture("test-php");
    const extraPath = join(extraPhpFixture.sourceRoot!, "tests/php-extra/extra.pem");
    mkdirSync(dirname(extraPath), { recursive: true });
    writeFileSync(extraPath, "undeclared fixture\n");
    mutateResolvedInputs(extraPhpFixture, (document) => {
      const input = document.inputs.find(
        (item: { id: string }) => item.id === "repository-php-test-fixtures",
      );
      const bundlePath = join(extraPhpFixture.directory, "files/php-extra-bundle.json");
      createRepositoryPathBundle({
        repositoryRoot: extraPhpFixture.sourceRoot!,
        paths: ["tests/php-extra", "tests/php-fixtures"],
        source: SOURCE,
        outputPath: bundlePath,
      });
      const bytes = readFileSync(bundlePath);
      input.path = relative(extraPhpFixture.directory, bundlePath);
      input.bytes = bytes.byteLength;
      input.sha256 = sha256(bytes);
    });
    result = runBuilder(productBuilder("test-php"), extraPhpFixture);
    expect(result.status).not.toBe(0);
    expect(existsSync(extraPhpFixture.outputPath)).toBe(false);

    const swappedSqlite = await sdkTestProductFixture("test-sqlite");
    const sqliteDocument = JSON.parse(readFileSync(swappedSqlite.inputsPath, "utf8"));
    const sqlite = sqliteDocument.inputs.find(
      (input: { id: string }) => input.id === "archive-sqlite-full-source",
    );
    const tcl = sqliteDocument.inputs.find(
      (input: { id: string }) => input.id === "package-tcl-source-role-runtime-library",
    );
    const sqliteBytes = readFileSync(join(swappedSqlite.directory, sqlite.path));
    const tclBytes = readFileSync(join(swappedSqlite.directory, tcl.path));
    writeFileSync(join(swappedSqlite.directory, sqlite.path), tclBytes);
    writeFileSync(join(swappedSqlite.directory, tcl.path), sqliteBytes);
    sqlite.bytes = tclBytes.byteLength;
    sqlite.sha256 = sha256(tclBytes);
    tcl.bytes = sqliteBytes.byteLength;
    tcl.sha256 = sha256(sqliteBytes);
    writeFileSync(swappedSqlite.inputsPath, canonicalJson(sqliteDocument));
    result = runBuilder(productBuilder("test-sqlite"), swappedSqlite);
    expect(result.status).not.toBe(0);
    expect(existsSync(swappedSqlite.outputPath)).toBe(false);

    const escapedExecutable = await sdkTestProductFixture("test-sqlite");
    mutateResolvedInputs(escapedExecutable, (document) => {
      const input = document.inputs.find(
        (item: { id: string }) => item.id === "package-sqlite-output-testfixture",
      );
      input.path = "../ambient-testfixture.wasm";
    });
    result = runBuilder(productBuilder("test-sqlite"), escapedExecutable);
    expect(result.status).not.toBe(0);
    expect(existsSync(escapedExecutable.outputPath)).toBe(false);
  });
});

interface BuilderFixture {
  directory: string;
  manifestPath: string;
  inputsPath: string;
  reportPath: string;
  outputPath: string;
  inputIds: string[];
  sourceRoot?: string;
}

function platformRootfsFixture(): BuilderFixture {
  const directory = mkdtempSync(join(tmpdir(), "kandelo-platform-rootfs-stage-"));
  cleanupDirectories.add(directory);
  const files = join(directory, "files");
  const temporary = join(directory, "tmp");
  mkdirSync(files);
  mkdirSync(temporary);

  const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  const product = catalog.products.find(
    (entry: { manifest: { id: string } }) =>
      entry.manifest.id === "platform-rootfs",
  );
  if (!product) throw new Error("platform-rootfs is missing from the product catalog");

  const repositoryBundle = join(files, "rootfs-source.json");
  createRepositoryPathBundle({
    repositoryRoot: repoRoot,
    paths: ["MANIFEST", "images/rootfs"],
    source: SOURCE,
    outputPath: repositoryBundle,
  });
  const repositoryBytes = readFileSync(repositoryBundle);
  const inputs: Array<Record<string, unknown>> = [
    {
      architecture: "wasm32",
      bytes: repositoryBytes.byteLength,
      declared_materialization: "embedded",
      effective_materialization: "embedded",
      id: "repository-rootfs-source",
      kind: "repository-path",
      path: relative(directory, repositoryBundle),
      role: "runtime",
      sha256: sha256(repositoryBytes),
    },
  ];

  for (const claim of product.manifest.software.package) {
    for (const output of claim.outputs) {
      const id = `package-${claim.name}-output-${output}`;
      const contents = output === "file-magic"
        ? "embedded file-magic\n"
        : `lazy bytes for ${id}\n`;
      const digest = sha256(contents);
      const common = {
        architecture: "wasm32",
        bytes: Buffer.byteLength(contents),
        declared_materialization: claim.materialization,
        id,
        kind: "package-output",
        role: "runtime",
        sha256: digest,
      };
      if (claim.materialization === "embedded") {
        const path = join(files, id);
        writeFileSync(path, contents);
        inputs.push({
          ...common,
          effective_materialization: "embedded",
          path: relative(directory, path),
        });
      } else {
        inputs.push({
          ...common,
          effective_materialization: "lazy-reference",
          reference: `https://artifacts.example.test/${id}?sha256=${digest}`,
        });
      }
    }
  }
  inputs.sort((left, right) =>
    String(left.id).localeCompare(String(right.id))
  );
  const inputsPath = join(directory, "resolved-inputs.json");
  writeFileSync(
    inputsPath,
    canonicalJson({
      build_environment: {
        dev_shell_lock_sha256: "d".repeat(64),
        policy_sha256: "e".repeat(64),
      },
      inputs,
      kind: "kandelo-resolved-vfs-product-inputs",
      product: {
        architecture: "wasm32",
        id: "platform-rootfs",
        manifest_path: product.path,
        manifest_sha256: product.sha256,
        output: product.manifest.output,
      },
      reference_class: "candidate",
      schema: 1,
      source: SOURCE,
      target_abi: TARGET_ABI,
    }),
  );
  return {
    directory,
    manifestPath: join(repoRoot, product.path),
    inputsPath,
    reportPath: join(directory, "builder-report.json"),
    outputPath: join(directory, product.manifest.output),
    inputIds: inputs.map((input) => String(input.id)),
  };
}

async function browserMainShellFixture(
  referenceClass: "candidate" | "canonical" = "candidate",
): Promise<BuilderFixture> {
  const directory = mkdtempSync(join(tmpdir(), "kandelo-main-shell-stage-"));
  cleanupDirectories.add(directory);
  const files = join(directory, "files");
  const temporary = join(directory, "tmp");
  mkdirSync(files);
  mkdirSync(temporary);

  const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  const product = catalog.products.find(
    (entry: { manifest: { id: string } }) =>
      entry.manifest.id === "browser-main-shell",
  );
  if (!product) throw new Error("browser-main-shell is missing from the product catalog");

  const baseFs = MemoryFileSystem.create(
    new SharedArrayBuffer(64 * 1024 * 1024),
  );
  for (const path of [
    "/bin",
    "/usr",
    "/usr/bin",
    "/usr/local",
    "/usr/local/bin",
    "/etc",
    "/etc/profile.d",
    "/home",
    "/home/user",
    "/tmp",
    "/opt",
    "/opt/kandelo",
  ]) {
    baseFs.mkdir(path, path === "/tmp" ? 0o1777 : 0o755);
  }
  baseFs.registerLazyFile(
    "/usr/bin/dash",
    "https://artifacts.example.test/platform-rootfs/dash?sha256=" +
      "f".repeat(64),
    8,
    0o755,
  );
  baseFs.createFileWithOwner(
    "/etc/services",
    0o644,
    0,
    0,
    new TextEncoder().encode("http 80/tcp\nhttps 443/tcp\n"),
  );
  const baseBytes = await baseFs.saveImage({
    normalizeTimestampsMs: 0,
    metadata: {
      version: 1,
      kernelAbi: TARGET_ABI.version,
      abiSnapshotSha256: TARGET_ABI.snapshot_sha256,
      createdBy: "abi-staging-product-builders.test.ts",
    },
  });
  const basePath = join(files, "platform-rootfs.vfs");
  writeFileSync(basePath, baseBytes);

  const repositoryBundle = join(files, "main-shell-config.json");
  const repositoryPaths = [
    "homebrew/main-shell-brew-package-tree.json",
    "homebrew/main-shell-compatibility.json",
    "homebrew/main-shell-default.json",
    "homebrew/main-shell-demo.json",
  ];
  createRepositoryPathBundle({
    repositoryRoot: repoRoot,
    paths: repositoryPaths,
    source: SOURCE,
    outputPath: repositoryBundle,
  });

  const baseSha256 = sha256(baseBytes);
  const baseReference = referenceClass === "canonical"
    ? `https://automattic.github.io/kandelo/products/platform-rootfs/sha256-${baseSha256}/platform-rootfs-${TARGET_ABI.version}.vfs.zst?sha256=${baseSha256}&bytes=${baseBytes.byteLength}`
    : `https://artifacts.example.test/homebrew-tap-core-abi-${TARGET_ABI.version}-candidates/products/platform-rootfs?sha256=${baseSha256}`;
  const inputs: Array<Record<string, any>> = [
    embeddedInput(
      "product-platform-rootfs",
      "product-image",
      basePath,
      directory,
      "embedded",
      baseReference,
    ),
    embeddedInput(
      "repository-main-shell-config",
      "repository-path",
      repositoryBundle,
      directory,
      "embedded",
      `https://artifacts.example.test/repository?sha256=${sha256(readFileSync(repositoryBundle))}`,
    ),
  ];

  for (const archive of product.manifest.software.archive) {
    const id = `archive-${archive.id}`;
    const path = join(files, `${id}.archive`);
    writeFileSync(path, sourceArchiveFixture(archive.id));
    inputs.push(resolvedFileInput({
      id,
      kind: "source-archive",
      path,
      root: directory,
      role: archive.role,
      declared: archive.role === "build"
        ? "build-only"
        : archive.materialization,
      architecture: product.manifest.architecture,
    }));
  }

  const formulaMaterialization = new Map<string, "embedded" | "lazy">();
  for (const group of product.manifest.software.homebrew) {
    for (const formula of group.formulae) {
      formulaMaterialization.set(formula, group.materialization);
    }
  }
  for (const formula of [...formulaMaterialization.keys()].sort()) {
    const materialization = formulaMaterialization.get(formula)!;
    const bottle = formula === "bash"
      ? testBottleArchive(formula)
      : {
          bytes: undefined,
          archiveBytes: 123,
          archiveSha256: sha256(`lazy bottle ${formula}\n`),
          expandedBytes: 8,
        };
    const namespace = referenceClass === "candidate"
      ? `homebrew-tap-core-abi-${TARGET_ABI.version}-candidates`
      : `homebrew-tap-core-abi-${TARGET_ABI.version}`;
    const reference =
      `https://artifacts.example.test/${namespace}/${formula}?sha256=${bottle.archiveSha256}`;
    const descriptor = originalBottleDescriptor({
      formula,
      archiveSha256: bottle.archiveSha256,
      archiveBytes: bottle.archiveBytes,
      expandedBytes: bottle.expandedBytes,
      reference,
    });
    const descriptorText = canonicalJson(descriptor);
    const descriptorSha = sha256(descriptorText);
    const descriptorPath = join(files, `homebrew-${formula}-metadata.json`);
    writeFileSync(descriptorPath, descriptorText);
    const value: Record<string, any> = {
      architecture: "wasm32",
      bytes: bottle.archiveBytes,
      declared_materialization: materialization,
      descriptor: {
        bytes: Buffer.byteLength(descriptorText),
        path: relative(directory, descriptorPath),
        reference:
          `https://artifacts.example.test/${namespace}/${formula}-metadata?sha256=${descriptorSha}`,
        sha256: descriptorSha,
      },
      effective_materialization:
        materialization === "embedded" ? "embedded" : "lazy-reference",
      id: `homebrew-${formula}`,
      kind: "homebrew-bottle",
      reference,
      role: "runtime",
      sha256: bottle.archiveSha256,
    };
    if (materialization === "embedded") {
      const bottlePath = join(files, `homebrew-${formula}.tar.gz`);
      writeFileSync(bottlePath, bottle.bytes!);
      value.path = relative(directory, bottlePath);
    }
    inputs.push(value);
  }

  const bootstrapArchive = testBootstrapArchive();
  const bootstrapSpec = JSON.parse(
    readFileSync(join(repoRoot, "homebrew/main-shell-brew-package-tree.json"), "utf8"),
  );
  const bootstrapTree = derivePackageDeferredZipTree(
    bootstrapSpec,
    bootstrapArchive,
  );
  const bootstrapDescriptorPath = join(files, "homebrew-bootstrap-tree.json");
  writeFileSync(bootstrapDescriptorPath, bootstrapTree.descriptorBytes);
  const bootstrapReference =
    `https://artifacts.example.test/package-candidates/homebrew-bootstrap.zip?sha256=${bootstrapTree.content.sha256}`;
  inputs.push({
    architecture: "wasm32",
    bytes: bootstrapArchive.byteLength,
    declared_materialization: "lazy",
    descriptor: {
      bytes: bootstrapTree.descriptorBytes.byteLength,
      path: relative(directory, bootstrapDescriptorPath),
      reference:
        `https://artifacts.example.test/package-candidates/homebrew-bootstrap-tree?sha256=${bootstrapTree.descriptorSha256}`,
      sha256: bootstrapTree.descriptorSha256,
    },
    effective_materialization: "lazy-reference",
    id: "package-homebrew-bootstrap-output-homebrew-bootstrap",
    kind: "package-output",
    reference: bootstrapReference,
    role: "runtime",
    sha256: bootstrapTree.content.sha256,
  });

  const environment = [
    "HOMEBREW_NO_ANALYTICS=1",
    "HOMEBREW_NO_AUTO_UPDATE=1",
    "HOMEBREW_NO_INSTALL_FROM_API=1",
    "HOMEBREW_AUTOMATICALLY_SET_NO_INSTALL_FROM_API=1",
    "HOMEBREW_SYSTEM_ENV_TAKES_PRIORITY=1",
    "HOMEBREW_KANDELO_BOTTLE_TAG=wasm32_kandelo",
    "",
  ].join("\n");
  const environmentPath = join(files, "homebrew-brew.env");
  writeFileSync(environmentPath, environment);
  inputs.push(embeddedInput(
    "package-homebrew-bootstrap-output-homebrew-brew",
    "package-output",
    environmentPath,
    directory,
    "embedded",
    `https://artifacts.example.test/package-candidates/homebrew-brew.env?sha256=${sha256(environment)}`,
  ));

  inputs.sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const inputsPath = join(directory, "resolved-inputs.json");
  writeFileSync(inputsPath, canonicalJson({
    build_environment: {
      dev_shell_lock_sha256: "d".repeat(64),
      policy_sha256: "e".repeat(64),
    },
    inputs,
    kind: "kandelo-resolved-vfs-product-inputs",
    product: {
      architecture: "wasm32",
      id: "browser-main-shell",
      manifest_path: product.path,
      manifest_sha256: product.sha256,
      output: product.manifest.output,
    },
    reference_class: referenceClass,
    schema: 1,
    source: SOURCE,
    target_abi: TARGET_ABI,
  }));
  return {
    directory,
    manifestPath: join(repoRoot, product.path),
    inputsPath,
    reportPath: join(directory, "builder-report.json"),
    outputPath: join(directory, product.manifest.output),
    inputIds: inputs.map((input) => String(input.id)),
  };
}

function serviceProductFixture(
  productId: string,
  shellImage: Uint8Array,
): BuilderFixture {
  const directory = mkdtempSync(join(tmpdir(), `kandelo-${productId}-stage-`));
  cleanupDirectories.add(directory);
  const files = join(directory, "files");
  const temporary = join(directory, "tmp");
  mkdirSync(files);
  mkdirSync(temporary);

  const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  const product = catalog.products.find(
    (entry: { manifest: { id: string } }) => entry.manifest.id === productId,
  );
  if (!product) throw new Error(`${productId} is missing from the product catalog`);

  const inputs: Array<Record<string, unknown>> = [];
  for (const composition of product.manifest.composition.product) {
    const id = `product-${composition.id}`;
    const path = join(files, `${id}.vfs.zst`);
    writeFileSync(path, shellImage);
    inputs.push(resolvedFileInput({
      id,
      kind: "product-image",
      path,
      root: directory,
      role: "runtime",
      declared: composition.materialization,
      architecture: product.manifest.architecture,
    }));
  }
  for (const claim of product.manifest.software.package) {
    for (const output of claim.outputs) {
      const id = `package-${claim.name}-output-${output}`;
      const path = join(files, id);
      writeFileSync(path, minimalWasm());
      inputs.push(resolvedFileInput({
        id,
        kind: "package-output",
        path,
        root: directory,
        role: claim.role,
        declared: claim.role === "build"
          ? "build-only"
          : claim.materialization,
        architecture: product.manifest.architecture,
      }));
    }
    for (const sourceRole of claim.source_roles) {
      const id = `package-${claim.name}-source-role-${sourceRole}`;
      const path = join(files, `${id}.tar.gz`);
      writeFileSync(path, sourceRoleArchive(claim.name, sourceRole));
      inputs.push(resolvedFileInput({
        id,
        kind: "package-output",
        path,
        root: directory,
        role: claim.role,
        declared: claim.role === "build"
          ? "build-only"
          : claim.materialization,
        architecture: product.manifest.architecture,
      }));
    }
  }
  for (const archive of product.manifest.software.archive) {
    const id = `archive-${archive.id}`;
    const path = join(files, `${id}.archive`);
    writeFileSync(path, sourceArchiveFixture(archive.id));
    inputs.push(resolvedFileInput({
      id,
      kind: "source-archive",
      path,
      root: directory,
      role: archive.role,
      declared: archive.role === "build"
        ? "build-only"
        : archive.materialization,
      architecture: product.manifest.architecture,
    }));
  }
  inputs.sort((left, right) =>
    String(left.id).localeCompare(String(right.id))
  );

  const inputsPath = join(directory, "resolved-inputs.json");
  writeFileSync(inputsPath, canonicalJson({
    build_environment: {
      dev_shell_lock_sha256: "d".repeat(64),
      policy_sha256: "e".repeat(64),
    },
    inputs,
    kind: "kandelo-resolved-vfs-product-inputs",
    product: {
      architecture: product.manifest.architecture,
      id: productId,
      manifest_path: product.path,
      manifest_sha256: product.sha256,
      output: product.manifest.output,
    },
    reference_class: "candidate",
    schema: 1,
    source: SOURCE,
    target_abi: TARGET_ABI,
  }));
  return {
    directory,
    manifestPath: join(repoRoot, product.path),
    inputsPath,
    reportPath: join(directory, "builder-report.json"),
    outputPath: join(directory, product.manifest.output),
    inputIds: inputs.map((input) => String(input.id)),
  };
}

function standaloneProductFixture(productId: string): BuilderFixture {
  const directory = mkdtempSync(join(tmpdir(), `kandelo-${productId}-stage-`));
  cleanupDirectories.add(directory);
  const files = join(directory, "files");
  mkdirSync(files);
  mkdirSync(join(directory, "tmp"));

  const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  const product = catalog.products.find(
    (entry: { manifest: { id: string } }) => entry.manifest.id === productId,
  );
  if (!product) throw new Error(`${productId} is missing from the product catalog`);

  const inputs: Array<Record<string, unknown>> = [];
  for (const repository of product.manifest.composition.repository) {
    const id = `repository-${repository.id}`;
    const path = join(files, `${id}.json`);
    createRepositoryPathBundle({
      repositoryRoot: repoRoot,
      paths: repository.paths,
      source: SOURCE,
      outputPath: path,
    });
    inputs.push(resolvedFileInput({
      id,
      kind: "repository-path",
      path,
      root: directory,
      role: repository.role,
      declared: repository.materialization,
      architecture: product.manifest.architecture,
    }));
  }
  for (const claim of product.manifest.software.package) {
    for (const output of claim.outputs) {
      const id = `package-${claim.name}-output-${output}`;
      const path = join(files, id);
      writeFileSync(path, standaloneOutputFixture(claim.name, output));
      inputs.push(resolvedFileInput({
        id,
        kind: "package-output",
        path,
        root: directory,
        role: claim.role,
        declared: claim.role === "build"
          ? "build-only"
          : claim.materialization,
        architecture: product.manifest.architecture,
      }));
    }
    for (const sourceRole of claim.source_roles) {
      const id = `package-${claim.name}-source-role-${sourceRole}`;
      const path = join(files, `${id}.tar.gz`);
      writeFileSync(path, sourceRoleArchive(claim.name, sourceRole));
      inputs.push(resolvedFileInput({
        id,
        kind: "package-output",
        path,
        root: directory,
        role: claim.role,
        declared: claim.role === "build"
          ? "build-only"
          : claim.materialization,
        architecture: product.manifest.architecture,
      }));
    }
  }
  inputs.sort((left, right) =>
    String(left.id).localeCompare(String(right.id))
  );
  const inputsPath = join(directory, "resolved-inputs.json");
  writeFileSync(inputsPath, canonicalJson({
    build_environment: {
      dev_shell_lock_sha256: "d".repeat(64),
      policy_sha256: "e".repeat(64),
    },
    inputs,
    kind: "kandelo-resolved-vfs-product-inputs",
    product: {
      architecture: product.manifest.architecture,
      id: productId,
      manifest_path: product.path,
      manifest_sha256: product.sha256,
      output: product.manifest.output,
    },
    reference_class: "candidate",
    schema: 1,
    source: SOURCE,
    target_abi: TARGET_ABI,
  }));
  return {
    directory,
    manifestPath: join(repoRoot, product.path),
    inputsPath,
    reportPath: join(directory, "builder-report.json"),
    outputPath: join(directory, product.manifest.output),
    inputIds: inputs.map((input) => String(input.id)),
  };
}

async function sdkTestProductFixture(productId: string): Promise<BuilderFixture> {
  const directory = mkdtempSync(join(tmpdir(), `kandelo-${productId}-stage-`));
  cleanupDirectories.add(directory);
  const files = join(directory, "files");
  const sourceRoot = join(directory, "source");
  mkdirSync(files);
  mkdirSync(sourceRoot);
  mkdirSync(join(directory, "tmp"));
  writeSdkTestRepositoryFixtures(sourceRoot);

  const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  const product = catalog.products.find(
    (entry: { manifest: { id: string } }) => entry.manifest.id === productId,
  );
  if (!product) throw new Error(`${productId} is missing from the product catalog`);

  const inputs: Array<Record<string, unknown>> = [];
  for (const base of product.manifest.composition.product) {
    const path = join(files, `product-${base.id}.vfs`);
    const fs = MemoryFileSystem.create(
      new SharedArrayBuffer(8 * 1024 * 1024),
    );
    for (const guestPath of [
      "/bin", "/usr", "/usr/bin", "/usr/local", "/usr/local/bin",
      "/etc", "/root", "/tmp",
    ]) {
      fs.mkdir(guestPath, guestPath === "/tmp" ? 0o1777 : 0o755);
    }
    writeFileSync(path, await fs.saveImage({
      normalizeTimestampsMs: 0,
      metadata: {
        version: 1,
        kernelAbi: TARGET_ABI.version,
        abiSnapshotSha256: TARGET_ABI.snapshot_sha256,
        createdBy: "abi-staging-product-builders.test.ts",
      },
    }));
    inputs.push(resolvedFileInput({
      id: `product-${base.id}`,
      kind: "product-image",
      path,
      root: directory,
      role: "runtime",
      declared: base.materialization,
      architecture: product.manifest.architecture,
    }));
  }
  for (const repository of product.manifest.composition.repository) {
    const id = `repository-${repository.id}`;
    const path = join(files, `${id}.json`);
    createRepositoryPathBundle({
      repositoryRoot: sourceRoot,
      paths: repository.paths,
      source: SOURCE,
      outputPath: path,
    });
    inputs.push(resolvedFileInput({
      id,
      kind: "repository-path",
      path,
      root: directory,
      role: repository.role,
      declared: repository.role === "build"
        ? "build-only"
        : repository.materialization,
      architecture: product.manifest.architecture,
    }));
  }
  for (const claim of product.manifest.software.package) {
    for (const output of claim.outputs) {
      const id = `package-${claim.name}-output-${output}`;
      const path = join(files, id);
      writeFileSync(path, sdkTestOutputFixture(claim.name, output));
      inputs.push(resolvedFileInput({
        id,
        kind: "package-output",
        path,
        root: directory,
        role: claim.role,
        declared: claim.role === "build"
          ? "build-only"
          : claim.materialization,
        architecture: product.manifest.architecture,
      }));
    }
    for (const sourceRole of claim.source_roles) {
      const id = `package-${claim.name}-source-role-${sourceRole}`;
      const path = join(files, `${id}.tar.gz`);
      writeFileSync(path, sdkTestSourceRoleArchive(claim.name, sourceRole));
      inputs.push(resolvedFileInput({
        id,
        kind: "package-output",
        path,
        root: directory,
        role: claim.role,
        declared: claim.role === "build"
          ? "build-only"
          : claim.materialization,
        architecture: product.manifest.architecture,
      }));
    }
  }
  for (const archive of product.manifest.software.archive) {
    const id = `archive-${archive.id}`;
    const path = join(files, `${id}.archive`);
    writeFileSync(path, sourceArchiveFixture(archive.id));
    inputs.push(resolvedFileInput({
      id,
      kind: "source-archive",
      path,
      root: directory,
      role: archive.role,
      declared: archive.role === "build"
        ? "build-only"
        : archive.materialization,
      architecture: product.manifest.architecture,
    }));
  }
  for (const toolchain of product.manifest.software.toolchain) {
    const id = `toolchain-${toolchain.id}`;
    const path = join(files, `${id}.tar.gz`);
    writeFileSync(path, sdkToolchainFixture(toolchain.id));
    inputs.push(resolvedFileInput({
      id,
      kind: "toolchain-output",
      path,
      root: directory,
      role: toolchain.role,
      declared: toolchain.role === "build"
        ? "build-only"
        : toolchain.materialization,
      architecture: product.manifest.architecture,
    }));
  }
  inputs.sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const inputsPath = join(directory, "resolved-inputs.json");
  writeFileSync(inputsPath, canonicalJson({
    build_environment: {
      dev_shell_lock_sha256: "d".repeat(64),
      policy_sha256: "e".repeat(64),
    },
    inputs,
    kind: "kandelo-resolved-vfs-product-inputs",
    product: {
      architecture: product.manifest.architecture,
      id: productId,
      manifest_path: product.path,
      manifest_sha256: product.sha256,
      output: product.manifest.output,
    },
    reference_class: "candidate",
    schema: 1,
    source: SOURCE,
    target_abi: TARGET_ABI,
  }));
  return {
    directory,
    manifestPath: join(repoRoot, product.path),
    inputsPath,
    reportPath: join(directory, "builder-report.json"),
    outputPath: join(directory, product.manifest.output),
    inputIds: inputs.map((input) => String(input.id)),
    sourceRoot,
  };
}

function writeSdkTestRepositoryFixtures(sourceRoot: string): void {
  const write = (path: string, contents: string, mode = 0o644) => {
    const target = join(sourceRoot, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
    chmodSync(target, mode);
  };
  write(
    "sdk/kandelo/bin/wasm32posix-cc",
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "output=",
      "while (($#)); do",
      "  if [[ $1 == -o ]]; then shift; output=$1; fi",
      "  shift || true",
      "done",
      "[[ -n $output ]]",
      "printf '\\x00asm\\x01\\x00\\x00\\x00' > \"$output\"",
      "",
    ].join("\n"),
    0o755,
  );
  write("sdk/kandelo/bin/wasm32posix-c++", "#!/usr/bin/env bash\nexit 0\n", 0o755);
  write("sdk/config.site", "# fixture config.site\n");
  for (const source of ["channel_syscall", "compiler_rt", "cxxrt", "dlopen"]) {
    write(`libc/glue/${source}.c`, `int ${source}(void) { return 0; }\n`);
  }
  write("LICENSE", "fixture Kandelo license\n");
  write("COPYING.runtime", "fixture runtime notices\n");
  write("libc/musl/COPYRIGHT", "fixture musl license\n");
  write("sdk/kandelo/licenses/LLVM-LICENSE.TXT", "fixture LLVM license\n");
  write("tests/php-fixtures/README.md", "fixture maintenance inputs\n");
  write("images/rootfs/etc/services", "mysql 3306/tcp\nhttp 80/tcp\n");
}

function sdkTestOutputFixture(packageName: string, output: string): Uint8Array {
  if (packageName === "libcxx" && output === "libcxx") {
    return gzipSync(tarBytes([
      {
        path: "libcxx/lib/libc++.a",
        contents: new TextEncoder().encode("fixture libc++\n"),
        mode: 0o644,
      },
      {
        path: "libcxx/lib/libc++abi.a",
        contents: new TextEncoder().encode("fixture libc++abi\n"),
        mode: 0o644,
      },
      {
        path: "libcxx/include/c++/v1/vector",
        contents: new TextEncoder().encode("// fixture vector\n"),
        mode: 0o644,
      },
    ]), { level: 9 });
  }
  if (packageName === "php" && output === "icu-data") {
    return new TextEncoder().encode("fixture ICU data\n");
  }
  return minimalWasm();
}

function sdkTestSourceRoleArchive(
  packageName: string,
  sourceRole: string,
): Uint8Array {
  if (packageName === "mariadb" && sourceRole === "system-tables") {
    return sourceRoleArchive(packageName, sourceRole);
  }
  if (packageName === "mariadb" && sourceRole === "test-suite") {
    const builder = readFileSync(
      join(repoRoot, "images/vfs/scripts/build-mariadb-test-vfs-image.ts"),
      "utf8",
    );
    const body = builder.match(/const CURATED_TESTS = \[([\s\S]*?)\];/)?.[1];
    if (body === undefined) throw new Error("MariaDB curated fixture list missing");
    const tests = Array.from(body.matchAll(/"([^"]+)"/g), (match) => match[1]);
    return gzipSync(tarBytes([
      ...tests.map((test) => ({
        path: `test-suite/main/${test}.test`,
        contents: new TextEncoder().encode(`# fixture ${test}\n`),
        mode: 0o644,
      })),
      {
        path: "test-suite/include/helper.inc",
        contents: new TextEncoder().encode("# fixture include\n"),
        mode: 0o644,
      },
      {
        path: "test-suite/std_data/fixture.dat",
        contents: new TextEncoder().encode("fixture data\n"),
        mode: 0o644,
      },
    ]), { level: 9 });
  }
  if (packageName === "php" && sourceRole === "test-suite") {
    return gzipSync(tarBytes([{
      path: "test-suite/ext/example/tests/basic.phpt",
      contents: new TextEncoder().encode(
        "--TEST--\nfixture\n--FILE--\n<?php echo 'ok'; ?>\n--EXPECT--\nok\n",
      ),
      mode: 0o644,
    }]), { level: 9 });
  }
  if (packageName === "sqlite" && sourceRole === "full-source") {
    return gzipSync(tarBytes([{
      path: "full-source/test/basic.test",
      contents: new TextEncoder().encode("# fixture sqlite test\n"),
      mode: 0o644,
    }]), { level: 9 });
  }
  if (packageName === "tcl" && sourceRole === "runtime-library") {
    return gzipSync(tarBytes([{
      path: "runtime-library/init.tcl",
      contents: new TextEncoder().encode("# fixture Tcl runtime\n"),
      mode: 0o644,
    }]), { level: 9 });
  }
  throw new Error(`no SDK/test source fixture for ${packageName}/${sourceRole}`);
}

function sdkToolchainFixture(id: string): Uint8Array {
  if (id === "wasm32-sysroot") {
    return gzipSync(tarBytes([
      {
        path: "wasm32-sysroot/lib/libc.a",
        contents: new TextEncoder().encode("fixture libc\n"),
        mode: 0o644,
      },
      {
        path: "wasm32-sysroot/include/stdio.h",
        contents: new TextEncoder().encode("/* fixture stdio */\n"),
        mode: 0o644,
      },
    ]), { level: 9 });
  }
  if (id === "clang-resource-headers") {
    return gzipSync(tarBytes([{
      path: "clang-resource-headers/include/stddef.h",
      contents: new TextEncoder().encode("/* fixture clang header */\n"),
      mode: 0o644,
    }]), { level: 9 });
  }
  throw new Error(`unknown SDK toolchain fixture ${id}`);
}

function mutateResolvedInputs(
  fixture: BuilderFixture,
  mutate: (document: any) => void,
): void {
  const document = JSON.parse(readFileSync(fixture.inputsPath, "utf8"));
  mutate(document);
  writeFileSync(fixture.inputsPath, canonicalJson(document));
}

function productBuilder(productId: string): string {
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  const product = catalog.products.find(
    (entry: { manifest: { id: string } }) => entry.manifest.id === productId,
  );
  if (!product) throw new Error(`${productId} is missing from the product catalog`);
  return product.manifest.builder;
}

function resolvedFileInput(options: {
  id: string;
  kind: string;
  path: string;
  root: string;
  role: "runtime" | "build";
  declared: "embedded" | "lazy" | "build-only";
  architecture: "wasm32" | "wasm64";
}): Record<string, unknown> {
  const bytes = readFileSync(options.path);
  const effective = options.declared === "build-only"
    ? "build-only"
    : options.declared === "embedded"
      ? "embedded"
      : "lazy-reference";
  if (effective === "lazy-reference") {
    return {
      architecture: options.architecture,
      bytes: bytes.byteLength,
      declared_materialization: options.declared,
      effective_materialization: effective,
      id: options.id,
      kind: options.kind,
      reference:
        `https://artifacts.example.test/${options.id}?sha256=${sha256(bytes)}`,
      role: options.role,
      sha256: sha256(bytes),
    };
  }
  return {
    architecture: options.architecture,
    bytes: bytes.byteLength,
    declared_materialization: options.declared,
    effective_materialization: effective,
    id: options.id,
    kind: options.kind,
    path: relative(options.root, options.path),
    role: options.role,
    sha256: sha256(bytes),
  };
}

function minimalWasm(): Uint8Array {
  return new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
}

function sourceRoleArchive(packageName: string, sourceRole: string): Uint8Array {
  const entries = packageName === "mariadb" && sourceRole === "system-tables"
    ? [
        {
          path: "system-tables/mysql_system_tables.sql",
          contents: new TextEncoder().encode("CREATE TABLE user (id INT);\n"),
          mode: 0o644,
        },
        {
          path: "system-tables/mysql_system_tables_data.sql",
          contents: new TextEncoder().encode("INSERT INTO user VALUES (1);\n"),
          mode: 0o644,
        },
      ]
    : packageName === "perl" && sourceRole === "standard-library"
    ? [
        {
          path: "standard-library/lib/strict.pm",
          contents: new TextEncoder().encode("package strict; # fixture\n"),
          mode: 0o644,
        },
        {
          path: "standard-library/cpan/Carp/lib/Carp.pm",
          contents: new TextEncoder().encode("package Carp;\n"),
          mode: 0o644,
        },
        {
          path: "standard-library/dist/Cwd/lib/Cwd.pm",
          contents: new TextEncoder().encode("package Cwd;\n"),
          mode: 0o644,
        },
        {
          path: "standard-library/ext/POSIX/lib/POSIX.pm",
          contents: new TextEncoder().encode("package POSIX;\n"),
          mode: 0o644,
        },
      ]
    : [{
        path: `${sourceRole}/fixture.txt`,
        contents: new TextEncoder().encode(`${packageName}/${sourceRole}\n`),
        mode: 0o644,
      }];
  return gzipSync(tarBytes(entries), { level: 9 });
}

function standaloneOutputFixture(
  packageName: string,
  output: string,
): Uint8Array {
  if (packageName === "cpython" && output === "python-runtime") {
    return zipSync({
      "lib/python3.13/os.py": new TextEncoder().encode("# fixture os\n"),
      "share/licenses/cpython/LICENSE": new TextEncoder().encode(
        "fixture license\n",
      ),
    }, { level: 9 });
  }
  if (packageName === "erlang" && output === "erlang-otp") {
    const beam = minimalWasm();
    return new Uint8Array(zstdCompressSync(tarBytes([
      {
        path: "bin/start.boot",
        contents: new TextEncoder().encode("fixture boot\n"),
        mode: 0o644,
      },
      { path: "erts-16.1.2/bin/beam.smp", contents: beam, mode: 0o755 },
      {
        path: "erts-16.1.2/bin/erl_child_setup",
        contents: minimalWasm(),
        mode: 0o755,
      },
      {
        path: "lib/kernel-10.4.2/ebin/kernel.app",
        contents: new TextEncoder().encode("{application,kernel,[]}.\n"),
        mode: 0o644,
      },
      {
        path: "lib/stdlib-7.1/ebin/stdlib.app",
        contents: new TextEncoder().encode("{application,stdlib,[]}.\n"),
        mode: 0o644,
      },
      {
        path: "releases/28/start_clean.boot",
        contents: new TextEncoder().encode("fixture release\n"),
        mode: 0o644,
      },
    ])));
  }
  return minimalWasm();
}

function replaceResolvedInputBytes(
  fixture: BuilderFixture,
  inputId: string,
  bytes: Uint8Array,
): void {
  const document = JSON.parse(readFileSync(fixture.inputsPath, "utf8"));
  const input = document.inputs.find(
    (item: { id: string }) => item.id === inputId,
  );
  if (!input?.path) throw new Error(`fixture input ${inputId} is not embedded`);
  writeFileSync(join(fixture.directory, input.path), bytes);
  input.bytes = bytes.byteLength;
  input.sha256 = sha256(bytes);
  writeFileSync(fixture.inputsPath, canonicalJson(document));
}

function sourceArchiveFixture(id: string): Uint8Array {
  if (id === "sqlite-full-source") {
    return zipSync({
      "sqlite-src-3490100/": new Uint8Array(),
      "sqlite-src-3490100/test/basic.test":
        new TextEncoder().encode("# fixture sqlite test\n"),
    }, { level: 9 });
  }
  if (id === "wordpress-sqlite-integration") {
    return zipSync({
      "sqlite-database-integration/": new Uint8Array(),
      "sqlite-database-integration/db.copy":
        new TextEncoder().encode("<?php // fixture\n"),
    }, { level: 9 });
  }
  if (id === "npm-runtime") {
    const files = [
      "bin/npm-cli.js",
      "lib/cli.js",
      "lib/utils/display.js",
      "lib/commands/token.js",
      "node_modules/cacache/lib/entry-index.js",
      "node_modules/cacache/lib/verify.js",
    ];
    return gzipSync(tarBytes(files.map((path) => ({
      path: `package/${path}`,
      contents: new TextEncoder().encode("module.exports = {};\n"),
      mode: path.startsWith("bin/") ? 0o755 : 0o644,
    }))), { level: 9 });
  }
  return gzipSync(tarBytes([{
    path: "wordpress/index.php",
    contents: new TextEncoder().encode("<?php echo 'fixture';\n"),
    mode: 0o644,
  }]), { level: 9 });
}

function embeddedInput(
  id: string,
  kind: string,
  path: string,
  root: string,
  declaredMaterialization: "embedded",
  reference: string,
): Record<string, unknown> {
  const bytes = readFileSync(path);
  return {
    architecture: "wasm32",
    bytes: bytes.byteLength,
    declared_materialization: declaredMaterialization,
    effective_materialization: "embedded",
    id,
    kind,
    path: relative(root, path),
    reference,
    role: "runtime",
    sha256: sha256(bytes),
  };
}

function originalBottleDescriptor(options: {
  formula: string;
  archiveSha256: string;
  archiveBytes: number;
  expandedBytes: number;
  reference: string;
}): any {
  const formula = options.formula;
  const command = formula === "file-formula"
    ? "file"
    : formula === "netcat"
    ? "nc"
    : formula;
  const keg = `opt/kandelo/homebrew/Cellar/${formula}/1.0`;
  const sourcePath = `${formula}/1.0/bin/${command}`;
  const executableBytes = new TextEncoder().encode("#!/bin/x\n").byteLength;
  const entries: any[] = [
    bottleDirectory("opt/kandelo/homebrew", `${formula}-prefix`, "mergeable-directory"),
    bottleDirectory("opt/kandelo/homebrew/Cellar", `${formula}-cellar`, "mergeable-directory"),
    bottleDirectory(
      `opt/kandelo/homebrew/Cellar/${formula}`,
      `${formula}-formula`,
      "mergeable-directory",
    ),
    bottleDirectory(keg, `${formula}-keg`, "layer"),
    bottleDirectory(`${keg}/bin`, `${formula}-keg-bin`, "layer"),
    {
      path: `${keg}/bin/${command}`,
      source_path: sourcePath,
      materialization: "archive",
      type: "file",
      ownership: "layer",
      mode: 0o755,
      size: executableBytes,
      inode_group: `${formula}-command`,
    },
    bottleDirectory("opt/kandelo/homebrew/bin", `${formula}-prefix-bin`, "mergeable-directory"),
    bottleSymlink(
      `opt/kandelo/homebrew/bin/${command}`,
      `${formula}-public-command`,
      `../Cellar/${formula}/1.0/bin/${command}`,
    ),
    bottleDirectory("opt/kandelo/homebrew/opt", `${formula}-opt`, "mergeable-directory"),
    bottleSymlink(
      `opt/kandelo/homebrew/opt/${formula}`,
      `${formula}-opt-link`,
      `../Cellar/${formula}/1.0`,
    ),
  ];
  const publicAliases: Record<string, string[]> = {
    less: ["more"],
    vim: ["ex"],
  };
  for (const alias of publicAliases[formula] ?? []) {
    entries.push(bottleSymlink(
      `opt/kandelo/homebrew/bin/${alias}`,
      `${formula}-public-${alias}`,
      `../Cellar/${formula}/1.0/bin/${command}`,
    ));
  }
  if (formula === "git") {
    entries.push(
      bottleDirectory(`${keg}/libexec`, "git-libexec", "layer"),
      bottleDirectory(`${keg}/libexec/git-core`, "git-core", "layer"),
      bottleSymlink(
        `${keg}/libexec/git-core/git-remote-http`,
        "git-remote-http",
        "../../bin/git",
      ),
    );
  }
  entries.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  );
  return {
    schema: 1,
    kind: "kandelo-homebrew-original-bottle-tree",
    architecture: "wasm32",
    tap: "kandelo-dev/homebrew-tap-core",
    formula,
    required_by: [formula],
    tree: {
      id: formula,
      package: `kandelo-dev/tap-core/${formula}`,
      activation: {
        mode: "first-use",
        capabilities: [`homebrew-bottle:${formula}`],
        roots: [`/${keg}`],
      },
      content: {
        media_type: "application/vnd.oci.image.layer.v1.tar+gzip",
        decoder: "homebrew-bottle-tar-gzip-v1",
        sha256: options.archiveSha256,
        bytes: options.archiveBytes,
      },
      transports: [{ kind: "external-https", url: options.reference }],
      inventory: {
        entry_count: entries.length,
        source_entry_count: 1,
        regular_inode_count: 1,
        layer_entry_count: entries.filter((entry) => entry.ownership === "layer").length,
        mergeable_directory_count: entries.filter(
          (entry) => entry.ownership === "mergeable-directory",
        ).length,
        expanded_bytes: options.expandedBytes,
        payload_bytes: executableBytes,
        source: {
          schema: 1,
          kind: "homebrew-bottle-tar-gzip-v1",
          entries: [{
            path: sourcePath,
            type: "file",
            mode: 0o755,
            size: executableBytes,
          }],
        },
        entries,
      },
    },
  };
}

function bottleDirectory(
  path: string,
  sourcePath: string,
  ownership: "layer" | "mergeable-directory",
) {
  return {
    path,
    source_path: sourcePath,
    materialization: "descriptor",
    type: "directory",
    ownership,
    mode: 0o755,
    size: 0,
  };
}

function bottleSymlink(path: string, sourcePath: string, target: string) {
  return {
    path,
    source_path: sourcePath,
    materialization: "descriptor",
    type: "symlink",
    ownership: "layer",
    mode: 0o777,
    size: new TextEncoder().encode(target).byteLength,
    target,
  };
}

function testBottleArchive(formula: string) {
  const contents = new TextEncoder().encode("#!/bin/x\n");
  const path = `${formula}/1.0/bin/${formula}`;
  const tar = tarBytes([{ path, contents, mode: 0o755 }]);
  const bytes = gzipSync(tar, { level: 9 });
  return {
    bytes,
    archiveBytes: bytes.byteLength,
    archiveSha256: sha256(bytes),
    expandedBytes: tar.byteLength,
  };
}

function testBootstrapArchive(): Uint8Array {
  const entry = (bytes: Uint8Array, mode: number): Zippable[string] =>
    [bytes, { os: 3, attrs: ((mode << 16) >>> 0) }];
  return zipSync({
    "bin/": entry(new Uint8Array(), 0o040755),
    "bin/brew": entry(new TextEncoder().encode("#!/bin/brew\n"), 0o100755),
    "Library/": entry(new Uint8Array(), 0o040755),
    "Library/Homebrew/": entry(new Uint8Array(), 0o040755),
    "Library/Homebrew/global.rb": entry(
      new TextEncoder().encode("GLOBAL = true\n"),
      0o100644,
    ),
  }, { level: 9 });
}

function tarBytes(
  entries: ReadonlyArray<{ path: string; contents: Uint8Array; mode: number }>,
): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const entry of entries) {
    const header = new Uint8Array(512);
    writeTarText(header, 0, 100, entry.path);
    writeTarOctal(header, 100, 8, entry.mode);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, entry.contents.byteLength);
    writeTarOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = "0".charCodeAt(0);
    writeTarText(header, 257, 6, "ustar");
    writeTarText(header, 263, 2, "00");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    writeTarChecksum(header, checksum);
    chunks.push(header, paddedTarPayload(entry.contents));
  }
  chunks.push(new Uint8Array(1024));
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function paddedTarPayload(contents: Uint8Array): Uint8Array {
  const output = new Uint8Array(Math.ceil(contents.byteLength / 512) * 512);
  output.set(contents);
  return output;
}

function writeTarText(
  target: Uint8Array,
  offset: number,
  length: number,
  value: string,
): void {
  target.set(new TextEncoder().encode(value).subarray(0, length), offset);
}

function writeTarOctal(
  target: Uint8Array,
  offset: number,
  length: number,
  value: number,
): void {
  const encoded = `${value.toString(8).padStart(length - 1, "0")}\0`;
  writeTarText(target, offset, length, encoded);
}

function writeTarChecksum(target: Uint8Array, value: number): void {
  const encoded = `${value.toString(8).padStart(6, "0")}\0 `;
  writeTarText(target, 148, 8, encoded);
}

function runBuilder(builder: string, fixture: BuilderFixture) {
  return spawnSync(
    "bash",
    [
      join(repoRoot, builder),
      "--vfs-product-manifest", fixture.manifestPath,
      "--vfs-product-inputs", fixture.inputsPath,
      "--vfs-product-report", fixture.reportPath,
      "--vfs-product-output", fixture.outputPath,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        CI: "true",
        HOME: fixture.directory,
        LANG: "C.UTF-8",
        PATH: process.env.PATH,
        SOURCE_DATE_EPOCH: "0",
        TMPDIR: join(fixture.directory, "tmp"),
        TZ: "UTC",
      },
      maxBuffer: 16 * 1024 * 1024,
    },
  );
}

function readVfsFile(fs: MemoryFileSystem, path: string): string {
  const size = fs.stat(path).size;
  const fd = fs.open(path, 0, 0);
  try {
    const bytes = new Uint8Array(size);
    expect(fs.read(fd, bytes, null, size)).toBe(size);
    return new TextDecoder().decode(bytes);
  } finally {
    fs.close(fd);
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortJson(value))}\n`;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}
