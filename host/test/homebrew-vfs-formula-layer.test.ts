import { describe, expect, it } from "vitest";

import {
  HOMEBREW_VFS_FORMULA_LAYER_KIND,
  HOMEBREW_VFS_FORMULA_MANIFEST_RELATIVE_PATH,
  HOMEBREW_VFS_FORMULA_PAYLOAD_RELATIVE_PATH,
  parseHomebrewVfsFormulaLayerManifest,
  preflightHomebrewVfsFormulaLayers,
  projectHomebrewVfsFormulaLayer,
  type HomebrewVfsFormulaLayerManifest,
  type HomebrewVfsFormulaLayerProjection,
} from "../src/homebrew-vfs-formula-layer";
import type {
  HomebrewDependency,
  HomebrewFederatedVfsPlan,
  HomebrewVfsPackagePlan,
} from "../src/homebrew-vfs-planner";
import type { TarEntry } from "../src/vfs/tar";

const CORE_TAP = "kandelo-dev/tap-core";
const EXTERNAL_TAP = "example/homebrew-apps";
const PREFIX = "/home/linuxbrew/.linuxbrew";

function pkg(
  tapName: string,
  name: string,
  dependencies: HomebrewDependency[] = [],
): HomebrewVfsPackagePlan {
  const version = "1.0";
  const fullName = `${tapName}/${name}`;
  const tapRepository = `${tapName}-repository`;
  const tapCommit = "1".repeat(40);
  const kandeloRepository = "Automattic/kandelo";
  const kandeloCommit = "2".repeat(40);
  const sha256 = "3".repeat(64);
  const cacheKeySha = "4".repeat(64);
  const keg = `${PREFIX}/Cellar/${name}/${version}`;
  const payloadRoot = `${name}/${version}`;
  const url = `https://example.invalid/${tapName}/${name}.tar.gz`;
  return {
    name,
    fullName,
    tapRepository,
    tapName,
    tapCommit,
    kandeloRepository,
    kandeloCommit,
    version,
    formulaRevision: 0,
    bottleRebuild: 0,
    arch: "wasm32",
    kandeloAbi: 41,
    metadataStatus: "success",
    sourceStatus: "success",
    url,
    sha256,
    bytes: 1024,
    cacheKeySha,
    dependencies,
    runtimeSupport: ["node", "browser"],
    browserCompatible: true,
    prefix: PREFIX,
    cellar: "any",
    keg,
    payloadRoot,
    linkManifestPath: `metadata/link-manifests/${name}.json`,
    linkManifest: {
      schema: 1,
      package: fullName,
      version,
      arch: "wasm32",
      kandelo_abi: 41,
      prefix: PREFIX,
      cellar: "any",
      keg,
      bottle: {
        url,
        sha256,
        bytes: 1024,
        cache_key_sha: cacheKeySha,
        payload_root: payloadRoot,
      },
      links: [],
      receipts: [],
      env: {},
    },
  };
}

function plan(
  root: HomebrewVfsPackagePlan,
  dependencies: HomebrewVfsPackagePlan[] = [],
): HomebrewFederatedVfsPlan {
  const [owner, tap] = root.tapName.split("/");
  return {
    schema: 1,
    tapRepository: `${owner}/${tap}`,
    tapName: root.tapName,
    tapCommit: "1".repeat(40),
    kandeloRepository: "Automattic/kandelo",
    kandeloCommit: "2".repeat(40),
    kandeloAbi: 41,
    releaseTag: "bottles-abi-v41",
    requestedPackages: [root.name],
    requestedFullNames: [root.fullName],
    taps: [],
    packages: [...dependencies, root],
  };
}

function manifest(
  packageName: string,
  roots = ["/etc/dinit.d"],
): HomebrewVfsFormulaLayerManifest {
  return {
    schema: 1,
    kind: HOMEBREW_VFS_FORMULA_LAYER_KIND,
    package: packageName,
    payload: {
      root: HOMEBREW_VFS_FORMULA_PAYLOAD_RELATIVE_PATH,
      mount_prefix: "/",
    },
    activation: {
      mode: "first-use",
      capabilities: [`service:${packageName.split("/")[2]}`],
      roots,
    },
  };
}

