import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  assertHomebrewFlatLazyVfs,
  composeHomebrewFlatLazyVfs,
  type HomebrewFlatLazyVfsReport,
} from "../src/homebrew-flat-lazy-vfs-composer";
import { prepareHomebrewFlatLazyBoot } from "../src/homebrew-flat-lazy-boot";
import {
  assertHomebrewBottleMirrorBundle,
  assertHomebrewBottleMirrorPlan,
} from "../src/homebrew-vfs-composer";
import { encodeHomebrewBottleSelection } from "../src/homebrew-bottle-selection";
import { planHomebrewVfsSelection } from "../src/homebrew-vfs-planner";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import {
  HOMEBREW_TEST_ABI,
  homebrewTestBootstrapFixture,
  homebrewTestBottleDescriptor,
  homebrewTestBottleEntry,
  homebrewTestBottleTar,
  homebrewTestReceipt,
  type HomebrewTestBootstrapFixtureOptions,
} from "./fixtures/homebrew-flat-vfs";
import type {
  HomebrewBottleDependencyIdentity,
  HomebrewBottleDescriptor,
} from "../src/homebrew-bottle-descriptor";

const MiB = 1024 * 1024;
const PREFIX = "/opt/kandelo/homebrew";
const MATERIALIZATION_POLICY = {
  schema: 1,
  kind: "kandelo-homebrew-vfs-materialization-policy",
  embedded_roots: ["kandelo-dev/tap-core/bash"],
  embedded_package_order: [
    "kandelo-dev/tap-core/libcxx",
    "kandelo-dev/tap-core/ncurses",
    "kandelo-dev/tap-core/bash",
  ],
} as const;
const RUNTIME_POLICY = {
  schema: 1,
  kind: "kandelo-homebrew-flat-runtime-support-policy",
  id: "homebrew-runtime-support",
  bootstrap_package: "kandelo-dev/tap-core/homebrew-bootstrap",
  runtime_roots: ["kandelo-dev/tap-core/ruby"],
  activation: {
    mode: "boot-prefetch",
    capability: "homebrew:runtime",
    root: "/usr/bin/brew",
    atomic_group: "homebrew-runtime-support",
  },
} as const;
const SHELL_CONFIG = {
  version: 1,
  path: "/bin/bash",
  argv: ["bash", "-l", "-i"],
} as const;
const DEMO_CONFIG = { version: 1 } as const;

