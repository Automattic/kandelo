import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { ABI_VERSION } from "../host/src/generated/abi";
import {
  homebrewBottleSelectionSha256,
} from "../host/src/homebrew-bottle-selection";
import { MemoryFileSystem } from "../host/src/vfs/memory-fs";
import {
  ensureDirRecursive,
  writeVfsBinary,
  writeVfsFile,
} from "../host/src/vfs/image-helpers";
import {
  homebrewTestBootstrapFixture,
  homebrewTestBottleDescriptor,
  homebrewTestBottleEntry,
  homebrewTestBottleTar,
  homebrewTestReceipt,
  homebrewTestSelectionBytes,
} from "../host/test/fixtures/homebrew-flat-vfs";
import {
  parseHomebrewFlatVfsNodeSmokeArgs,
  runHomebrewFlatVfsNodeSmoke,
} from "./homebrew-flat-vfs-node-smoke";

const VFS_FILENAME =
  "kandelo-homebrew-experimental-abi42-wasm32.vfs.zst";

test("parses exactly the seven required Node smoke arguments", () => {
  const parsed = parseHomebrewFlatVfsNodeSmokeArgs([
    "--image", "image.vfs.zst",
    "--selection", "selection.json",
    "--report", "report.json",
    "--kernel", "kernel.wasm",
    "--tap-root", "tap",
    "--tap-revision", "1".repeat(40),
    "--evidence", "evidence.json",
  ]);
  assert.equal(parsed.tapRevision, "1".repeat(40));
  assert.match(parsed.image, /image\.vfs\.zst$/);
  assert.throws(
    () => parseHomebrewFlatVfsNodeSmokeArgs([
      "--image", "image.vfs.zst",
      "--selection", "selection.json",
    ]),
    /usage:/,
  );
  assert.throws(
    () => parseHomebrewFlatVfsNodeSmokeArgs([
      "--image", "image.vfs.zst",
      "--image", "other.vfs.zst",
    ]),
    /usage:/,
  );
  assert.throws(
    () => parseHomebrewFlatVfsNodeSmokeArgs([
      "--timeout", "1000",
    ]),
    /usage:/,
  );
});