function bottleEntries(
  root: HomebrewVfsPackagePlan,
  payload: TarEntry[] = [
    { path: "etc", type: "directory", mode: 0o755 },
    { path: "etc/dinit.d", type: "directory", mode: 0o755 },
    {
      path: "etc/dinit.d/service",
      type: "file",
      mode: 0o644,
      data: new TextEncoder().encode("type = process\n"),
    },
  ],
  manifestValue: unknown = manifest(root.fullName),
): TarEntry[] {
  const payloadSource = `${root.payloadRoot}/${HOMEBREW_VFS_FORMULA_PAYLOAD_RELATIVE_PATH}`;
  return [
    {
      path: `${root.payloadRoot}/${HOMEBREW_VFS_FORMULA_MANIFEST_RELATIVE_PATH}`,
      type: "file",
      mode: 0o644,
      data: new TextEncoder().encode(`${JSON.stringify(manifestValue)}\n`),
    },
    { path: payloadSource, type: "directory", mode: 0o755 },
    ...payload.map((entry) => ({
      ...entry,
      path: `${payloadSource}/${entry.path}`,
    })),
  ];
}

function projection(
  tapName: string,
  name: string,
  payload: TarEntry[],
  dependencies: HomebrewVfsPackagePlan[] = [],
): HomebrewVfsFormulaLayerProjection {
  const rootDependencies = dependencies.map((dependency) => ({
    name: dependency.name,
    full_name: dependency.fullName,
  }));
  const root = pkg(tapName, name, rootDependencies);
  return projectHomebrewVfsFormulaLayer(
    plan(root, dependencies),
    root.fullName,
    bottleEntries(
      root,
      payload,
      manifest(root.fullName, [`/${payload[0]!.path.split("/")[0]}`]),
    ),
  );
}

describe("Homebrew VFS Formula layer manifest", () => {
  it("parses the fixed URL-free keg contract", () => {
    const value = manifest(`${EXTERNAL_TAP}/blog-vfs`);

    expect(parseHomebrewVfsFormulaLayerManifest(value)).toEqual(value);
    expect(JSON.stringify(value)).not.toMatch(/https:|sha256|release/);
  });

  it("rejects open-ended fields, alternate payload locations, and unordered policy", () => {
    const value = manifest(`${EXTERNAL_TAP}/blog-vfs`);
    expect(() =>
      parseHomebrewVfsFormulaLayerManifest({
        ...value,
        release_url: "https://example.invalid/layer",
      }),
    ).toThrow("unexpected or missing fields");
    expect(() =>
      parseHomebrewVfsFormulaLayerManifest({
        ...value,
        payload: { ...value.payload, root: "share/rootfs" },
      }),
    ).toThrow("conventional keg root");
    expect(() =>
      parseHomebrewVfsFormulaLayerManifest({
        ...value,
        activation: {
          ...value.activation,
          roots: ["/var/lib/blog", "/etc/dinit.d"],
        },
      }),
    ).toThrow("not in canonical order");
  });
});

