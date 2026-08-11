import { createHash } from "node:crypto";

import { gzipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";

import type {
  HomebrewBottleDependencyIdentity,
  HomebrewBottleDescriptor,
} from "../src/homebrew-bottle-descriptor";
import { encodeHomebrewBottleSelection } from "../src/homebrew-bottle-selection";
import { buildHomebrewVfsSelection } from "../src/homebrew-vfs-builder";
import { planHomebrewVfsSelection } from "../src/homebrew-vfs-planner";
import { resolveHomebrewVfsResourcePolicy } from "../src/homebrew-vfs-resource-policy";
import { ensureDirRecursive, writeVfsFile } from "../src/vfs/image-helpers";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import {
  homebrewTestBootstrapEntries,
  homebrewTestBootstrapFixture,
} from "./fixtures/homebrew-flat-vfs";

const PREFIX = "/opt/kandelo/homebrew";
const CELLAR = `${PREFIX}/Cellar`;
const BOOTSTRAP = "kandelo-dev/tap-core/homebrew-bootstrap";

interface TarSpec {
  path: string;
  type?: "file" | "directory" | "symlink" | "hardlink" | "pax";
  data?: string | Uint8Array;
  linkName?: string;
  mode?: number;
}

describe("flat Homebrew VFS builder", () => {
  it("builds a canonical selection in dependency order without provenance fields", async () => {
    const bootstrapFixture = homebrewTestBootstrapFixture();
    const bootstrapBottle = bootstrapFixture.bottle;
    const bootstrap = bootstrapFixture.descriptor;
    const helloBottle = bottleTar([
      bottleEntry("hello", "2.12.1", ".brew/hello.rb", "class Hello < Formula\nend\n"),
      bottleEntry("hello", "2.12.1", "INSTALL_RECEIPT.json", receipt([
        {
          full_name: "kandelo-dev/tap-core/transitive-only",
          pkg_version: "9.0",
          revision: 0,
          declared_directly: false,
        },
        {
          full_name: bootstrap.fullName,
          version: bootstrap.version,
          pkg_version: bootstrap.version,
          revision: bootstrap.revision,
          declared_directly: true,
        },
      ], ["bin/hello"])),
      bottleEntry(
        "hello",
        "2.12.1",
        "bin/hello",
        "#!/bin/sh\necho @@HOMEBREW_PREFIX@@\n",
        0o755,
      ),
    ]);
    const hello = descriptor({
      name: "hello",
      version: "2.12.1",
      bottle: helloBottle,
      dependencies: [dependency(bootstrap)],
      links: [{
        type: "symlink",
        source: "Cellar/hello/2.12.1/bin/hello",
        target: "bin/hello",
      }],
      pathPrepend: ["bin"],
    });
    const canonicalSelection = encodeHomebrewBottleSelection({
      schema: 1,
      name: "experimental-abi42-flat-builder",
      arch: "wasm32",
      kandeloAbi: 42,
      bottles: [bootstrap, hello],
      requestedVfsFilename: "kandelo-homebrew-experimental-abi42-wasm32.vfs.zst",
      resourcePolicy: "kandelo-homebrew-vfs-generous-v1",
      linkPolicy: "kandelo-homebrew-link-ownership-v1",
      runtimeSupport: "kandelo-homebrew-bootstrap-v1",
    });

    const plan = planHomebrewVfsSelection(canonicalSelection, { expectedAbi: 42 });
    const loaded: string[] = [];
    const result = await buildHomebrewVfsSelection(plan, {
      loadBottleBytes(pkg) {
        loaded.push(pkg.fullName);
        return pkg.fullName === BOOTSTRAP ? bootstrapBottle : helloBottle;
      },
    });

    expect(plan).toMatchObject({
      schema: 1,
      name: "experimental-abi42-flat-builder",
      arch: "wasm32",
      kandeloAbi: 42,
      selectionSha256: sha256(canonicalSelection),
      requestedVfsFilename: "kandelo-homebrew-experimental-abi42-wasm32.vfs.zst",
      resourcePolicy: "kandelo-homebrew-vfs-generous-v1",
      linkPolicy: "kandelo-homebrew-link-ownership-v1",
      runtimeSupport: "kandelo-homebrew-bootstrap-v1",
      packages: [bootstrap, hello],
    });
    expect(loaded).toEqual([BOOTSTRAP, hello.fullName]);
    expect(readVfsFile(result.fs, `${hello.keg}/bin/hello`)).toBe(
      "#!/bin/sh\necho /opt/kandelo/homebrew\n",
    );
    expect(result.fs.stat(`${hello.keg}/bin/hello`).mode & 0o777).toBe(0o755);
    expect(result.fs.readlink(`${PREFIX}/bin/hello`)).toBe(`${hello.keg}/bin/hello`);
    expect(result.fs.readlink("/bin/hello")).toBe(`${PREFIX}/bin/hello`);
    expect(result.fs.readlink("/usr/bin/hello")).toBe(`${PREFIX}/bin/hello`);
    expect(result.fs.readlink(`${PREFIX}/opt/hello`)).toBe("../Cellar/hello/2.12.1");

    const metadata = JSON.parse(readVfsFile(result.fs, "/etc/kandelo/homebrew-vfs.json"));
    expect(metadata).toMatchObject({
      schema: 1,
      name: "experimental-abi42-flat-builder",
      arch: "wasm32",
      kandelo_abi: 42,
      selection_sha256: sha256(canonicalSelection),
      requested_vfs_filename: "kandelo-homebrew-experimental-abi42-wasm32.vfs.zst",
      resource_policy: "kandelo-homebrew-vfs-generous-v1",
      link_policy: "kandelo-homebrew-link-ownership-v1",
      runtime_support: "kandelo-homebrew-bootstrap-v1",
      environment: { PATH: `${PREFIX}/bin` },
      packages: [
        {
          full_name: BOOTSTRAP,
          version: "6.0.12_1",
          receipts: bootstrap.receipts,
          links: [],
          runtime_dependencies: [],
        },
        {
          full_name: hello.fullName,
          version: "2.12.1",
          receipts: hello.receipts,
          links: ["bin/hello"],
          runtime_dependencies: [{
            full_name: BOOTSTRAP,
            version: "6.0.12_1",
            revision: 0,
          }],
        },
      ],
      totals: {
        compressed_bytes: bootstrapBottle.byteLength + helloBottle.byteLength,
        expanded_bytes: 9728,
        entries: 7,
        path_bytes: 296,
        link_bytes: 0,
      },
    });
    for (const forbidden of [
      "tap_commit",
      "release_tag",
      "built_from",
      "cache_key",
      "migration_lock",
      "catalog",
      "campaign",
      "provenance",
      "signature",
      "promotion",
      "generation",
    ]) {
      expect(hasObjectKey(metadata, forbidden), `${forbidden} must be absent`).toBe(false);
    }
    expect(result.report).toEqual(metadata);
  });

  it("projects selected commands and standard aliases into the public shell paths", async () => {
    const bootstrap = bootstrapFixture();
    const dash = simpleBottle("dash", "1.0", "dash", "bin/dash");
    const coreutils = simpleBottle("coreutils", "1.0", "env", "bin/env");
    const closure = [bootstrap, dash, coreutils];
    const result = await buildHomebrewVfsSelection(
      planHomebrewVfsSelection(selectionBytes(
        closure.map(({ descriptor: item }) => item),
      )),
      {
        loadBottleBytes(pkg) {
          return closure.find(
            ({ descriptor: item }) => item.fullName === pkg.fullName,
          )!.bottle;
        },
      },
    );

    for (const command of ["dash", "env"]) {
      expect(result.fs.readlink(`/bin/${command}`)).toBe(
        `${PREFIX}/bin/${command}`,
      );
      expect(result.fs.readlink(`/usr/bin/${command}`)).toBe(
        `${PREFIX}/bin/${command}`,
      );
    }
    expect(result.fs.readlink("/bin/sh")).toBe(`${PREFIX}/bin/dash`);
    expect(result.fs.readlink("/usr/bin/sh")).toBe(`${PREFIX}/bin/dash`);
  });

  it("uses the three declared functional link owners and rejects undeclared collisions", async () => {
    const entriesByName: Record<string, string[]> = {
      ed: ["ed"],
      less: ["more"],
      "posix-utils-lite": ["ed", "ex", "more"],
      vim: ["ex"],
    };
    const packages: Array<{ descriptor: HomebrewBottleDescriptor; bottle: Uint8Array }> = [];
    for (const [name, commands] of Object.entries(entriesByName)) {
      const version = "1.0";
      const bottle = bottleTar([
        bottleEntry(name, version, `.brew/${name}.rb`, `class ${name} < Formula\nend\n`),
        bottleEntry(name, version, "INSTALL_RECEIPT.json", receipt([])),
        ...commands.map((command) =>
          bottleEntry(name, version, `bin/${command}`, `${name}:${command}\n`, 0o755)
        ),
      ]);
      packages.push({
        bottle,
        descriptor: descriptor({
          name,
          version,
          bottle,
          links: commands.map((command) => ({
            type: "symlink" as const,
            source: `Cellar/${name}/${version}/bin/${command}`,
            target: `bin/${command}`,
          })),
        }),
      });
    }
    const bootstrap = bootstrapFixture();
    const ordered = [packages[0]!, packages[1]!, bootstrap, packages[2]!, packages[3]!];
    const selection = selectionBytes(ordered.map(({ descriptor: item }) => item));
    const result = await buildHomebrewVfsSelection(planHomebrewVfsSelection(selection), {
      loadBottleBytes(pkg) {
        return ordered.find(({ descriptor: item }) => item.fullName === pkg.fullName)!.bottle;
      },
    });

    expect(result.fs.readlink(`${PREFIX}/bin/ed`)).toContain("/Cellar/ed/");
    expect(result.fs.readlink(`${PREFIX}/bin/ex`)).toContain("/Cellar/vim/");
    expect(result.fs.readlink(`${PREFIX}/bin/more`)).toContain("/Cellar/less/");
    expect(result.report.link_owners).toEqual([
      {
        target: "bin/ed",
        selected_package: "kandelo-dev/tap-core/ed",
        claimants: ["kandelo-dev/tap-core/ed", "kandelo-dev/tap-core/posix-utils-lite"],
      },
      {
        target: "bin/more",
        selected_package: "kandelo-dev/tap-core/less",
        claimants: ["kandelo-dev/tap-core/less", "kandelo-dev/tap-core/posix-utils-lite"],
      },
      {
        target: "bin/ex",
        selected_package: "kandelo-dev/tap-core/vim",
        claimants: ["kandelo-dev/tap-core/posix-utils-lite", "kandelo-dev/tap-core/vim"],
      },
    ]);

    const alpha = simpleBottle("alpha", "1.0", "tool", "bin/shared");
    const beta = simpleBottle("beta", "1.0", "tool", "bin/shared");
    const unsupported = [bootstrapFixture(), alpha, beta];
    await expect(buildHomebrewVfsSelection(
      planHomebrewVfsSelection(selectionBytes(unsupported.map(({ descriptor: item }) => item))),
      {
        loadBottleBytes(pkg) {
          return unsupported.find(({ descriptor: item }) => item.fullName === pkg.fullName)!.bottle;
        },
      },
    )).rejects.toThrow(/undeclared claimants.*alpha.*beta/);
  });

  it("rejects receipt-edge drift and bottle byte drift before publishing a filesystem", async () => {
    const bootstrap = bootstrapFixture();
    const wrongReceiptBottle = bottleTar([
      bottleEntry("consumer", "1.0", ".brew/consumer.rb", "class Consumer < Formula\nend\n"),
      bottleEntry("consumer", "1.0", "INSTALL_RECEIPT.json", receipt([{
        full_name: BOOTSTRAP,
        version: "wrong-display-value",
        pkg_version: "6.0.13",
        revision: 0,
        declared_directly: true,
      }])),
    ]);
    const consumer = descriptor({
      name: "consumer",
      version: "1.0",
      bottle: wrongReceiptBottle,
      dependencies: [dependency(bootstrap.descriptor)],
    });
    const closure = [bootstrap, { descriptor: consumer, bottle: wrongReceiptBottle }];
    const plan = planHomebrewVfsSelection(
      selectionBytes(closure.map(({ descriptor: item }) => item)),
    );
    await expect(buildHomebrewVfsSelection(plan, {
      loadBottleBytes(pkg) {
        return closure.find(({ descriptor: item }) => item.fullName === pkg.fullName)!.bottle;
      },
    })).rejects.toThrow(/direct runtime dependencies do not match descriptor edges/);

    const valid = planHomebrewVfsSelection(selectionBytes([bootstrap.descriptor]));
    await expect(buildHomebrewVfsSelection(valid, {
      loadBottleBytes() {
        return Uint8Array.from([0x1f]);
      },
    })).rejects.toThrow(/bottle byte count.*metadata bytes/);
    const corrupt = bootstrap.bottle.slice();
    corrupt[10] ^= 0xff;
    await expect(buildHomebrewVfsSelection(valid, {
      loadBottleBytes() {
        return corrupt;
      },
    })).rejects.toThrow(/bottle sha256.*metadata sha256/);
  });

  it("bounds a multi-bottle high-compression closure while parsing the crossing bottle", async () => {
    const mebibyte = 1024 * 1024;
    const bottle = bottleTar([
      { path: ".brew/homebrew-bootstrap.rb", data: "class HomebrewBootstrap < Formula\nend\n" },
      { path: ".brew/alpha.rb", data: "class Alpha < Formula\nend\n" },
      { path: ".brew/beta.rb", data: "class Beta < Formula\nend\n" },
      { path: "INSTALL_RECEIPT.json", data: receipt([]) },
      { path: "libexec/homebrew-bootstrap.zip", data: "bootstrap zip" },
      { path: "libexec/homebrew-brew.env", data: "HOMEBREW_PREFIX=/opt/kandelo/homebrew\n" },
      { path: "share/high-compression-padding", data: new Uint8Array(171 * mebibyte) },
    ]);
    const bootstrap = descriptor({
      name: "homebrew-bootstrap",
      version: "6.0.12_1",
      bottle,
      materialization: "homebrew-runtime-support-v1",
    });
    const alpha = descriptor({ name: "alpha", version: "1.0", bottle });
    const beta = descriptor({ name: "beta", version: "1.0", bottle });
    const plan = planHomebrewVfsSelection(selectionBytes([bootstrap, alpha, beta]));

    await expect(buildHomebrewVfsSelection(plan, {
      loadBottleBytes() {
        return bottle;
      },
    })).rejects.toThrow(/beta.*declared uncompressed byte count.*outside 1\.\./i);
  }, 30_000);

  it("enforces the per-bottle expanded-byte policy before gzip inflation", async () => {
    const policy = resolveHomebrewVfsResourcePolicy("kandelo-homebrew-vfs-generous-v1");
    const bottle = bootstrapFixture().bottle.slice();
    new DataView(bottle.buffer, bottle.byteOffset, bottle.byteLength).setUint32(
      bottle.byteLength - 4,
      policy.bottle.maxExpandedBytes + 1,
      true,
    );

    await expectFlatBootstrapBottleRejected(
      bottle,
      /declared uncompressed byte count.*outside 1\.\.268435456/,
    );
  });

  it("enforces the per-bottle entry policy at the TAR parser", async () => {
    const bottle = bottleTar([
      ...bootstrapEntries(),
      ...Array.from({ length: 100_000 }, (_, index): TarSpec => ({
        path: `homebrew-bootstrap/6.0.12_1/share/e${index}`,
        type: "directory",
      })),
    ]);

    await expectFlatBootstrapBottleRejected(bottle, /TAR entry count exceeds 100000/);
  }, 30_000);

  it("enforces the per-bottle UTF-8 path and link-byte policies", async () => {
    const pathBottle = bottleTar([
      ...bootstrapEntries(),
      { path: "PaxHeaders/path", type: "pax", data: paxRecord("path", "p".repeat(4097)) },
      { path: "placeholder", data: "outside\n" },
    ]);
    await expectFlatBootstrapBottleRejected(pathBottle, /PAX path value is too long/);

    const linkBottle = bottleTar([
      ...bootstrapEntries(),
      {
        path: "PaxHeaders/link",
        type: "pax",
        data: paxRecord("linkpath", "l".repeat(65_537)),
      },
      { path: "placeholder-link", type: "symlink", linkName: "placeholder" },
    ]);
    await expectFlatBootstrapBottleRejected(linkBottle, /PAX linkpath value is too long/);
  });

  it("passes the remaining aggregate entry allowance into the crossing TAR parse", async () => {
    const bottle = bottleTar([
      ...bootstrapEntries(),
      bottleEntry("alpha", "1.0", ".brew/alpha.rb", "class Alpha < Formula\nend\n"),
      bottleEntry("alpha", "1.0", "INSTALL_RECEIPT.json", receipt([])),
      ...Array.from({ length: 50_000 }, (_, index): TarSpec => ({
        path: `shared/e${index}`,
        type: "directory",
      })),
    ]);
    const bootstrap = descriptor({
      name: "homebrew-bootstrap",
      version: "6.0.12_1",
      bottle,
      materialization: "homebrew-runtime-support-v1",
    });
    const alpha = descriptor({ name: "alpha", version: "1.0", bottle });

    await expect(buildHomebrewVfsSelection(
      planHomebrewVfsSelection(selectionBytes([bootstrap, alpha])),
      { loadBottleBytes: () => bottle },
    )).rejects.toThrow(/alpha.*TAR entry count exceeds 49994/);
  }, 30_000);

  it("keeps caller-owned state unchanged when a staged bottle fails late", async () => {
    const bootstrap = bootstrapFixture();
    const brokenBottle = bottleTar([
      bottleEntry("broken", "1.0", ".brew/broken.rb", "class Broken < Formula\nend\n"),
      bottleEntry("broken", "1.0", "INSTALL_RECEIPT.json", receipt([])),
    ]);
    const broken = descriptor({
      name: "broken",
      version: "1.0",
      bottle: brokenBottle,
      links: [{
        type: "symlink",
        source: "Cellar/broken/1.0/bin/missing",
        target: "bin/broken",
      }],
    });
    const closure = [bootstrap, { descriptor: broken, bottle: brokenBottle }];
    const baseFs = MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));
    writeVfsFile(baseFs, "/caller-marker", "unchanged\n", 0o644);

    const failure = buildHomebrewVfsSelection(
      planHomebrewVfsSelection(selectionBytes(closure.map(({ descriptor: item }) => item))),
      {
        baseFs,
        loadBottleBytes(pkg) {
          return closure.find(({ descriptor: item }) => item.fullName === pkg.fullName)!.bottle;
        },
      },
    );
    await expect(failure).rejects.toThrow(/link source.*missing/);
    expect(readVfsFile(baseFs, "/caller-marker")).toBe("unchanged\n");
    expect(() => baseFs.lstat(PREFIX)).toThrow();
  });

  it("prepares the complete bottle closure before allocating its private filesystem", async () => {
    const bootstrap = bootstrapFixture();
    const alpha = simpleBottle("alpha", "1.0", "alpha", "bin/alpha");
    const closure = [bootstrap, alpha];
    const baseFs = MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));
    const rebase = baseFs.rebaseToNewFileSystem.bind(baseFs);
    const events: string[] = [];
    vi.spyOn(baseFs, "rebaseToNewFileSystem").mockImplementation((maxByteLength) => {
      events.push("allocate-private-fs");
      return rebase(maxByteLength);
    });

    await buildHomebrewVfsSelection(
      planHomebrewVfsSelection(selectionBytes(closure.map(({ descriptor: item }) => item))),
      {
        baseFs,
        loadBottleBytes(pkg) {
          events.push(`load:${pkg.fullName}`);
          return closure.find(({ descriptor: item }) => item.fullName === pkg.fullName)!.bottle;
        },
      },
    );

    expect(events).toEqual([
      `load:${BOOTSTRAP}`,
      `load:${alpha.descriptor.fullName}`,
      "allocate-private-fs",
    ]);
  });

  it("rejects symlinked existing staging parents before writing any bottle", async () => {
    const bootstrap = bootstrapFixture();
    const cases = [
      {
        label: "prefix",
        linkPath: PREFIX,
        realParent: "/opt/kandelo",
        redirectedReceipt: "/redirect/Cellar/homebrew-bootstrap/6.0.12_1/INSTALL_RECEIPT.json",
      },
      {
        label: "Cellar",
        linkPath: CELLAR,
        realParent: PREFIX,
        redirectedReceipt: "/redirect/homebrew-bootstrap/6.0.12_1/INSTALL_RECEIPT.json",
      },
      {
        label: "Formula keg parent",
        linkPath: `${CELLAR}/homebrew-bootstrap`,
        realParent: CELLAR,
        redirectedReceipt: "/redirect/6.0.12_1/INSTALL_RECEIPT.json",
      },
    ];

    for (const fixture of cases) {
      const baseFs = MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));
      ensureDirRecursive(baseFs, "/redirect");
      ensureDirRecursive(baseFs, fixture.realParent);
      baseFs.symlink("/redirect", fixture.linkPath);
      const rebase = baseFs.rebaseToNewFileSystem.bind(baseFs);
      let privateFs: MemoryFileSystem | undefined;
      vi.spyOn(baseFs, "rebaseToNewFileSystem").mockImplementation((maxByteLength) => {
        privateFs = rebase(maxByteLength);
        return privateFs;
      });

      let failure: unknown;
      try {
        await buildHomebrewVfsSelection(
          planHomebrewVfsSelection(selectionBytes([bootstrap.descriptor])),
          { baseFs, loadBottleBytes: () => bootstrap.bottle },
        );
      } catch (error) {
        failure = error;
      }

      expect(failure, fixture.label).toBeInstanceOf(Error);
      expect((failure as Error).message, fixture.label).toMatch(
        /existing Homebrew staging path component.*real directory/i,
      );
      expect(privateFs, fixture.label).toBeDefined();
      expect(() => privateFs!.lstat(fixture.redirectedReceipt), fixture.label).toThrow();
      expect(() => baseFs.lstat(fixture.redirectedReceipt), fixture.label).toThrow();
      expect(baseFs.lstat(fixture.linkPath).mode & 0xf000, fixture.label).toBe(0xa000);
    }
  });

  it("rejects a symlinked archive-destination parent by refusing an existing selected keg", async () => {
    const bootstrap = bootstrapFixture();
    const alpha = simpleBottle("alpha", "1.0", "alpha", "bin/alpha");
    const closure = [bootstrap, alpha];
    const baseFs = MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));
    ensureDirRecursive(baseFs, alpha.descriptor.keg);
    ensureDirRecursive(baseFs, "/outside");
    baseFs.symlink("/outside", `${alpha.descriptor.keg}/bin`);
    const rebase = baseFs.rebaseToNewFileSystem.bind(baseFs);
    let privateFs: MemoryFileSystem | undefined;
    vi.spyOn(baseFs, "rebaseToNewFileSystem").mockImplementation((maxByteLength) => {
      privateFs = rebase(maxByteLength);
      return privateFs;
    });

    let failure: unknown;
    try {
      await buildHomebrewVfsSelection(
        planHomebrewVfsSelection(selectionBytes(closure.map(({ descriptor: item }) => item))),
        {
          baseFs,
          loadBottleBytes(pkg) {
            return closure.find(({ descriptor: item }) => item.fullName === pkg.fullName)!.bottle;
          },
        },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(
      /selected Homebrew keg.*Cellar\/alpha\/1\.0.*must be absent/i,
    );
    expect(privateFs).toBeDefined();
    expect(() => privateFs!.lstat("/outside/alpha")).toThrow();
    expect(() => privateFs!.lstat(`${bootstrap.descriptor.keg}/INSTALL_RECEIPT.json`)).toThrow();
    expect(() => baseFs.lstat("/outside/alpha")).toThrow();
    expect(baseFs.lstat(`${alpha.descriptor.keg}/bin`).mode & 0xf000).toBe(0xa000);
  });

  it("rejects an existing selected keg whose symlink can redirect an archive symlink", async () => {
    const bootstrap = bootstrapFixture();
    const alphaBottle = bottleTar([
      bottleEntry("alpha", "1.0", ".brew/alpha.rb", "class Alpha < Formula\nend\n"),
      bottleEntry("alpha", "1.0", "INSTALL_RECEIPT.json", receipt([])),
      {
        path: "alpha/1.0/bin/alias",
        type: "symlink",
        linkName: "../existing/tool",
      },
    ]);
    const alpha = descriptor({ name: "alpha", version: "1.0", bottle: alphaBottle });
    const closure = [bootstrap, { descriptor: alpha, bottle: alphaBottle }];
    const baseFs = MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));
    ensureDirRecursive(baseFs, alpha.keg);
    ensureDirRecursive(baseFs, "/outside");
    writeVfsFile(baseFs, "/outside/tool", "outside\n", 0o644);
    baseFs.symlink("/outside", `${alpha.keg}/existing`);
    expect(readVfsFile(baseFs, `${alpha.keg}/existing/tool`)).toBe("outside\n");
    const rebase = baseFs.rebaseToNewFileSystem.bind(baseFs);
    let privateFs: MemoryFileSystem | undefined;
    vi.spyOn(baseFs, "rebaseToNewFileSystem").mockImplementation((maxByteLength) => {
      privateFs = rebase(maxByteLength);
      return privateFs;
    });

    let failure: unknown;
    try {
      await buildHomebrewVfsSelection(
        planHomebrewVfsSelection(selectionBytes(closure.map(({ descriptor: item }) => item))),
        {
          baseFs,
          loadBottleBytes(pkg) {
            return closure.find(({ descriptor: item }) => item.fullName === pkg.fullName)!.bottle;
          },
        },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(
      /selected Homebrew keg.*Cellar\/alpha\/1\.0.*must be absent/i,
    );
    expect(privateFs).toBeDefined();
    expect(() => privateFs!.lstat(`${bootstrap.descriptor.keg}/INSTALL_RECEIPT.json`)).toThrow();
    expect(() => privateFs!.lstat(`${alpha.keg}/bin/alias`)).toThrow();
    expect(() => baseFs.lstat(`${alpha.keg}/bin/alias`)).toThrow();
    expect(baseFs.readlink(`${alpha.keg}/existing`)).toBe("/outside");
    expect(readVfsFile(baseFs, "/outside/tool")).toBe("outside\n");
  });

  it("preflights every losing claimant source before applying any link", async () => {
    const bootstrap = bootstrapFixture();
    const good = simpleBottle("good", "1.0", "good", "bin/good");
    const ed = simpleBottle("ed", "1.0", "ed", "bin/ed");
    const loserBottle = bottleTar([
      bottleEntry("posix-utils-lite", "1.0", ".brew/posix-utils-lite.rb", "class PosixUtilsLite < Formula\nend\n"),
      bottleEntry("posix-utils-lite", "1.0", "INSTALL_RECEIPT.json", receipt([])),
    ]);
    const loser = descriptor({
      name: "posix-utils-lite",
      version: "1.0",
      bottle: loserBottle,
      links: [{
        type: "symlink",
        source: "Cellar/posix-utils-lite/1.0/bin/ed",
        target: "bin/ed",
      }],
    });
    const closure = [
      bootstrap,
      good,
      ed,
      { descriptor: loser, bottle: loserBottle },
    ];
    const baseFs = MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));
    const rebase = baseFs.rebaseToNewFileSystem.bind(baseFs);
    let privateFs: MemoryFileSystem | undefined;
    vi.spyOn(baseFs, "rebaseToNewFileSystem").mockImplementation((maxByteLength) => {
      privateFs = rebase(maxByteLength);
      return privateFs;
    });

    await expect(buildHomebrewVfsSelection(
      planHomebrewVfsSelection(selectionBytes(closure.map(({ descriptor: item }) => item))),
      {
        baseFs,
        loadBottleBytes(pkg) {
          return closure.find(({ descriptor: item }) => item.fullName === pkg.fullName)!.bottle;
        },
      },
    )).rejects.toThrow(/posix-utils-lite.*link source.*bin\/ed.*missing/);
    expect(privateFs).toBeDefined();
    expect(() => privateFs!.lstat(`${PREFIX}/bin/good`)).toThrow();
    expect(() => privateFs!.lstat(`${PREFIX}/bin/ed`)).toThrow();
    expect(() => privateFs!.lstat(`${PREFIX}/opt/good`)).toThrow();
  });

  it("preflights canonical opt conflicts before applying any ordinary or opt link", async () => {
    const bootstrap = bootstrapFixture();
    const alphaBottle = bottleTar([
      bottleEntry("alpha", "1.0", ".brew/alpha.rb", "class Alpha < Formula\nend\n"),
      bottleEntry("alpha", "1.0", "INSTALL_RECEIPT.json", receipt([])),
      bottleEntry("alpha", "1.0", "bin/alpha", "alpha\n", 0o755),
    ]);
    const alpha = descriptor({
      name: "alpha",
      version: "1.0",
      bottle: alphaBottle,
      links: [{
        type: "symlink",
        source: "Cellar/alpha/1.0/bin/alpha",
        target: "bin/alpha",
      }],
    });
    const closure = [bootstrap, { descriptor: alpha, bottle: alphaBottle }];
    const baseFs = MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));
    ensureDirRecursive(baseFs, `${PREFIX}/opt`);
    writeVfsFile(baseFs, `${PREFIX}/opt/alpha`, "occupied\n", 0o644);
    const rebase = baseFs.rebaseToNewFileSystem.bind(baseFs);
    let privateFs: MemoryFileSystem | undefined;
    vi.spyOn(baseFs, "rebaseToNewFileSystem").mockImplementation((maxByteLength) => {
      privateFs = rebase(maxByteLength);
      return privateFs;
    });

    await expect(buildHomebrewVfsSelection(
      planHomebrewVfsSelection(selectionBytes(closure.map(({ descriptor: item }) => item))),
      {
        baseFs,
        loadBottleBytes(pkg) {
          return closure.find(({ descriptor: item }) => item.fullName === pkg.fullName)!.bottle;
        },
      },
    )).rejects.toThrow(/canonical opt link opt\/alpha.*already exists/i);
    expect(privateFs).toBeDefined();
    expect(readVfsFile(privateFs!, `${PREFIX}/opt/alpha`)).toBe("occupied\n");
    expect(() => privateFs!.lstat(`${PREFIX}/bin/alpha`)).toThrow();
    expect(() => privateFs!.lstat(`${PREFIX}/opt/homebrew-bootstrap`)).toThrow();
  });

  it("rejects child-before-directory-parent selected targets before applying links", async () => {
    const bootstrap = bootstrapFixture();
    const alphaBottle = bottleTar([
      bottleEntry("alpha", "1.0", ".brew/alpha.rb", "class Alpha < Formula\nend\n"),
      bottleEntry("alpha", "1.0", "INSTALL_RECEIPT.json", receipt([])),
      bottleEntry("alpha", "1.0", "bin/child", "child\n", 0o755),
      {
        path: "alpha/1.0/share/source-parent",
        type: "directory",
        mode: 0o755,
      },
    ]);
    const alpha = descriptor({
      name: "alpha",
      version: "1.0",
      bottle: alphaBottle,
      links: [
        {
          type: "symlink",
          source: "Cellar/alpha/1.0/bin/child",
          target: "share/tree/child",
        },
        {
          type: "directory",
          source: "Cellar/alpha/1.0/share/source-parent",
          target: "share/tree",
        },
      ],
    });
    const closure = [bootstrap, { descriptor: alpha, bottle: alphaBottle }];
    const baseFs = MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));
    const rebase = baseFs.rebaseToNewFileSystem.bind(baseFs);
    let privateFs: MemoryFileSystem | undefined;
    vi.spyOn(baseFs, "rebaseToNewFileSystem").mockImplementation((maxByteLength) => {
      privateFs = rebase(maxByteLength);
      return privateFs;
    });

    await expect(buildHomebrewVfsSelection(
      planHomebrewVfsSelection(selectionBytes(closure.map(({ descriptor: item }) => item))),
      {
        baseFs,
        loadBottleBytes(pkg) {
          return closure.find(({ descriptor: item }) => item.fullName === pkg.fullName)!.bottle;
        },
      },
    )).rejects.toThrow(
      /selected link targets share\/tree\/child and share\/tree are nested; nested targets are unsupported/,
    );
    expect(privateFs).toBeDefined();
    expect(() => privateFs!.lstat(`${PREFIX}/share/tree/child`)).toThrow();
    expect(() => privateFs!.lstat(`${PREFIX}/opt/alpha`)).toThrow();
    expect(() => baseFs.lstat(PREFIX)).toThrow();
  });

  it("snapshots a mutable plan before awaiting bottle loaders", async () => {
    const bootstrap = bootstrapFixture();
    const alpha = simpleBottle("alpha", "1.0", "alpha", "bin/alpha");
    const closure = [bootstrap, alpha];
    const canonicalPlan = planHomebrewVfsSelection(
      selectionBytes(closure.map(({ descriptor: item }) => item)),
    );
    expect(Object.isFrozen(canonicalPlan)).toBe(true);
    expect(Object.isFrozen(canonicalPlan.packages[0])).toBe(true);
    const mutablePlan = structuredClone(canonicalPlan);

    const result = await buildHomebrewVfsSelection(mutablePlan, {
      async loadBottleBytes(pkg) {
        if (pkg.fullName === BOOTSTRAP) {
          mutablePlan.packages[1]!.keg = `${CELLAR}/mutated/9.9`;
          await Promise.resolve();
        }
        return closure.find(({ descriptor: item }) => item.fullName === pkg.fullName)!.bottle;
      },
    });

    expect(result.report.packages[1]!.keg).toBe(`${CELLAR}/alpha/1.0`);
    expect(result.fs.readlink(`${PREFIX}/opt/alpha`)).toBe("../Cellar/alpha/1.0");
  });

  it("rejects a forged selection digest before loading bottle bytes", async () => {
    const bootstrap = bootstrapFixture();
    const plan = structuredClone(planHomebrewVfsSelection(
      selectionBytes([bootstrap.descriptor]),
    ));
    plan.selectionSha256 = "0".repeat(64);
    let loaded = false;

    await expect(buildHomebrewVfsSelection(plan, {
      loadBottleBytes() {
        loaded = true;
        throw new Error("bottle loader must not run for a forged selection digest");
      },
    })).rejects.toThrow(/selectionSha256.*canonical selection/i);
    expect(loaded).toBe(false);
  });

  it("rejects an ordinary archive member outside the exact selected keg", async () => {
    const bootstrap = bootstrapFixture();
    const escapedBottle = bottleTar([
      bottleEntry("escaped", "1.0", ".brew/escaped.rb", "class Escaped < Formula\nend\n"),
      bottleEntry("escaped", "1.0", "INSTALL_RECEIPT.json", receipt([])),
      { path: "Cellar/other/1.0/bin/other", data: "outside\n" },
    ]);
    const escaped = descriptor({ name: "escaped", version: "1.0", bottle: escapedBottle });
    const closure = [bootstrap, { descriptor: escaped, bottle: escapedBottle }];
    await expect(buildHomebrewVfsSelection(
      planHomebrewVfsSelection(selectionBytes(closure.map(({ descriptor: item }) => item))),
      {
        loadBottleBytes(pkg) {
          return closure.find(({ descriptor: item }) => item.fullName === pkg.fullName)!.bottle;
        },
      },
    )).rejects.toThrow(/not contained in exact keg/);
  });
});

