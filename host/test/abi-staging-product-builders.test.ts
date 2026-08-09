import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
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
    expect(result.stderr).toMatch(/exact target ABI candidate namespace/);
    expect(existsSync(fixture.outputPath)).toBe(false);
    expect(existsSync(fixture.reportPath)).toBe(false);
  }, 30_000);
});

interface BuilderFixture {
  directory: string;
  manifestPath: string;
  inputsPath: string;
  reportPath: string;
  outputPath: string;
  inputIds: string[];
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

async function browserMainShellFixture(): Promise<BuilderFixture> {
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

  const inputs: Array<Record<string, any>> = [
    embeddedInput(
      "product-platform-rootfs",
      "product-image",
      basePath,
      directory,
      "embedded",
      `https://artifacts.example.test/homebrew-tap-core-abi-${TARGET_ABI.version}-candidates/products/platform-rootfs?sha256=${sha256(baseBytes)}`,
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
    const reference =
      `https://artifacts.example.test/homebrew-tap-core-abi-${TARGET_ABI.version}-candidates/${formula}?sha256=${bottle.archiveSha256}`;
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
          `https://artifacts.example.test/homebrew-tap-core-abi-${TARGET_ABI.version}-candidates/${formula}-metadata?sha256=${descriptorSha}`,
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