describe("Homebrew VFS Formula bottle projection", () => {
  it("uses ordinary cross-tap dependencies and maps owned config from the fixed payload", () => {
    const dinit = pkg(CORE_TAP, "dinit");
    const root = pkg(EXTERNAL_TAP, "blog-vfs", [
      {
        name: dinit.name,
        full_name: dinit.fullName,
      },
    ]);
    const projected = projectHomebrewVfsFormulaLayer(
      plan(root, [dinit]),
      root.fullName,
      bottleEntries(root),
    );

    expect(
      projected.dependencies.map((dependency) => dependency.fullName),
    ).toEqual([`${CORE_TAP}/dinit`]);
    expect(projected.packages.map((entry) => entry.fullName)).toEqual([
      `${CORE_TAP}/dinit`,
      `${EXTERNAL_TAP}/blog-vfs`,
    ]);
    expect(projected.entries).toEqual([
      {
        path: "/etc",
        source_path: "blog-vfs/1.0/libexec/kandelo-vfs-layer/rootfs/etc",
        type: "directory",
        mode: 0o755,
        size: 0,
      },
      {
        path: "/etc/dinit.d",
        source_path:
          "blog-vfs/1.0/libexec/kandelo-vfs-layer/rootfs/etc/dinit.d",
        type: "directory",
        mode: 0o755,
        size: 0,
      },
      {
        path: "/etc/dinit.d/service",
        source_path:
          "blog-vfs/1.0/libexec/kandelo-vfs-layer/rootfs/etc/dinit.d/service",
        type: "file",
        mode: 0o644,
        size: 15,
      },
    ]);
  });

  it("requires a complete single-root dependency-first closure", () => {
    const dependency = pkg(CORE_TAP, "dinit");
    const root = pkg(EXTERNAL_TAP, "blog-vfs", [
      {
        name: dependency.name,
        full_name: dependency.fullName,
      },
    ]);
    const entries = bottleEntries(root);

    expect(() =>
      projectHomebrewVfsFormulaLayer(plan(root), root.fullName, entries),
    ).toThrow(`depends on missing ${dependency.fullName}`);
    expect(() =>
      projectHomebrewVfsFormulaLayer(
        plan(root, [root, dependency]),
        root.fullName,
        entries,
      ),
    ).toThrow("duplicates package");

    const unrelated = pkg(CORE_TAP, "redis");
    expect(() =>
      projectHomebrewVfsFormulaLayer(
        plan(root, [dependency, unrelated]),
        root.fullName,
        entries,
      ),
    ).toThrow("outside its root dependency closure");
  });

  it("binds both fixed files and the manifest package identity", () => {
    const root = pkg(EXTERNAL_TAP, "blog-vfs");
    const entries = bottleEntries(root);
    expect(() =>
      projectHomebrewVfsFormulaLayer(
        plan(root),
        root.fullName,
        entries.slice(1),
      ),
    ).toThrow("is missing");
    expect(() =>
      projectHomebrewVfsFormulaLayer(
        plan(root),
        root.fullName,
        entries.filter(
          (entry) =>
            !entry.path.endsWith(HOMEBREW_VFS_FORMULA_PAYLOAD_RELATIVE_PATH),
        ),
      ),
    ).toThrow("payload root must be a directory");
    expect(() =>
      projectHomebrewVfsFormulaLayer(
        plan(root),
        root.fullName,
        bottleEntries(root, undefined, manifest(`${CORE_TAP}/other-vfs`)),
      ),
    ).toThrow(`expected ${root.fullName}`);
  });

  it("rejects incomplete directory ownership and unsafe links", () => {
    const root = pkg(EXTERNAL_TAP, "blog-vfs");
    const withoutEtc = bottleEntries(root).filter(
      (entry) => !entry.path.endsWith("/rootfs/etc"),
    );
    expect(() =>
      projectHomebrewVfsFormulaLayer(plan(root), root.fullName, withoutEtc),
    ).toThrow("payload omits directory /etc");

    const unsafeLink: TarEntry[] = [
      { path: "usr", type: "directory", mode: 0o755 },
      { path: "usr/bin", type: "directory", mode: 0o755 },
      {
        path: "usr/bin/tool",
        type: "symlink",
        mode: 0o777,
        linkName: "../../../outside",
      },
    ];
    expect(() =>
      projectHomebrewVfsFormulaLayer(
        plan(root),
        root.fullName,
        bottleEntries(root, unsafeLink, manifest(root.fullName, ["/usr/bin"])),
      ),
    ).toThrow("escapes /");
  });

  it("resolves payload hard links to one in-payload regular target", () => {
    const root = pkg(EXTERNAL_TAP, "blog-vfs");
    const payloadSource = `${root.payloadRoot}/${HOMEBREW_VFS_FORMULA_PAYLOAD_RELATIVE_PATH}`;
    const payload: TarEntry[] = [
      { path: "usr", type: "directory", mode: 0o755 },
      { path: "usr/share", type: "directory", mode: 0o755 },
      {
        path: "usr/share/data",
        type: "file",
        mode: 0o644,
        data: new Uint8Array([1, 2, 3]),
      },
      {
        path: "usr/share/data-alias",
        type: "hardlink",
        mode: 0o644,
        linkName: `${payloadSource}/usr/share/data`,
      },
    ];
    const projected = projectHomebrewVfsFormulaLayer(
      plan(root),
      root.fullName,
      bottleEntries(root, payload, manifest(root.fullName, ["/usr/share"])),
    );

    expect(
      projected.entries.find((entry) => entry.path.endsWith("data-alias")),
    ).toMatchObject({
      type: "hardlink",
      target: "/usr/share/data",
      size: 3,
    });

    (payload[3] as Extract<TarEntry, { type: "hardlink" }>).linkName =
      "another-package/1.0/data";
    expect(() =>
      projectHomebrewVfsFormulaLayer(
        plan(root),
        root.fullName,
        bottleEntries(root, payload, manifest(root.fullName, ["/usr/share"])),
      ),
    ).toThrow("targets outside its payload");
  });

  it("requires first-use roots to cover every non-directory payload entry", () => {
    const root = pkg(EXTERNAL_TAP, "blog-vfs");
    const payload: TarEntry[] = [
      { path: "etc", type: "directory", mode: 0o755 },
      {
        path: "etc/config",
        type: "file",
        mode: 0o644,
        data: new Uint8Array([1]),
      },
      { path: "var", type: "directory", mode: 0o755 },
      {
        path: "var/data",
        type: "file",
        mode: 0o644,
        data: new Uint8Array([2]),
      },
    ];
    expect(() =>
      projectHomebrewVfsFormulaLayer(
        plan(root),
        root.fullName,
        bottleEntries(root, payload, manifest(root.fullName, ["/etc"])),
      ),
    ).toThrow("/var/data has no activation root");
  });
});