function descriptor(options: {
  name: string;
  version: string;
  bottle: Uint8Array;
  materialization?: HomebrewBottleDescriptor["materialization"];
  dependencies?: HomebrewBottleDependencyIdentity[];
  links?: HomebrewBottleDescriptor["links"];
  pathPrepend?: string[];
}): HomebrewBottleDescriptor {
  const sha = sha256(options.bottle);
  const payloadRoot = `${options.name}/${options.version}`;
  const materialization = options.materialization ?? "keg";
  const supportOutputs = materialization === "homebrew-runtime-support-v1"
    ? [
      {
        name: "homebrew-bootstrap",
        kegRelativePath: "libexec/homebrew-bootstrap.zip",
        sha256: sha256(new TextEncoder().encode("bootstrap zip")),
        bytes: new TextEncoder().encode("bootstrap zip").byteLength,
      },
      {
        name: "homebrew-brew",
        kegRelativePath: "libexec/homebrew-brew.env",
        sha256: sha256(new TextEncoder().encode("HOMEBREW_PREFIX=/opt/kandelo/homebrew\n")),
        bytes: new TextEncoder().encode("HOMEBREW_PREFIX=/opt/kandelo/homebrew\n").byteLength,
      },
    ]
    : [];
  return {
    schema: 1,
    name: options.name,
    fullName: `kandelo-dev/tap-core/${options.name}`,
    version: options.version,
    revision: 0,
    bottleRebuild: 0,
    arch: "wasm32",
    kandeloAbi: 42,
    bottleTag: "wasm32_kandelo",
    layout: "kandelo-homebrew-v1",
    materialization,
    prefix: PREFIX,
    cellar: CELLAR,
    keg: `${CELLAR}/${payloadRoot}`,
    payloadRoot,
    receipts: [
      `Cellar/${payloadRoot}/.brew/${options.name}.rb`,
      `Cellar/${payloadRoot}/INSTALL_RECEIPT.json`,
    ],
    links: options.links ?? [],
    pathPrepend: options.pathPrepend ?? [],
    supportOutputs,
    dependencies: options.dependencies ?? [],
    url: `https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/${options.name}/blobs/sha256:${sha}`,
    sha256: sha,
    bytes: options.bottle.byteLength,
    compression: "gzip",
  };
}