describe("flat-selection lazy Homebrew composer", () => {
  it("composes the 41-role selection as an eager Bash closure and 38 sealed deferred trees", async () => {
    const fixture = compositionFixture();

    const result = await composeHomebrewFlatLazyVfs(
      fixture.plan,
      fixture.options,
    );

    expect(result.fs).toBe(fixture.outputFs);
    expect(result.report.eagerOwnership.authenticatedBottleOrder).toEqual(
      fixture.plan.packages.map((descriptor) => descriptor.fullName),
    );
    expect(fixture.loads).toEqual(
      fixture.plan.packages.map((descriptor) => descriptor.fullName),
    );
    expect(fixture.scratchFs.stat("/etc/kandelo/homebrew-vfs.json").size)
      .toBeGreaterThan(0);
    expect(result.report.partition).toMatchObject({
      embeddedPackageOrder: [
        "kandelo-dev/tap-core/libcxx",
        "kandelo-dev/tap-core/ncurses",
        "kandelo-dev/tap-core/bash",
      ],
      bootstrapPackage: "kandelo-dev/tap-core/homebrew-bootstrap",
      runtimeCohortPackageOrder: [
        "kandelo-dev/tap-core/libyaml",
        "kandelo-dev/tap-core/ruby",
      ],
    });
    expect(result.report.partition.ordinaryDeferredPackageOrder).toHaveLength(35);
    expect(result.report.partition.deferredPackageOrder).toHaveLength(37);
    expect(result.mirrorBundle.plan.assets).toHaveLength(37);
    expect(result.mirrorBundle.payloads).toHaveLength(37);

    const pending = result.fs.exportLazyArchiveEntries();
    expect(pending).toHaveLength(38);
    const cohort = pending.filter(
      (tree) => tree.activation?.atomicGroup?.id === "homebrew-runtime-support",
    );
    expect(cohort).toHaveLength(3);
    expect(new Set(cohort.map((tree) => tree.activation!.atomicGroup!.member)))
      .toEqual(new Set([
        ...result.report.runtimeCohort.treeIds,
        result.bootstrapTree.descriptor.id,
      ]));
    expect(pending.filter((tree) => tree.activation?.atomicGroup === undefined))
      .toHaveLength(35);
    expect(result.report.deferredTrees.filter((tree) =>
      tree.package === "kandelo-dev/tap-core/zlib" &&
      tree.atomicGroup === undefined
    )).toHaveLength(1);
    expect(result.fs.isPathDeferred("/usr/bin/brew")).toBe(true);
    for (const path of ["/bin/bash", "/usr/bin/bash", "/bin/sh", "/usr/bin/sh"]) {
      expect(result.fs.isPathDeferred(path), path).toBe(false);
      await expect(result.fs.preparePath(path), path).resolves.toBe(false);
      expect(result.fs.stat(path).mode & 0o111, path).not.toBe(0);
    }
    for (const command of ["tar", "gzip"]) {
      const stablePath = `/usr/bin/${command}`;
      expect(result.fs.readlink(stablePath)).toBe(`${PREFIX}/bin/${command}`);
      expect(result.fs.isPathDeferred(stablePath), stablePath).toBe(true);
    }
    for (const command of ["fbdoom", "modeset"]) {
      const stablePath = `/usr/local/bin/${command}`;
      expect(result.fs.readlink(stablePath)).toBe(`${PREFIX}/bin/${command}`);
      expect(result.fs.isPathDeferred(stablePath), stablePath).toBe(true);
    }
    expect(() => result.fs.lstat(`${PREFIX}/Cellar/homebrew-bootstrap`))
      .toThrow();
  });

  it("prepares exactly the sealed runtime cohort at the shared shell-readiness boundary", async () => {
    const fixture = compositionFixture();
    const result = await composeHomebrewFlatLazyVfs(fixture.plan, fixture.options);
    const payloadByUrl = new Map(
      result.mirrorBundle.plan.assets.map((asset) => [
        asset.url,
        result.mirrorBundle.payloads.find((payload) => payload.id === asset.id)!.bytes,
      ]),
    );
    payloadByUrl.set("homebrew-bootstrap.zip", fixture.options.bootstrapZipBytes);
    const fetcher = vi.fn(async (url: string) => {
      const bytes = payloadByUrl.get(url);
      return bytes === undefined
        ? new Response(null, { status: 404 })
        : new Response(bytes, {
            status: 200,
            headers: { "content-length": String(bytes.byteLength) },
          });
    });
    result.fs.setLazyFetcher(fetcher);

    await expect(prepareHomebrewFlatLazyBoot(result.fs)).resolves.toBe(3);

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(new Set(fetcher.mock.calls.map(([url]) => url))).toEqual(new Set([
      "homebrew-bootstrap.zip",
      ...result.mirrorBundle.plan.assets
        .filter((asset) => result.report.runtimeCohort.packageOrder.includes(asset.package))
        .map((asset) => asset.url),
    ]));
    expect(result.fs.isPathDeferred("/usr/bin/brew")).toBe(false);
    const remaining = result.fs.exportLazyArchiveEntries();
    expect(remaining).toHaveLength(35);
    expect(remaining.every((tree) => tree.activation?.atomicGroup === undefined))
      .toBe(true);
    expect(remaining.every((tree) => tree.activation?.capabilities.some(
      (capability) => capability.startsWith("homebrew-bottle:"),
    ))).toBe(true);
    await expect(prepareHomebrewFlatLazyBoot(result.fs)).resolves.toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("rejects shell readiness when an ordinary deferred bottle tree is missing", async () => {
    const fixture = compositionFixture();
    const result = await composeHomebrewFlatLazyVfs(fixture.plan, fixture.options);
    const internals = result.fs as unknown as {
      lazyArchiveGroups: Array<{
        activation?: {
          capabilities: string[];
          atomicGroup?: { id: string };
        };
      }>;
    };
    const ordinaryCapability = result.fs.exportLazyArchiveEntries()
      .find((tree) => tree.activation?.atomicGroup === undefined)!
      .activation!.capabilities.find((capability) =>
        capability.startsWith("homebrew-bottle:")
      )!;
    const ordinaryIndex = internals.lazyArchiveGroups.findIndex((tree) =>
      tree.activation?.atomicGroup === undefined &&
      tree.activation?.capabilities.includes(ordinaryCapability)
    );
    expect(ordinaryIndex).toBeGreaterThanOrEqual(0);
    internals.lazyArchiveGroups.splice(ordinaryIndex, 1);
    const payloadByUrl = new Map(
      result.mirrorBundle.plan.assets.map((asset) => [
        asset.url,
        result.mirrorBundle.payloads.find((payload) => payload.id === asset.id)!.bytes,
      ]),
    );
    payloadByUrl.set("homebrew-bootstrap.zip", fixture.options.bootstrapZipBytes);
    const fetcher = vi.fn(async (url: string) => {
      const bytes = payloadByUrl.get(url);
      return bytes === undefined
        ? new Response(null, { status: 404 })
        : new Response(bytes, { status: 200 });
    });
    result.fs.setLazyFetcher(fetcher);

    await expect(prepareHomebrewFlatLazyBoot(result.fs))
      .rejects.toThrow(/35|ordinary|mirror|pending|cohort/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a substituted runtime-cohort package before shell readiness", async () => {
    const fixture = compositionFixture();
    const result = await composeHomebrewFlatLazyVfs(fixture.plan, fixture.options);
    const metadata = result.fs.getImageMetadata()!;
    const binding = metadata.homebrewFlatLazy as {
      partition: {
        deferredPackageOrder: string[];
        runtimeCohortPackageOrder: string[];
      };
    };
    const ordinary = binding.partition.deferredPackageOrder.find((packageName) =>
      !binding.partition.runtimeCohortPackageOrder.includes(packageName)
    )!;
    binding.partition.runtimeCohortPackageOrder[0] = ordinary;
    result.fs.setImageMetadata(metadata);
    const payloadByUrl = new Map(
      result.mirrorBundle.plan.assets.map((asset) => [
        asset.url,
        result.mirrorBundle.payloads.find((payload) => payload.id === asset.id)!.bytes,
      ]),
    );
    payloadByUrl.set("homebrew-bootstrap.zip", fixture.options.bootstrapZipBytes);
    const fetcher = vi.fn(async (url: string) => {
      const bytes = payloadByUrl.get(url);
      return bytes === undefined
        ? new Response(null, { status: 404 })
        : new Response(bytes, { status: 200 });
    });
    result.fs.setLazyFetcher(fetcher);

    await expect(prepareHomebrewFlatLazyBoot(result.fs))
      .rejects.toThrow(/runtime cohort|mirror|package/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("binds exact lazy-flat lineage without eager, retired, or catalog provenance", async () => {
    const fixture = compositionFixture();
    const result = await composeHomebrewFlatLazyVfs(fixture.plan, fixture.options);
    const metadata = result.fs.getImageMetadata()!;

    expect(Object.keys(metadata).sort()).toEqual([
      "baseImage",
      "capacity",
      "createdBy",
      "demoConfig",
      "homebrewBootstrap",
      "homebrewFlatLazy",
      "kernelAbi",
      "packageDeferredTrees",
      "shellConfig",
      "version",
    ].sort());
    expect(metadata).toEqual({
      version: 1,
      kernelAbi: HOMEBREW_TEST_ABI,
      createdBy: "host/src/homebrew-flat-lazy-vfs-composer.ts",
      capacity: { maxByteLength: 512 * MiB },
      baseImage: fixture.options.baseImage,
      shellConfig: {
        path: "/bin/bash",
        argv: ["bash", "-l", "-i"],
        sha256: sha256(fixture.options.shellConfig.source),
        bytes: fixture.options.shellConfig.source.byteLength,
      },
      demoConfig: {
        path: "/etc/kandelo/demo.json",
        sha256: sha256(fixture.options.demoConfig.source),
        bytes: fixture.options.demoConfig.source.byteLength,
      },
      packageDeferredTrees: [expect.objectContaining({
        schema: 1,
        kind: "kandelo-package-deferred-zip-tree",
        id: "homebrew-bootstrap/source-tree",
        state: "deferred",
        package: {
          name: "homebrew-bootstrap",
          output: "homebrew-bootstrap.zip",
        },
      })],
      homebrewBootstrap: result.bootstrapConsumer,
      homebrewFlatLazy: result.binding,
    });
    expect(result.binding.partition).toEqual({
      embeddedPackageOrder: result.report.partition.embeddedPackageOrder,
      deferredPackageOrder: result.report.partition.deferredPackageOrder,
      bootstrapPackage: result.report.partition.bootstrapPackage,
      runtimeCohortPackageOrder:
        result.report.partition.runtimeCohortPackageOrder,
    });
    for (const retired of [
      "homebrewFlat",
      "homebrew",
      "shellComposition",
      "catalog",
      "tap",
      "migrationLock",
    ]) {
      expect(metadata).not.toHaveProperty(retired);
      expect(result.report).not.toHaveProperty(retired);
    }
  });

  it("round trips every pending binding and seal without fetching", async () => {
    const fixture = compositionFixture();
    const fetcher = vi.fn(async () => {
      throw new Error("serialization must not fetch");
    });
    fixture.outputFs.setLazyFetcher(fetcher);
    const result = await composeHomebrewFlatLazyVfs(fixture.plan, fixture.options);
    const before = result.fs.exportLazyArchiveEntries();
    const usage = result.fs.pendingDeferredTreeUsage();
    const image = await result.fs.saveImage({ normalizeTimestampsMs: 0 });
    expect(fetcher).not.toHaveBeenCalled();

    const restored = MemoryFileSystem.fromImagePreservingCapacity(image);
    const restoredFetcher = vi.fn(async () => {
      throw new Error("round-trip verification must not fetch");
    });
    restored.setLazyFetcher(restoredFetcher);
    await restored.verifyImportedLazyAtomicGroupSeals();
    expect(restored.exportLazyArchiveEntries()).toEqual(before);
    expect(restored.pendingDeferredTreeUsage()).toEqual(usage);
    expect(restored.getImageMetadata()).toEqual(result.report.metadata);
    assertHomebrewFlatLazyVfs(
      restored,
      result.report,
      result.bootstrapTree,
      result.bootstrapConsumer,
    );
    expect(restoredFetcher).not.toHaveBeenCalled();
  });

  it("rejects pending transport drift repeated by report evidence but not the mirror plan", async () => {
    const fixture = compositionFixture();
    const result = await composeHomebrewFlatLazyVfs(fixture.plan, fixture.options);
    const report = structuredClone(result.report) as HomebrewFlatLazyVfsReport;
    const expected = report.deferredTrees[0]!;
    const originalUrl = expected.transports[0]!;
    const changedUrl = originalUrl.replace(
      "kandelo-dev/homebrew-tap-core",
      "kandelo-dev/forged-homebrew-tap-core",
    );
    expect(changedUrl).not.toBe(originalUrl);
    result.fs.rewriteLazyArchiveUrls((url) => url === originalUrl ? changedUrl : url);
    expected.transports[0] = changedUrl;

    expect(() => assertHomebrewFlatLazyVfs(
      result.fs,
      report,
      result.bootstrapTree,
      result.bootstrapConsumer,
    )).toThrow(/mirror.*tree|tree.*mirror|transport.*plan/i);
  });

  it.each([
    ["extra shell field", { ...SHELL_CONFIG, unexpected: true }],
    [
      "more than 64 shell arguments",
      { ...SHELL_CONFIG, argv: Array.from({ length: 65 }, (_, index) => `arg-${index}`) },
    ],
    ["NUL shell argument", { ...SHELL_CONFIG, argv: ["bash", "bad\0arg"] }],
  ])("rejects %s through the authoritative shell parser", async (_label, config) => {
    const fixture = compositionFixture();

    await expect(composeHomebrewFlatLazyVfs(fixture.plan, {
      ...fixture.options,
      shellConfig: { config, source: jsonBytes(config) },
    })).rejects.toThrow(/shell config|arguments|NUL|exactly/i);
  });

  it.each([
    [
      "malformed nested demo asset",
      { version: 1 as const, assets: [{ path: "relative", url: "https://example.invalid" }] },
    ],
    [
      "oversized demo bytes",
      { version: 1 as const, padding: "x".repeat(256 * 1024) },
    ],
  ])("rejects %s through the authoritative demo parser", async (_label, config) => {
    const fixture = compositionFixture();

    await expect(composeHomebrewFlatLazyVfs(fixture.plan, {
      ...fixture.options,
      demoConfig: { config, source: jsonBytes(config) },
    })).rejects.toThrow(/demo config|assets|absolute|bytes/i);
  });

  it.each([
    ["selection digest", (plan: typeof import("../src/homebrew-vfs-planner").HomebrewFlatVfsPlan) => {
      plan.selectionSha256 = "f".repeat(64);
    }],
    ["ABI", (plan: typeof import("../src/homebrew-vfs-planner").HomebrewFlatVfsPlan) => {
      plan.kandeloAbi = 41;
    }],
  ])("rejects a changed %s before loading bottles", async (_label, mutate) => {
    const fixture = compositionFixture();
    const plan = structuredClone(fixture.plan);
    mutate(plan);

    await expect(composeHomebrewFlatLazyVfs(plan, fixture.options))
      .rejects.toThrow(/selection|ABI|abi|base-image identity/i);
    expect(fixture.loads).toEqual([]);
  });

  it.each([
    [
      "incomplete embedded closure",
      {
        ...MATERIALIZATION_POLICY,
        embedded_package_order: [
          "kandelo-dev/tap-core/ncurses",
          "kandelo-dev/tap-core/bash",
        ],
      },
      RUNTIME_POLICY,
    ],
    [
      "overlapping embedded runtime root",
      MATERIALIZATION_POLICY,
      { ...RUNTIME_POLICY, runtime_roots: ["kandelo-dev/tap-core/bash"] },
    ],
  ])("rejects an %s after the complete eager proof", async (
    _label,
    materializationPolicy,
    runtimePolicy,
  ) => {
    const fixture = compositionFixture();

    await expect(composeHomebrewFlatLazyVfs(fixture.plan, {
      ...fixture.options,
      materializationPolicyValue: materializationPolicy,
      materializationPolicyBytes: jsonBytes(materializationPolicy),
      runtimeSupportPolicyValue: runtimePolicy,
      runtimeSupportPolicyBytes: jsonBytes(runtimePolicy),
    })).rejects.toThrow(/closure|partition|canonical|roles/i);
    expect(fixture.loads).toEqual(
      fixture.plan.packages.map((descriptor) => descriptor.fullName),
    );
  });

  it("rejects a non-embedded Bash dependency after authenticating the selection", async () => {
    const fixture = compositionFixture({}, { bashDependsOnZlib: true });

    await expect(composeHomebrewFlatLazyVfs(fixture.plan, fixture.options))
      .rejects.toThrow(/embedded closure|canonical/i);
    expect(fixture.loads).toEqual(
      fixture.plan.packages.map((descriptor) => descriptor.fullName),
    );
  });

  it.each(["ZIP", "environment"])(
    "rejects wrong selected bootstrap %s output",
    async (kind) => {
      const fixture = compositionFixture();
      const field = kind === "ZIP"
        ? "bootstrapZipBytes"
        : "bootstrapEnvironmentBytes";
      const changed = Uint8Array.from(fixture.options[field]);
      changed[0] ^= 0xff;

      await expect(composeHomebrewFlatLazyVfs(fixture.plan, {
        ...fixture.options,
        [field]: changed,
      })).rejects.toThrow(/provided .* differs from selected support output/i);
      expect(fixture.loads).toHaveLength(41);
    },
  );

  it("rejects empty, incomplete, mutable, and byte-mismatched mirror products", async () => {
    const fixture = compositionFixture();
    const result = await composeHomebrewFlatLazyVfs(fixture.plan, fixture.options);
    const bundle = result.mirrorBundle;

    const empty = structuredClone(bundle.plan);
    empty.assets = [];
    expect(() => assertHomebrewBottleMirrorPlan(empty)).toThrow();

    expect(() => assertHomebrewBottleMirrorBundle(
      bundle.plan,
      bundle.payloads.slice(1),
      bundle.planAsset,
    )).toThrow(/one-to-one|differs/i);
    expect(() => assertHomebrewBottleMirrorBundle(
      bundle.plan,
      [...bundle.payloads, structuredClone(bundle.payloads[0]!)],
      bundle.planAsset,
    )).toThrow(/one-to-one|differs/i);

    const mutable = structuredClone(bundle.plan);
    mutable.assets[0]!.url = "https://example.invalid/latest/bottle.tar.gz";
    expect(() => assertHomebrewBottleMirrorPlan(mutable)).toThrow(/identity|url/i);

    const changedDigest = structuredClone(bundle);
    changedDigest.payloads[0]!.bytes[0] ^= 0xff;
    expect(() => assertHomebrewBottleMirrorBundle(
      changedDigest.plan,
      changedDigest.payloads,
      changedDigest.planAsset,
    )).toThrow(/payload differs/i);

    const changedSize = structuredClone(bundle);
    changedSize.plan.assets[0]!.bytes += 1;
    expect(() => assertHomebrewBottleMirrorBundle(
      changedSize.plan,
      changedSize.payloads,
      changedSize.planAsset,
    )).toThrow();
  });

  it("fails closed when a sealed runtime cohort is mutated", async () => {
    const fixture = compositionFixture();
    const result = await composeHomebrewFlatLazyVfs(fixture.plan, fixture.options);
    const internals = result.fs as unknown as {
      lazyArchiveGroups: Array<{
        activation?: { atomicGroup?: { id: string; expectedCount?: number } };
      }>;
    };
    const member = internals.lazyArchiveGroups.find(
      (group) => group.activation?.atomicGroup?.id === "homebrew-runtime-support",
    )!;
    member.activation!.atomicGroup!.expectedCount = undefined;

    expect(() => assertHomebrewFlatLazyVfs(
      result.fs,
      result.report,
      result.bootstrapTree,
      result.bootstrapConsumer,
    )).toThrow(/seal|changed/i);
  });

  it("rejects invented nested catalog provenance even if a report repeats it", async () => {
    const fixture = compositionFixture();
    const result = await composeHomebrewFlatLazyVfs(fixture.plan, fixture.options);
    const report = structuredClone(result.report) as HomebrewFlatLazyVfsReport;
    const metadata = report.metadata as Record<string, unknown>;
    (metadata.homebrewFlatLazy as Record<string, unknown>).catalog = {
      commit: "0".repeat(40),
    };
    result.fs.setImageMetadata(report.metadata);

    expect(() => assertHomebrewFlatLazyVfs(
      result.fs,
      report,
      result.bootstrapTree,
      result.bootstrapConsumer,
    )).toThrow(/unknown|lineage|catalog/i);
  });

  it.each([
    "base/output",
    "base/scratch",
    "output/scratch",
    "shared buffer",
  ])("requires pairwise-distinct %s filesystems", async (alias) => {
    const fixture = compositionFixture();
    const options = { ...fixture.options };
    if (alias === "base/output") options.outputFs = options.baseFs;
    if (alias === "base/scratch") options.scratchFs = options.baseFs;
    if (alias === "output/scratch") options.scratchFs = options.outputFs;
    if (alias === "shared buffer") {
      options.outputFs = MemoryFileSystem.fromExisting(options.baseFs.sharedBuffer);
    }

    await expect(composeHomebrewFlatLazyVfs(fixture.plan, options))
      .rejects.toThrow(/base.*output.*scratch.*distinct|separate filesystems|buffers/i);
  });

  it("rejects a scratch namespace that is not a fresh clone of the base", async () => {
    const fixture = compositionFixture();
    fixture.scratchFs.mkdir("/unexpected", 0o755);

    await expect(composeHomebrewFlatLazyVfs(fixture.plan, fixture.options))
      .rejects.toThrow(/scratch namespace differs from its base/i);
    expect(fixture.loads).toEqual([]);
  });

  it.each([
    "homebrewFlatLazy",
    "homebrewFlat",
    "homebrew",
    "shellComposition",
    "packageDeferredTrees",
    "homebrewBootstrap",
    "catalog",
    "tap",
    "migrationLock",
  ])("rejects inherited %s lineage before loading bottles", async (field) => {
    const fixture = compositionFixture();
    for (const fs of [fixture.baseFs, fixture.outputFs]) {
      fs.setImageMetadata({
        ...fs.getImageMetadata()!,
        [field]: {},
      });
    }

    await expect(composeHomebrewFlatLazyVfs(fixture.plan, fixture.options))
      .rejects.toThrow(/mixed lineage|metadata-identical|lineage/i);
    expect(fixture.loads).toEqual([]);
  });
});

function compositionFixture(
  bootstrapOptions: HomebrewTestBootstrapFixtureOptions = {},
  fixtureOptions: { bashDependsOnZlib?: boolean } = {},
) {
  const bootstrap = homebrewTestBootstrapFixture(bootstrapOptions);
  const bottleBytes = new Map<string, Uint8Array>();
  const descriptors: HomebrewBottleDescriptor[] = [];
  const loads: string[] = [];
  const add = (
    name: string,
    dependencies: readonly HomebrewBottleDescriptor[] = [],
  ): HomebrewBottleDescriptor => {
    const version = "1.0";
    const runtimeDependencies = dependencies.map((dependency) => ({
      declared_directly: true,
      full_name: dependency.fullName,
      pkg_version: dependency.version,
      revision: dependency.revision,
    }));
    const bottle = homebrewTestBottleTar([
      homebrewTestBottleEntry(
        name,
        version,
        `.brew/${name}.rb`,
        `class ${name.replaceAll("-", "")} < Formula\nend\n`,
      ),
      homebrewTestBottleEntry(
        name,
        version,
        "INSTALL_RECEIPT.json",
        homebrewTestReceipt(runtimeDependencies),
      ),
      homebrewTestBottleEntry(
        name,
        version,
        `bin/${name}`,
        `#!/bin/sh\necho ${name}\n`,
        0o755,
      ),
    ]);
    const descriptor = homebrewTestBottleDescriptor({
      name,
      version,
      bottle,
      dependencies: dependencies.map(dependencyIdentity),
      links: [{
        type: "symlink",
        source: `Cellar/${name}/${version}/bin/${name}`,
        target: `bin/${name}`,
      }],
      pathPrepend: name === "bash" ? ["bin"] : [],
    });
    descriptors.push(descriptor);
    bottleBytes.set(descriptor.fullName, bottle);
    return descriptor;
  };

  const libcxx = add("libcxx");
  const ncurses = add("ncurses", [libcxx]);
  const earlyZlib = fixtureOptions.bashDependsOnZlib ? add("zlib") : undefined;
  add("bash", earlyZlib === undefined ? [ncurses] : [ncurses, earlyZlib]);
  descriptors.push(bootstrap.descriptor);
  bottleBytes.set(bootstrap.descriptor.fullName, bootstrap.bottle);
  const zlib = earlyZlib ?? add("zlib");
  add("tar", [zlib]);
  add("gzip", [zlib]);
  add("fbdoom");
  add("modeset");
  for (let index = 1; index <= 30; index += 1) {
    add(`ordinary-${String(index).padStart(2, "0")}`);
  }
  const libyaml = add("libyaml", [zlib]);
  add("ruby", [libyaml, zlib]);

  const selectionBytes = encodeHomebrewBottleSelection({
    schema: 1,
    name: `main-shell-abi${HOMEBREW_TEST_ABI}-wasm32`,
    arch: "wasm32",
    kandeloAbi: HOMEBREW_TEST_ABI,
    bottles: descriptors,
    requestedVfsFilename: "shell.vfs.zst",
    resourcePolicy: "kandelo-homebrew-vfs-main-shell-v1",
    linkPolicy: "kandelo-homebrew-link-ownership-v1",
    runtimeSupport: "kandelo-homebrew-bootstrap-v1",
  });
  const plan = planHomebrewVfsSelection(selectionBytes);
  const maxByteLength = 512 * MiB;
  const baseFs = fsWithCapacity(maxByteLength);
  baseFs.setImageMetadata({
    version: 1,
    kernelAbi: HOMEBREW_TEST_ABI,
    createdBy: "test base",
  });
  const outputFs = baseFs.rebaseToNewFileSystem(maxByteLength);
  const scratchFs = baseFs.rebaseToNewFileSystem(maxByteLength);
  const materializationPolicyBytes = jsonBytes(MATERIALIZATION_POLICY);
  const runtimeSupportPolicyBytes = jsonBytes(RUNTIME_POLICY);
  const shellConfigBytes = jsonBytes(SHELL_CONFIG);
  const demoConfigBytes = jsonBytes(DEMO_CONFIG);
  return {
    plan,
    baseFs,
    outputFs,
    scratchFs,
    loads,
    options: {
      materializationPolicyValue: MATERIALIZATION_POLICY,
      materializationPolicyBytes,
      runtimeSupportPolicyValue: RUNTIME_POLICY,
      runtimeSupportPolicyBytes,
      baseFs,
      outputFs,
      scratchFs,
      baseImage: {
        sha256: "a".repeat(64),
        bytes: 4096,
        kernelAbi: HOMEBREW_TEST_ABI,
      },
      loadBottleBytes(descriptor: HomebrewBottleDescriptor) {
        loads.push(descriptor.fullName);
        return bottleBytes.get(descriptor.fullName)!;
      },
      bootstrapZipBytes: bootstrap.zip,
      bootstrapEnvironmentBytes: bootstrap.environment,
      mirrorRepository: "kandelo-dev/homebrew-tap-core",
      shellConfig: { config: SHELL_CONFIG, source: shellConfigBytes },
      demoConfig: { config: DEMO_CONFIG, source: demoConfigBytes },
      normalizeTimestampsMs: 0,
    },
  };
}

function dependencyIdentity(
  descriptor: HomebrewBottleDescriptor,
): HomebrewBottleDependencyIdentity {
  return {
    fullName: descriptor.fullName,
    version: descriptor.version,
    revision: descriptor.revision,
    bottleRebuild: descriptor.bottleRebuild,
    bottleSha256: descriptor.sha256,
  };
}

function fsWithCapacity(maxByteLength: number): MemoryFileSystem {
  return MemoryFileSystem.create(
    new SharedArrayBuffer(8 * MiB, { maxByteLength }),
    maxByteLength,
  );
}

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
