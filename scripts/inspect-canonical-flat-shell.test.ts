import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { encodeHomebrewBottleSelection } from "../host/src/homebrew-bottle-selection";
import {
  ensureDirRecursive,
  writeVfsBinary,
} from "../host/src/vfs/image-helpers";
import {
  MemoryFileSystem,
  type VfsImageMetadata,
} from "../host/src/vfs/memory-fs";
import { homebrewTestBootstrapFixture } from "../host/test/fixtures/homebrew-flat-vfs";
import { ABI_VERSION } from "../host/src/generated/abi.ts";
import {
  inspectCanonicalFlatShell,
  inspectCanonicalFlatShellFiles,
} from "./inspect-canonical-flat-shell";

const MiB = 1024 * 1024;
const IMAGE_MAX_BYTES = 512 * MiB;
const SHELL_CONFIG_TEXT = `${JSON.stringify(
  {
    version: 1,
    path: "/opt/kandelo/homebrew/bin/bash",
    argv: ["bash", "-l", "-i"],
  },
  null,
  2,
)}\n`;
const DEMO_CONFIG_TEXT = `${JSON.stringify(
  {
    version: 1,
    profiles: {
      shell: {
        presentation: {
          bootPrimary: "syslog",
          runningPrimary: ["terminal", "syslog"],
          terminalAccess: "primary",
          internalsAccess: "drawer",
        },
      },
    },
  },
  null,
  2,
)}\n`;

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("accepts one exact self-contained canonical flat shell", async () => {
  const fixture = await createFixture();

  const report = await inspectCanonicalFlatShell({
    imageBytes: fixture.imageBytes,
    selectionBytes: fixture.selectionBytes,
    shellConfigBytes: fixture.shellConfigBytes,
    demoConfigBytes: fixture.demoConfigBytes,
  });

  assert.deepEqual(report, {
    schema: 1,
    kind: "kandelo-canonical-flat-shell",
    image: {
      sha256: sha256(fixture.imageBytes),
      bytes: fixture.imageBytes.byteLength,
      kernel_abi: ABI_VERSION,
      capacity: {
        byte_length: MemoryFileSystem.readImageCapacity(fixture.imageBytes)
          .byteLength,
        max_byte_length: IMAGE_MAX_BYTES,
      },
    },
    selection: {
      sha256: sha256(fixture.selectionBytes),
      bytes: fixture.selectionBytes.byteLength,
      name: `main-shell-abi${ABI_VERSION}-wasm32`,
      arch: "wasm32",
      kandelo_abi: ABI_VERSION,
      requested_vfs_filename: "shell.vfs.zst",
      resource_policy: "kandelo-homebrew-vfs-main-shell-v1",
    },
    shell_config: {
      sha256: sha256(fixture.shellConfigBytes),
      bytes: fixture.shellConfigBytes.byteLength,
      path: "/opt/kandelo/homebrew/bin/bash",
      argv: ["bash", "-l", "-i"],
    },
    demo_config: {
      sha256: sha256(fixture.demoConfigBytes),
      bytes: fixture.demoConfigBytes.byteLength,
      path: "/etc/kandelo/demo.json",
    },
    transport: {
      kind: "flat-self-contained",
      mirror_required: false,
    },
  });
});

const bindingMutations: Array<{
  name: string;
  mutate(metadata: VfsImageMetadata): void;
}> = [
  {
    name: "kernel ABI",
    mutate: (metadata) => {
      metadata.kernelAbi = ABI_VERSION - 1;
    },
  },
  {
    name: "declared capacity",
    mutate: (metadata) => {
      metadata.capacity!.maxByteLength = 256 * MiB;
    },
  },
  {
    name: "selection digest",
    mutate: (metadata) => {
      metadata.homebrewFlat!.selectionSha256 = "0".repeat(64);
    },
  },
  {
    name: "requested image filename",
    mutate: (metadata) => {
      metadata.homebrewFlat!.requestedVfsFilename = "other.vfs.zst";
    },
  },
  {
    name: "resource policy",
    mutate: (metadata) => {
      metadata.homebrewFlat!.resourcePolicy =
        "kandelo-homebrew-vfs-generous-v1";
    },
  },
  {
    name: "shell path",
    mutate: (metadata) => {
      metadata.shellConfig!.path = "/bin/bash";
    },
  },
  {
    name: "shell argv",
    mutate: (metadata) => {
      metadata.shellConfig!.argv = ["bash"];
    },
  },
  {
    name: "shell digest",
    mutate: (metadata) => {
      metadata.shellConfig!.sha256 = "1".repeat(64);
    },
  },
  {
    name: "shell byte count",
    mutate: (metadata) => {
      metadata.shellConfig!.bytes += 1;
    },
  },
  {
    name: "demo path",
    mutate: (metadata) => {
      metadata.demoConfig!.path = "/demo.json";
    },
  },
  {
    name: "demo digest",
    mutate: (metadata) => {
      metadata.demoConfig!.sha256 = "2".repeat(64);
    },
  },
  {
    name: "demo byte count",
    mutate: (metadata) => {
      metadata.demoConfig!.bytes += 1;
    },
  },
];