function bootstrapFixture(): {
  descriptor: HomebrewBottleDescriptor;
  bottle: Uint8Array;
} {
  return homebrewTestBootstrapFixture();
}

function bootstrapEntries(): TarSpec[] {
  return homebrewTestBootstrapEntries();
}

async function expectFlatBootstrapBottleRejected(
  bottle: Uint8Array,
  expected: RegExp,
): Promise<void> {
  const bootstrap = descriptor({
    name: "homebrew-bootstrap",
    version: "6.0.12_1",
    bottle,
    materialization: "homebrew-runtime-support-v1",
  });
  await expect(buildHomebrewVfsSelection(
    planHomebrewVfsSelection(selectionBytes([bootstrap])),
    { loadBottleBytes: () => bottle },
  )).rejects.toThrow(expected);
}

function simpleBottle(
  name: string,
  version: string,
  sourceName: string,
  target: string,
): { descriptor: HomebrewBottleDescriptor; bottle: Uint8Array } {
  const bottle = bottleTar([
    bottleEntry(name, version, `.brew/${name}.rb`, `class ${name} < Formula\nend\n`),
    bottleEntry(name, version, "INSTALL_RECEIPT.json", receipt([])),
    bottleEntry(name, version, `bin/${sourceName}`, `${name}\n`, 0o755),
  ]);
  return {
    bottle,
    descriptor: descriptor({
      name,
      version,
      bottle,
      links: [{
        type: "symlink",
        source: `Cellar/${name}/${version}/bin/${sourceName}`,
        target,
      }],
    }),
  };
}