test("binds exact inputs, forwards exact kernel bytes, and publishes private evidence", async () => {
  const fixture = await createFixture();
  try {
    let receivedKernel: ArrayBuffer | undefined;
    let receivedImage: Uint8Array | undefined;
    const evidence = await runHomebrewFlatVfsNodeSmoke(fixture.args, {
      runProof: async (options) => {
        receivedKernel = options.kernelWasmBytes;
        receivedImage = options.runtime.imageBytes;
        return {
          tapRevision: fixture.tapRevision,
          kandeloAbi: 42,
          selectionSha256: fixture.selectionSha256,
          lazyDownloads: [],
        };
      },
    });
    assert.deepEqual(
      new Uint8Array(receivedKernel!),
      fixture.kernelBytes,
    );
    assert.deepEqual(receivedImage, fixture.imageBytes);
    assert.deepEqual(JSON.parse(readFileSync(fixture.evidence, "utf8")), evidence);
    assert.equal(lstatSync(fixture.evidence).mode & 0o777, 0o600);
    assert.deepEqual(evidence, {
      schema: 1,
      kind: "kandelo-homebrew-flat-vfs-proof",
      host: "node",
      arch: "wasm32",
      kandelo_abi: 42,
      tap_revision: fixture.tapRevision,
      selection_sha256: fixture.selectionSha256,
      image: identity(fixture.imageBytes),
      report: identity(fixture.reportBytes),
      kernel: identity(fixture.kernelBytes),
      lazy_downloads: 0,
    });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("resolves the package-owned kernel mirror to its claimed generation member", async () => {
  const fixture = await createFixture();
  try {
    const kernelMirror = installKernelMirror(fixture);
    let receivedKernel: ArrayBuffer | undefined;
    await runHomebrewFlatVfsNodeSmoke(
      replaceArg(fixture.args, "--kernel", kernelMirror),
      {
        runProof: async (options) => {
          receivedKernel = options.kernelWasmBytes;
          return {
            tapRevision: fixture.tapRevision,
            kandeloAbi: 42,
            selectionSha256: fixture.selectionSha256,
            lazyDownloads: [],
          };
        },
      },
    );
    assert.deepEqual(new Uint8Array(receivedKernel!), fixture.kernelBytes);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("rejects kernel symlinks outside the claimed package generation", async () => {
  const fixture = await createFixture();
  try {
    const mirrorRoot = join(fixture.root, "local-binaries");
    mkdirSync(mirrorRoot);
    const kernelMirror = join(mirrorRoot, "kernel.wasm");
    symlinkSync(fixture.kernel, kernelMirror);
    await assert.rejects(
      () => runHomebrewFlatVfsNodeSmoke(
        replaceArg(fixture.args, "--kernel", kernelMirror),
        {
          runProof: async () => {
            throw new Error("must not run");
          },
        },
      ),
      /package-owned generation mirror is invalid/,
    );
    assert.equal(lstatOrNull(fixture.evidence), null);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("rejects an otherwise shaped kernel mirror without its publication claim", async () => {
  const fixture = await createFixture();
  try {
    const kernelMirror = installKernelMirror(fixture);
    const generation = dirname(realpathSync(kernelMirror));
    const session = basename(generation);
    unlinkSync(join(dirname(generation), `.${session}.publication-claimed`));
    await assert.rejects(
      () => runHomebrewFlatVfsNodeSmoke(
        replaceArg(fixture.args, "--kernel", kernelMirror),
        {
          runProof: async () => {
            throw new Error("must not run");
          },
        },
      ),
      /package-owned generation mirror is invalid/,
    );
    assert.equal(lstatOrNull(fixture.evidence), null);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("rejects report/image/selection mismatch before running the proof", async () => {
  const fixture = await createFixture();
  try {
    rewriteArtifactReport(fixture.report, (report) => {
      const image = report.image as Record<string, unknown>;
      image.sha256 = "f".repeat(64);
    });
    let ran = false;
    await assert.rejects(
      () => runHomebrewFlatVfsNodeSmoke(fixture.args, {
        runProof: async () => {
          ran = true;
          throw new Error("must not run");
        },
      }),
      /artifact report image SHA-256/,
    );
    assert.equal(ran, false);
    assert.equal(lstatOrNull(fixture.evidence), null);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("rejects outer report identities that do not bind its exact inputs", async () => {
  const cases: Array<{
    label: string;
    change: (report: Record<string, unknown>) => void;
    error: RegExp;
  }> = [
    {
      label: "selection size",
      change: (report) => {
        (report.selection as Record<string, unknown>).bytes = 1;
      },
      error: /artifact report selection bytes/,
    },
    {
      label: "base image binding",
      change: (report) => {
        (report.base_image as Record<string, unknown>).sha256 = "e".repeat(64);
      },
      error: /artifact report base image/,
    },
    {
      label: "shell config binding",
      change: (report) => {
        (report.shell_config as Record<string, unknown>).bytes = 1;
      },
      error: /artifact report shell config/,
    },
    {
      label: "embedded build report",
      change: (report) => {
        (report.build_report as Record<string, unknown>).selection_sha256 =
          "d".repeat(64);
      },
      error: /build report does not match the image-owned report/,
    },
  ];
  for (const testCase of cases) {
    const fixture = await createFixture();
    try {
      rewriteArtifactReport(fixture.report, testCase.change);
      let ran = false;
      await assert.rejects(
        () => runHomebrewFlatVfsNodeSmoke(fixture.args, {
          runProof: async () => {
            ran = true;
            throw new Error("must not run");
          },
        }),
        testCase.error,
        testCase.label,
      );
      assert.equal(ran, false, testCase.label);
      assert.equal(lstatOrNull(fixture.evidence), null, testCase.label);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test("rejects a tap checkout that is not the exact requested revision", async () => {
  const fixture = await createFixture();
  try {
    const args = replaceArg(
      fixture.args,
      "--tap-revision",
      "9".repeat(40),
    );
    await assert.rejects(
      () => runHomebrewFlatVfsNodeSmoke(args, {
        runProof: async () => {
          throw new Error("must not run");
        },
      }),
      /tap checkout revision/,
    );
    assert.equal(lstatOrNull(fixture.evidence), null);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("does not create or replace evidence when the real proof fails", async () => {
  const fixture = await createFixture();
  try {
    await assert.rejects(
      () => runHomebrewFlatVfsNodeSmoke(fixture.args, {
        runProof: async () => {
          throw new Error("stock Homebrew proof failed");
        },
      }),
      /stock Homebrew proof failed/,
    );
    assert.equal(lstatOrNull(fixture.evidence), null);

    writeFileSync(fixture.evidence, "existing\n", { mode: 0o600 });
    await assert.rejects(
      () => runHomebrewFlatVfsNodeSmoke(fixture.args, {
        runProof: async () => ({
          tapRevision: fixture.tapRevision,
          kandeloAbi: 42,
          selectionSha256: fixture.selectionSha256,
          lazyDownloads: [],
        }),
      }),
      /evidence already exists/,
    );
    assert.equal(readFileSync(fixture.evidence, "utf8"), "existing\n");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

async function createFixture(): Promise<{
  root: string;
  args: string[];
  tapRevision: string;
  selectionSha256: string;
  image: string;
  selection: string;
  report: string;
  kernel: string;
  evidence: string;
  imageBytes: Uint8Array;
  reportBytes: Uint8Array;
  kernelBytes: Uint8Array;
}> {
  const root = mkdtempSync(join(tmpdir(), "kandelo-flat-vfs-smoke-test-"));
  chmodSync(root, 0o700);
  const tapRoot = join(root, "tap");
  execFileSync("git", ["init", "--quiet", tapRoot]);
  execFileSync("git", ["-C", tapRoot, "config", "user.name", "Kandelo Test"]);
  execFileSync("git", ["-C", tapRoot, "config", "user.email", "test@kandelo.invalid"]);
  writeFileSync(join(tapRoot, "README"), "exact tap\n");
  execFileSync("git", ["-C", tapRoot, "add", "README"]);
  execFileSync("git", ["-C", tapRoot, "commit", "--quiet", "-m", "exact tap"]);
  const tapRevision = execFileSync(
    "git",
    ["-C", tapRoot, "rev-parse", "HEAD"],
    { encoding: "utf8" },
  ).trim();

  const bootstrap = homebrewTestBootstrapFixture();
  const bzip2Bottle = homebrewTestBottleTar([
    homebrewTestBottleEntry(
      "bzip2",
      "1.0.8",
      ".brew/bzip2.rb",
      "class Bzip2 < Formula\nend\n",
    ),
    homebrewTestBottleEntry(
      "bzip2",
      "1.0.8",
      "INSTALL_RECEIPT.json",
      homebrewTestReceipt([]),
    ),
  ]);
  const extractionDescriptors = [
    { name: "gzip", version: "1.14" },
    { name: "tar", version: "1.35" },
  ].map(({ name, version }) => {
    const bottle = homebrewTestBottleTar([
      homebrewTestBottleEntry(
        name,
        version,
        `.brew/${name}.rb`,
        `class ${name[0]!.toUpperCase()}${name.slice(1)} < Formula\nend\n`,
      ),
      homebrewTestBottleEntry(
        name,
        version,
        "INSTALL_RECEIPT.json",
        homebrewTestReceipt([]),
      ),
      homebrewTestBottleEntry(
        name,
        version,
        `bin/${name}`,
        `selected Homebrew ${name}\n`,
        0o755,
      ),
    ]);
    return homebrewTestBottleDescriptor({
      name,
      version,
      bottle,
      links: [{
        source: `Cellar/${name}/${version}/bin/${name}`,
        target: `bin/${name}`,
        type: "symlink",
      }],
      pathPrepend: ["bin"],
    });
  });
  const selectionBytes = homebrewTestSelectionBytes([
    bootstrap.descriptor,
    ...extractionDescriptors,
    homebrewTestBottleDescriptor({
      name: "bzip2",
      version: "1.0.8",
      bottle: bzip2Bottle,
    }),
  ]);
  const selectionSha256 = homebrewBottleSelectionSha256(selectionBytes);
  const parsedSelection = JSON.parse(new TextDecoder().decode(selectionBytes)) as {
    name: string;
    bottles: Array<{
      fullName: string;
      sha256: string;
      bytes: number;
      arch: string;
      kandeloAbi: number;
    }>;
  };
  const buildReport = {
    schema: 1,
    name: "experimental-abi42-flat-builder",
    arch: "wasm32",
    kandelo_abi: ABI_VERSION,
    selection_sha256: selectionSha256,
    requested_vfs_filename: VFS_FILENAME,
    resource_policy: "kandelo-homebrew-vfs-generous-v1",
    link_policy: "kandelo-homebrew-link-ownership-v1",
    runtime_support: "kandelo-homebrew-bootstrap-v1",
    environment: { PATH: "/opt/kandelo/homebrew/bin" },
    link_owners: [],
    totals: {
      compressed_bytes: 1,
      expanded_bytes: 1,
      entries: 1,
      path_bytes: 1,
      link_bytes: 0,
    },
    packages: parsedSelection.bottles.map((bottle) => ({
      full_name: bottle.fullName,
      sha256: bottle.sha256,
      bytes: bottle.bytes,
      arch: bottle.arch,
      kandelo_abi: bottle.kandeloAbi,
    })),
  };
  const embeddedReportBytes = prettyJsonBytes(buildReport);
  const shellConfigBytes = new TextEncoder().encode(
    '{\n  "version": 1,\n  "path": "/bin/bash",\n' +
      '  "argv": ["bash", "-l", "-i"]\n}\n',
  );
  const baseImage = {
    sha256: "b".repeat(64),
    bytes: 1234,
    kernelAbi: ABI_VERSION,
  };
  const imageBytes = await createImage({
    embeddedReportBytes,
    shellConfigBytes,
    selectionSha256,
    baseImage,
  });
  const capacity = MemoryFileSystem.readImageCapacity(imageBytes);
  const reportBytes = prettyJsonBytes({
    schema: 1,
    selection: {
      sha256: selectionSha256,
      bytes: selectionBytes.byteLength,
      name: parsedSelection.name,
    },
    base_image: {
      sha256: baseImage.sha256,
      bytes: baseImage.bytes,
      kernel_abi: baseImage.kernelAbi,
    },
    shell_config: {
      path: "/bin/bash",
      argv: ["bash", "-l", "-i"],
      sha256: createHash("sha256").update(shellConfigBytes).digest("hex"),
      bytes: shellConfigBytes.byteLength,
    },
    bottle_cache: {
      entries: parsedSelection.bottles.map((bottle) => ({
        full_name: bottle.fullName,
        sha256: bottle.sha256,
        bytes: bottle.bytes,
      })),
    },
    image: {
      filename: VFS_FILENAME,
      sha256: createHash("sha256").update(imageBytes).digest("hex"),
      bytes: imageBytes.byteLength,
      capacity: {
        byte_length: capacity.byteLength,
        max_byte_length: capacity.maxByteLength,
      },
    },
    build_report: buildReport,
  });
  const kernelBytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  const image = join(root, VFS_FILENAME);
  const selection = join(root, "homebrew-selection.json");
  const report = join(root, "homebrew-vfs-build-report.json");
  const kernel = join(root, "kernel.wasm");
  const evidence = join(root, "evidence.json");
  writeFileSync(image, imageBytes, { mode: 0o600 });
  writeFileSync(selection, selectionBytes, { mode: 0o600 });
  writeFileSync(report, reportBytes, { mode: 0o600 });
  writeFileSync(kernel, kernelBytes, { mode: 0o600 });
  return {
    root,
    args: [
      "--image", image,
      "--selection", selection,
      "--report", report,
      "--kernel", kernel,
      "--tap-root", tapRoot,
      "--tap-revision", tapRevision,
      "--evidence", evidence,
    ],
    tapRevision,
    selectionSha256,
    image,
    selection,
    report,
    kernel,
    evidence,
    imageBytes,
    reportBytes,
    kernelBytes,
  };
}

async function createImage(options: {
  embeddedReportBytes: Uint8Array;
  shellConfigBytes: Uint8Array;
  selectionSha256: string;
  baseImage: { sha256: string; bytes: number; kernelAbi: number };
}): Promise<Uint8Array> {
  const fs = MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));
  for (const path of [
    "/bin",
    "/etc/kandelo",
    "/etc/homebrew",
    "/opt/kandelo/homebrew/bin",
    "/usr/bin",
  ]) {
    ensureDirRecursive(fs, path);
  }
  writeVfsBinary(fs, "/etc/kandelo/shell.json", options.shellConfigBytes, 0o644);
  writeVfsFile(fs, "/bin/bash", new Uint8Array([0, 97, 115, 109]), 0o755);
  writeVfsFile(
    fs,
    "/opt/kandelo/homebrew/bin/brew",
    "#!/bin/bash\n",
    0o755,
  );
  fs.symlink("/opt/kandelo/homebrew/bin/brew", "/usr/bin/brew");
  for (const command of ["tar", "gzip"]) {
    writeVfsFile(
      fs,
      `/opt/kandelo/homebrew/bin/${command}`,
      `selected Homebrew ${command}\n`,
      0o755,
    );
    fs.symlink(
      `/opt/kandelo/homebrew/bin/${command}`,
      `/usr/bin/${command}`,
    );
  }
  writeVfsFile(fs, "/etc/homebrew/brew.env", "HOMEBREW_NO_ANALYTICS=1\n", 0o644);
  writeVfsBinary(
    fs,
    "/etc/kandelo/homebrew-vfs.json",
    options.embeddedReportBytes,
    0o644,
  );
  return fs.saveImage({
    metadata: {
      version: 1,
      kernelAbi: ABI_VERSION,
      createdBy: "images/vfs/scripts/build-homebrew-flat-vfs-image.ts",
      capacity: { maxByteLength: 4 * 1024 * 1024 },
      baseImage: options.baseImage,
      shellConfig: {
        path: "/bin/bash",
        argv: ["bash", "-l", "-i"],
        sha256: createHash("sha256")
          .update(options.shellConfigBytes)
          .digest("hex"),
        bytes: options.shellConfigBytes.byteLength,
      },
      homebrewFlat: {
        selectionSha256: options.selectionSha256,
        requestedVfsFilename: VFS_FILENAME,
        resourcePolicy: "kandelo-homebrew-vfs-generous-v1",
      },
    },
  });
}

function prettyJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

function rewriteArtifactReport(
  path: string,
  change: (report: Record<string, unknown>) => void,
): void {
  const report = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  change(report);
  writeFileSync(path, prettyJsonBytes(report), { mode: 0o600 });
}

function identity(bytes: Uint8Array): { sha256: string; bytes: number } {
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength,
  };
}

function installKernelMirror(fixture: {
  root: string;
  kernelBytes: Uint8Array;
}): string {
  const session = "test-session";
  const identityRoot = join(
    fixture.root,
    "local-binaries/.kandelo-local-generations/wasm32/kernel",
    "a".repeat(64),
  );
  const generation = join(identityRoot, session);
  mkdirSync(generation, { recursive: true, mode: 0o700 });
  const member = join(generation, "kandelo-kernel.wasm");
  writeFileSync(member, fixture.kernelBytes, { mode: 0o600 });
  writeFileSync(
    join(identityRoot, `.${session}.publication-claimed`),
    "claimed\n",
    { mode: 0o600 },
  );
  const mirror = join(fixture.root, "local-binaries/kernel.wasm");
  symlinkSync(member, mirror);
  return mirror;
}

function replaceArg(args: readonly string[], flag: string, value: string): string[] {
  const copy = [...args];
  copy[copy.indexOf(flag) + 1] = value;
  return copy;
}

function lstatOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