for (const binding of bindingMutations) {
  test(`rejects a mutated ${binding.name} binding`, async () => {
    const fixture = await createFixture({ mutateMetadata: binding.mutate });
    await assert.rejects(
      () => inspectFixture(fixture),
      /canonical flat shell/i,
    );
  });
}

test("rejects a flat image with pending lazy file state", async () => {
  const fixture = await createFixture({ lazyFile: true });
  await assert.rejects(() => inspectFixture(fixture), /self-contained|lazy/i);
});

test("rejects a canonical shell without its public Bash entrypoints", async () => {
  const fixture = await createFixture({
    mutateFileSystem(fs) {
      fs.unlink("/bin/bash");
    },
  });
  await assert.rejects(
    () => inspectFixture(fixture),
    /public Bash entrypoint.*\/bin\/bash/i,
  );
});

test("rejects a canonical shell with a crossed public command alias", async () => {
  const fixture = await createFixture({
    mutateFileSystem(fs) {
      fs.unlink("/usr/bin/env");
      fs.symlink("/opt/kandelo/homebrew/bin/dash", "/usr/bin/env");
    },
  });
  await assert.rejects(
    () => inspectFixture(fixture),
    /public env entrypoint.*\/usr\/bin\/env/i,
  );
});

test("rejects a valid but different canonical selection", async () => {
  const fixture = await createFixture();
  const crossed = canonicalSelectionBytes("crossed\n");
  await assert.rejects(
    () =>
      inspectCanonicalFlatShell({
        imageBytes: fixture.imageBytes,
        selectionBytes: crossed,
        shellConfigBytes: fixture.shellConfigBytes,
        demoConfigBytes: fixture.demoConfigBytes,
      }),
    /selection/i,
  );
});

test("rejects symlinked inputs and refuses to clobber a report", async () => {
  const fixture = await createFixture();
  const root = temporaryDirectory("canonical-flat-shell-files-");
  const paths = {
    image: join(root, "shell.vfs.zst"),
    selection: join(root, "selection.json"),
    shellConfig: join(root, "shell.json"),
    demoConfig: join(root, "demo.json"),
    output: join(root, "report.json"),
  };
  writeFileSync(paths.image, fixture.imageBytes);
  writeFileSync(paths.selection, fixture.selectionBytes);
  writeFileSync(paths.shellConfig, fixture.shellConfigBytes);
  writeFileSync(paths.demoConfig, fixture.demoConfigBytes);

  const selectionLink = join(root, "selection-link.json");
  symlinkSync(paths.selection, selectionLink);
  await assert.rejects(
    () =>
      inspectCanonicalFlatShellFiles({
        ...paths,
        selection: selectionLink,
      }),
    /selection.*regular non-symlink/i,
  );

  await inspectCanonicalFlatShellFiles(paths);
  const original = readFileSync(paths.output);
  await assert.rejects(
    () => inspectCanonicalFlatShellFiles(paths),
    /exist|clobber|EEXIST/i,
  );
  assert.deepEqual(readFileSync(paths.output), original);
});

async function inspectFixture(
  fixture: Awaited<ReturnType<typeof createFixture>>,
) {
  return inspectCanonicalFlatShell({
    imageBytes: fixture.imageBytes,
    selectionBytes: fixture.selectionBytes,
    shellConfigBytes: fixture.shellConfigBytes,
    demoConfigBytes: fixture.demoConfigBytes,
  });
}