function selectionBytes(bottles: HomebrewBottleDescriptor[]): Uint8Array {
  return encodeHomebrewBottleSelection({
    schema: 1,
    name: "experimental-abi42-flat-builder",
    arch: "wasm32",
    kandeloAbi: 42,
    bottles,
    requestedVfsFilename: "kandelo-homebrew-experimental-abi42-wasm32.vfs.zst",
    resourcePolicy: "kandelo-homebrew-vfs-generous-v1",
    linkPolicy: "kandelo-homebrew-link-ownership-v1",
    runtimeSupport: "kandelo-homebrew-bootstrap-v1",
  });
}

function dependency(pkg: HomebrewBottleDescriptor): HomebrewBottleDependencyIdentity {
  return {
    fullName: pkg.fullName,
    version: pkg.version,
    revision: pkg.revision,
    bottleRebuild: pkg.bottleRebuild,
    bottleSha256: pkg.sha256,
  };
}

function bottleEntry(
  name: string,
  version: string,
  relativePath: string,
  data: string,
  mode?: number,
): TarSpec {
  return { path: `${name}/${version}/${relativePath}`, data, mode };
}

function receipt(runtimeDependencies: unknown[], changedFiles: string[] = []): string {
  return `${JSON.stringify({
    changed_files: changedFiles,
    runtime_dependencies: runtimeDependencies,
  })}\n`;
}