describe("Homebrew VFS Formula layer composition preflight", () => {
  it("composes independent layers deterministically in either selection order", () => {
    const dinit = pkg(CORE_TAP, "dinit");
    const blog = projection(
      EXTERNAL_TAP,
      "blog-vfs",
      [
        { path: "etc", type: "directory", mode: 0o755 },
        { path: "etc/blog", type: "directory", mode: 0o755 },
        {
          path: "etc/blog/config",
          type: "file",
          mode: 0o644,
          data: new Uint8Array([1]),
        },
      ],
      [dinit],
    );
    const metrics = projection(CORE_TAP, "metrics-vfs", [
      { path: "var", type: "directory", mode: 0o755 },
      { path: "var/lib", type: "directory", mode: 0o755 },
      {
        path: "var/lib/metrics",
        type: "file",
        mode: 0o600,
        data: new Uint8Array([2]),
      },
    ]);

    const forward = preflightHomebrewVfsFormulaLayers([blog, metrics]);
    const reverse = preflightHomebrewVfsFormulaLayers([metrics, blog]);

    expect(reverse).toEqual(forward);
    expect(forward.layers.map((layer) => layer.rootPackage.fullName)).toEqual([
      `${EXTERNAL_TAP}/blog-vfs`,
      `${CORE_TAP}/metrics-vfs`,
    ]);
    expect(forward.packageOrder).toEqual([
      `${CORE_TAP}/dinit`,
      `${EXTERNAL_TAP}/blog-vfs`,
      `${CORE_TAP}/metrics-vfs`,
    ]);
  });

  it("rejects target conflicts before changing either projection", () => {
    const first = projection(CORE_TAP, "first-vfs", [
      { path: "etc", type: "directory", mode: 0o755 },
      {
        path: "etc/shared.conf",
        type: "file",
        mode: 0o644,
        data: new Uint8Array([1]),
      },
    ]);
    const second = projection(EXTERNAL_TAP, "second-vfs", [
      { path: "etc", type: "directory", mode: 0o755 },
      {
        path: "etc/shared.conf",
        type: "file",
        mode: 0o644,
        data: new Uint8Array([2]),
      },
    ]);
    const before = structuredClone([first.entries, second.entries]);

    expect(() => preflightHomebrewVfsFormulaLayers([second, first])).toThrow(
      `layers ${EXTERNAL_TAP}/second-vfs and ${CORE_TAP}/first-vfs conflict ` +
        "at /etc/shared.conf",
    );
    expect([first.entries, second.entries]).toEqual(before);
  });

  it("merges equal directories and identical dependencies but rejects conflicts", () => {
    const first = projection(CORE_TAP, "first-vfs", [
      { path: "etc", type: "directory", mode: 0o755 },
      {
        path: "etc/first",
        type: "file",
        mode: 0o644,
        data: new Uint8Array([1]),
      },
    ]);
    const second = projection(EXTERNAL_TAP, "second-vfs", [
      { path: "etc", type: "directory", mode: 0o755 },
      {
        path: "etc/second",
        type: "file",
        mode: 0o644,
        data: new Uint8Array([2]),
      },
    ]);
    expect(
      preflightHomebrewVfsFormulaLayers([first, second]).entries,
    ).toHaveLength(3);

    second.entries[0]!.mode = 0o700;
    expect(() => preflightHomebrewVfsFormulaLayers([first, second])).toThrow(
      "conflict at /etc",
    );

    const shared = pkg(CORE_TAP, "shared");
    const withSharedA = projection(
      CORE_TAP,
      "a-vfs",
      [{ path: "a", type: "file", mode: 0o644, data: new Uint8Array([1]) }],
      [shared],
    );
    const withSharedB = projection(
      EXTERNAL_TAP,
      "b-vfs",
      [{ path: "b", type: "file", mode: 0o644, data: new Uint8Array([2]) }],
      [shared],
    );
    expect(
      preflightHomebrewVfsFormulaLayers([withSharedB, withSharedA])
        .packageOrder,
    ).toEqual([shared.fullName, `${EXTERNAL_TAP}/b-vfs`, `${CORE_TAP}/a-vfs`]);

    const incompatibleShared = structuredClone(shared);
    incompatibleShared.sha256 = "5".repeat(64);
    incompatibleShared.linkManifest.bottle.sha256 = incompatibleShared.sha256;
    const withIncompatibleShared = projection(
      EXTERNAL_TAP,
      "c-vfs",
      [{ path: "c", type: "file", mode: 0o644, data: new Uint8Array([3]) }],
      [incompatibleShared],
    );
    expect(() =>
      preflightHomebrewVfsFormulaLayers([withSharedA, withIncompatibleShared]),
    ).toThrow(`${shared.fullName} to different immutable package identities`);
  });
});
