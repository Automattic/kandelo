import { describe, expect, it, vi } from "vitest";
import {
  DEMO_AUTOLOGIN_MOTD,
  DEMO_LOGIN_PASSWORD_HASH,
  DEMO_SUDOERS,
} from "../../../images/vfs/lib/demo-login";
import { ensureDirRecursive } from "../../../host/src/vfs/image-helpers";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  createReviewedPrivilegedProgramPolicy,
  publishPrivilegedProgramProduct,
  type PrivilegedProgramSource,
} from "../../../host/src/vfs/privileged-projection";
import { stageConfiguredAssets } from "../pages/kandelo/kernel-host/configured-assets";
import { initializeDemoLoginKernel } from "../pages/kandelo/kernel-host/demo-login-loader";

const encoder = new TextEncoder();

function write(
  fs: MemoryFileSystem,
  path: string,
  text: string,
  mode: number,
): void {
  fs.createFileWithOwner(path, mode, 0, 0, encoder.encode(text));
}

function canonicalFs(loginBytes: Uint8Array): MemoryFileSystem {
  const fs = MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));
  for (const path of ["/etc", "/usr", "/usr/bin"]) ensureDirRecursive(fs, path);
  write(
    fs,
    "/etc/passwd",
    "maker:x:1000:1000:maker:/home/maker:/bin/sh\n",
    0o644,
  );
  write(
    fs,
    "/etc/shadow",
    `maker:${DEMO_LOGIN_PASSWORD_HASH}:0:0:99999:7:::\n`,
    0o640,
  );
  write(fs, "/etc/group", "wheel:x:10:maker\n", 0o644);
  write(fs, "/etc/sudoers", DEMO_SUDOERS, 0o440);
  write(fs, "/etc/motd.autologin", DEMO_AUTOLOGIN_MOTD, 0o644);
  fs.createFileWithOwner("/usr/bin/login", 0o4755, 0, 0, loginBytes);
  return fs;
}

async function productFixture(loginBytes: Uint8Array) {
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", loginBytes)),
  ).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const sourceFs = MemoryFileSystem.create(
    new SharedArrayBuffer(4 * 1024 * 1024),
  );
  const destinations = [
    ["login", "/usr/bin/login"],
    ["sudo-lite", "/usr/bin/sudo-lite"],
    ["sudo", "/usr/bin/sudo"],
  ] as const;
  for (const [sourcePath] of destinations) {
    sourceFs.createFileWithOwner(
      `/${sourcePath}`,
      0o755,
      1000,
      1000,
      loginBytes,
    );
  }
  const bottleSha256 = "a".repeat(64);
  const policy = createReviewedPrivilegedProgramPolicy(
    destinations.map(([sourcePath, destinationPath]) => ({
      schema: 1,
      formula: `test/${sourcePath}`,
      bottleSha256,
      sourcePath,
      destinationPath,
      uid: 0,
      gid: 0,
      mode: 0o4755,
      mountPoint: "trusted-root-product",
      artifactValidationSha256: digest,
    })),
  );
  const sources: PrivilegedProgramSource[] = destinations.map(
    ([sourcePath]) => ({
      formula: `test/${sourcePath}`,
      bottleSha256,
      fs: sourceFs,
      inventory: {
        entries: [{
          sourcePath,
          type: "file",
          size: loginBytes.byteLength,
        }],
      },
      guestPathForSource: (path) => `/${path}`,
    }),
  );
  const publish = () => publishPrivilegedProgramProduct({
    policy,
    sources,
    writableBottleFileSystems: [sourceFs],
  });
  return { policy, publish, sourceFs };
}

function fakeKernel() {
  return {
    initFromImage: vi.fn(async () => {}),
    initFromPublishedPrivilegedProgramProduct: vi.fn(async () => {}),
  };
}

describe("production demo login loader", () => {
  it(
    "keeps a third-party image ordinary alone and admits its exact bytes " +
      "with a separate reviewed product",
    async () => {
      const loginBytes = new Uint8Array([0, 97, 115, 109, 1]);
      const fs = canonicalFs(loginBytes);
      const image = await fs.saveImage();
      const rawKernel = fakeKernel();

      await expect(initializeDemoLoginKernel({
        kernel: rawKernel,
        fs,
        kernelWasm: new ArrayBuffer(0),
        vfsImage: image,
      })).resolves.toBe(false);
      expect(rawKernel.initFromImage).toHaveBeenCalledOnce();
      expect(rawKernel.initFromPublishedPrivilegedProgramProduct)
        .not.toHaveBeenCalled();

      const { publish } = await productFixture(loginBytes);
      const privilegedProduct = await publish();
      const reviewedKernel = fakeKernel();
      await expect(initializeDemoLoginKernel({
        kernel: reviewedKernel,
        fs,
        kernelWasm: new ArrayBuffer(0),
        vfsImage: image,
        privilegedProduct,
      })).resolves.toBe(true);
      expect(reviewedKernel.initFromImage).not.toHaveBeenCalled();
      expect(
        reviewedKernel.initFromPublishedPrivilegedProgramProduct,
      ).toHaveBeenCalledOnce();

      const forgedKernel = fakeKernel();
      await expect(initializeDemoLoginKernel({
        kernel: forgedKernel,
        fs,
        kernelWasm: new ArrayBuffer(0),
        vfsImage: image,
        privilegedProduct: { ...privilegedProduct },
      })).rejects.toThrow("lacks publication authority");
      expect(forgedKernel.initFromImage).not.toHaveBeenCalled();
      expect(forgedKernel.initFromPublishedPrivilegedProgramProduct)
        .not.toHaveBeenCalled();
    },
  );

  it.each([
    ["/etc/passwd", "maker:x:1000:1000:maker:/home/user:/bin/sh\n", 0o644],
    ["/etc/shadow", "maker:$6$wrong$hash:0:0:99999:7:::\n", 0o640],
    ["/etc/motd.autologin", "image-selected credentials\n", 0o644],
    ["/usr/bin/login", "image-selected program bytes", 0o4755],
  ] as const)("rejects a configured-asset overwrite of %s", async (
    path,
    text,
    mode,
  ) => {
    const loginBytes = new Uint8Array([0, 97, 115, 109, 1]);
    const fs = canonicalFs(loginBytes);
    const { publish } = await productFixture(loginBytes);
    const privilegedProduct = await publish();
    await stageConfiguredAssets(
      fs,
      [{
        path,
        url: `data:application/octet-stream,${encodeURIComponent(text)}`,
        mode,
      }],
      () => {},
      () => {},
    );
    const kernel = fakeKernel();

    await expect(initializeDemoLoginKernel({
      kernel,
      fs,
      kernelWasm: new ArrayBuffer(0),
      vfsImage: await fs.saveImage(),
      privilegedProduct,
    })).resolves.toBe(false);
    expect(kernel.initFromImage).toHaveBeenCalledOnce();
    expect(kernel.initFromPublishedPrivilegedProgramProduct)
      .not.toHaveBeenCalled();
  });

  it(
    "publishes only after configured assets leave every source byte exact",
    async () => {
      const loginBytes = new Uint8Array([0, 97, 115, 109, 1]);
      const { publish, sourceFs } = await productFixture(loginBytes);
      await stageConfiguredAssets(
        sourceFs,
        [{
          path: "/login",
          url: "data:application/octet-stream;base64,AGFzbQI=",
          mode: 0o755,
        }],
        () => {},
        () => {},
      );
      await expect(publish()).rejects.toThrow("artifact digest mismatch");
    },
  );
});