function bottleTar(entries: TarSpec[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const entry of entries) {
    chunks.push(tarHeader(entry), tarPayload(entry));
  }
  chunks.push(new Uint8Array(1024));
  const tar = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    tar.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return gzipSync(tar);
}

function tarHeader(entry: TarSpec): Uint8Array {
  const header = new Uint8Array(512);
  const data = tarData(entry);
  writeString(header, 0, 100, entry.path);
  writeOctal(header, 100, 8, entry.mode ?? (entry.type === "directory" ? 0o755 : 0o644));
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, data.byteLength);
  writeOctal(header, 136, 12, 0);
  for (let index = 148; index < 156; index += 1) header[index] = 0x20;
  header[156] = tarTypeflag(entry);
  if (entry.linkName !== undefined) writeString(header, 157, 100, entry.linkName);
  writeString(header, 257, 6, "ustar");
  writeString(header, 263, 2, "00");
  writeOctal(header, 148, 8, header.reduce((sum, byte) => sum + byte, 0));
  header[155] = 0x20;
  return header;
}

function tarPayload(entry: TarSpec): Uint8Array {
  const data = tarData(entry);
  const out = new Uint8Array(Math.ceil(data.byteLength / 512) * 512);
  out.set(data);
  return out;
}

function tarData(entry: TarSpec): Uint8Array {
  if (
    entry.type !== undefined &&
    entry.type !== "file" &&
    entry.type !== "pax"
  ) return new Uint8Array();
  return entry.data instanceof Uint8Array
    ? entry.data
    : new TextEncoder().encode(entry.data ?? "");
}