async function createFixture(
  options: {
    mutateMetadata?: (metadata: VfsImageMetadata) => void;
    mutateFileSystem?: (fs: MemoryFileSystem) => void;
    lazyFile?: boolean;
  } = {},
) {
  const selectionBytes = canonicalSelectionBytes("canonical\n");
  const shellConfigBytes = new TextEncoder().encode(SHELL_CONFIG_TEXT);
  const demoConfigBytes = new TextEncoder().encode(DEMO_CONFIG_TEXT);
  const fs = MemoryFileSystem.create(
    new SharedArrayBuffer(4 * MiB, { maxByteLength: IMAGE_MAX_BYTES }),
    IMAGE_MAX_BYTES,
  );
  for (const path of [
    "/bin",
    "/etc/kandelo",
    "/opt/kandelo/homebrew/bin",
    "/usr/bin",
  ]) {
    ensureDirRecursive(fs, path);
  }
  writeVfsBinary(fs, "/etc/kandelo/shell.json", shellConfigBytes, 0o644);
  writeVfsBinary(fs, "/etc/kandelo/demo.json", demoConfigBytes, 0o644);
  writeVfsBinary(
    fs,
    "/opt/kandelo/homebrew/bin/bash",
    new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
    0o755,
  );
  for (const command of ["dash", "env"]) {
    writeVfsBinary(
      fs,
      `/opt/kandelo/homebrew/bin/${command}`,
      new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
      0o755,
    );
  }
  writeVfsBinary(
    fs,
    "/opt/kandelo/homebrew/bin/brew",
    new TextEncoder().encode("#!/bin/sh\necho Homebrew\n"),
    0o755,
  );
  fs.symlink("/opt/kandelo/homebrew/bin/brew", "/usr/bin/brew");
  for (const publicPath of ["/bin/bash", "/usr/bin/bash"]) {
    fs.symlink("/opt/kandelo/homebrew/bin/bash", publicPath);
  }
  for (const publicPath of ["/bin/sh", "/usr/bin/sh"]) {
    fs.symlink("/opt/kandelo/homebrew/bin/dash", publicPath);
  }
  for (const publicPath of ["/bin/env", "/usr/bin/env"]) {
    fs.symlink("/opt/kandelo/homebrew/bin/env", publicPath);
  }
  options.mutateFileSystem?.(fs);
  if (options.lazyFile) {
    fs.registerLazyFile(
      "/opt/kandelo/homebrew/bin/lazy",
      "https://invalid.example/lazy",
      1,
      0o755,
    );
  }

  const metadata: VfsImageMetadata = {
    version: 1,
    kernelAbi: ABI_VERSION,
    createdBy: "images/vfs/scripts/build-homebrew-flat-vfs-image.ts",
    capacity: { maxByteLength: IMAGE_MAX_BYTES },
    baseImage: {
      sha256: "b".repeat(64),
      bytes: 1234,
      kernelAbi: ABI_VERSION,
    },
    homebrewFlat: {
      selectionSha256: sha256(selectionBytes),
      requestedVfsFilename: "shell.vfs.zst",
      resourcePolicy: "kandelo-homebrew-vfs-main-shell-v1",
    },
    shellConfig: {
      path: "/opt/kandelo/homebrew/bin/bash",
      argv: ["bash", "-l", "-i"],
      sha256: sha256(shellConfigBytes),
      bytes: shellConfigBytes.byteLength,
    },
    demoConfig: {
      path: "/etc/kandelo/demo.json",
      sha256: sha256(demoConfigBytes),
      bytes: demoConfigBytes.byteLength,
    },
  };
  options.mutateMetadata?.(metadata);
  const imageBytes = await fs.saveImage({ metadata });
  return { imageBytes, selectionBytes, shellConfigBytes, demoConfigBytes };
}

function canonicalSelectionBytes(environmentText: string): Uint8Array {
  const bootstrap = homebrewTestBootstrapFixture({
    environment: new TextEncoder().encode(environmentText),
  });
  return encodeHomebrewBottleSelection({
    schema: 1,
    name: `main-shell-abi${ABI_VERSION}-wasm32`,
    arch: "wasm32",
    kandeloAbi: ABI_VERSION,
    bottles: [bootstrap.descriptor],
    requestedVfsFilename: "shell.vfs.zst",
    resourcePolicy: "kandelo-homebrew-vfs-main-shell-v1",
    linkPolicy: "kandelo-homebrew-link-ownership-v1",
    runtimeSupport: "kandelo-homebrew-bootstrap-v1",
  });
}

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