function tarTypeflag(entry: TarSpec): number {
  switch (entry.type ?? "file") {
    case "file": return "0".charCodeAt(0);
    case "directory": return "5".charCodeAt(0);
    case "symlink": return "2".charCodeAt(0);
    case "hardlink": return "1".charCodeAt(0);
    case "pax": return "x".charCodeAt(0);
  }
}

function paxRecord(key: string, value: string): Uint8Array {
  const encoder = new TextEncoder();
  const body = encoder.encode(`${key}=${value}\n`);
  let digits = 1;
  for (;;) {
    const length = digits + 1 + body.byteLength;
    const text = String(length);
    if (text.length === digits) {
      const prefix = encoder.encode(`${text} `);
      const record = new Uint8Array(prefix.byteLength + body.byteLength);
      record.set(prefix);
      record.set(body, prefix.byteLength);
      return record;
    }
    digits = text.length;
  }
}

function writeString(target: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength > length) throw new Error(`test TAR field too long: ${value}`);
  target.set(bytes, offset);
}

function writeOctal(target: Uint8Array, offset: number, length: number, value: number): void {
  writeString(target, offset, length, `${value.toString(8).padStart(length - 2, "0")}\0`);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readVfsFile(fs: MemoryFileSystem, path: string): string {
  const stat = fs.stat(path);
  const fd = fs.open(path, 0, 0);
  try {
    const bytes = new Uint8Array(stat.size);
    fs.read(fd, bytes, null, bytes.byteLength);
    return new TextDecoder().decode(bytes);
  } finally {
    fs.close(fd);
  }
}

function hasObjectKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((item) => hasObjectKey(item, key));
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(([candidate, item]) =>
    candidate === key || hasObjectKey(item, key)
  );
}
