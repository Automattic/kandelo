import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
// Imported HERE, in the Playwright (Node) process, not through the page:
// shell-lazy-archives.ts reads package artifacts with node:fs at module
// scope, so the browser cannot evaluate it. What the browser half of this
// spec proves is the mounted maker home; the profile scripts are plain
// bytes, and checking them in Node keeps both halves honest.
import { registerShellProfileScripts } from "../../../images/vfs/scripts/shell-lazy-archives";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import { ensureDirRecursive } from "../../../host/src/vfs/image-helpers";

const repoRoot = resolve(import.meta.dirname, "../../..");
const galleryDescriptorModule = resolve(
  repoRoot,
  "apps/browser-demos/pages/kandelo/gallery-descriptor.ts",
);
const defaultMountsModule = resolve(repoRoot, "host/src/vfs/default-mounts.ts");
const memoryFsModule = resolve(repoRoot, "host/src/vfs/memory-fs.ts");
const timeModule = resolve(repoRoot, "host/src/vfs/time.ts");
const vfsModule = resolve(repoRoot, "host/src/vfs/vfs.ts");

test("default browser profiles use the writable canonical maker home", async ({
  page,
  baseURL,
}) => {
  expect(baseURL).toBeTruthy();
  const asViteFsUrl = (path: string) => new URL(`/@fs${path}`, baseURL).href;
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);

  const result = await page.evaluate(
    async ({
      galleryUrl,
      mountsUrl,
      memoryFsUrl,
      timeUrl,
      vfsUrl,
    }) => {
      const { descriptorFromGalleryItem } = await import(
        /* @vite-ignore */ galleryUrl
      );
      const { DEFAULT_MOUNT_SPEC, resolveForBrowser } = await import(
        /* @vite-ignore */ mountsUrl
      );
      const { MemoryFileSystem } = await import(/* @vite-ignore */ memoryFsUrl);
      const { BrowserTimeProvider } = await import(/* @vite-ignore */ timeUrl);
      const { VirtualPlatformIO } = await import(/* @vite-ignore */ vfsUrl);

      const root = MemoryFileSystem.create(
        new SharedArrayBuffer(2 * 1024 * 1024),
      );
      root.mkdir("/etc", 0o755);
      const group = new TextEncoder().encode(
        "root:x:0:\nnogroup:x:65534:\nnobody:x:65534:\n",
      );
      const groupFd = root.open("/etc/group", 0x241, 0o644);
      root.write(groupFd, group, null, group.length);
      root.close(groupFd);
      const image = await root.saveImage();
      const scratchSabBytes = Object.fromEntries(
        DEFAULT_MOUNT_SPEC.filter(
          (mount: { source: string }) => mount.source === "scratch",
        ).map((mount: { path: string }) => [mount.path, 256 * 1024]),
      );
      const mounts = await resolveForBrowser(DEFAULT_MOUNT_SPEC, image, {
        scratchSabBytes,
      });
      const io = new VirtualPlatformIO(mounts, new BrowserTimeProvider());
      const data = new TextEncoder().encode("maker browser profile");
      const fd = io.open("/home/maker/profile.txt", 0x241, 0o644);
      io.write(fd, data, null, data.length);
      io.close(fd);
      const readFd = io.open("/home/maker/profile.txt", 0, 0);
      const actual = new Uint8Array(64);
      const length = io.read(readFd, actual, null, actual.length);
      io.close(readFd);

      const base = {
        version: 1,
        id: "stale",
        title: "Stale",
        base: "kandelo:shell@abi43",
        runtime: {
          arch: "wasm32",
          kernel: "kernel@local",
          memoryPages: 2048,
          features: ["shared-array-buffer", "pty"],
          time: "real",
        },
        packages: [],
        mounts: [{ path: "/", source: "image", ref: "rootfs@local" }],
        boot: {
          argv: ["stale"],
          cwd: "/stale",
          env: { HOME: "/stale", USER: "stale", LOGNAME: "stale" },
          uid: 42,
          gid: 42,
        },
      };
      const shell = descriptorFromGalleryItem(
        {
          id: "shell",
          title: "Shell",
          description: "Shell",
          bootCommand: ["bash", "-l", "-i"],
          packages: [],
        },
        base,
      );
      const node = descriptorFromGalleryItem(
        {
          id: "node",
          title: "Node",
          description: "Node",
          bootCommand: ["bash", "-l", "-i"],
          packages: [],
        },
        base,
      );


      const homeMount = mounts.find(
        (mount: { mountPoint: string }) => mount.mountPoint === "/home/maker",
      );
      return {
        data: new TextDecoder().decode(actual.subarray(0, length)),
        homeUid: homeMount?.backend.stat("/").uid,
        homeGid: homeMount?.backend.stat("/").gid,
        shell: shell.boot,
        node: node.boot,
      };
    },
    {
      galleryUrl: asViteFsUrl(galleryDescriptorModule),
      mountsUrl: asViteFsUrl(defaultMountsModule),
      memoryFsUrl: asViteFsUrl(memoryFsModule),
      timeUrl: asViteFsUrl(timeModule),
      vfsUrl: asViteFsUrl(vfsModule),
    },
  );

  expect(result).toEqual({
    data: "maker browser profile",
    homeUid: 1000,
    homeGid: 1000,
    shell: {
      // BOOT IDENTITY COMES FROM THE IMAGE: descriptorFromGalleryItem no
      // longer assigns argv from the gallery item's display-only
      // `bootCommand`, so it stays whatever the base descriptor carried.
      argv: ["stale"],
      cwd: "/home/maker",
      env: { HOME: "/home/maker", USER: "maker", LOGNAME: "maker" },
      uid: 1000,
      gid: 1000,
    },
    node: {
      argv: ["stale"],
      cwd: "/home/maker",
      env: {
        HOME: "/home/maker",
        PWD: "/home/maker",
        USER: "maker",
        LOGNAME: "maker",
      },
      uid: 1000,
      gid: 1000,
    },
  });

  // The shell image ships ONE /etc/profile.d for every machine it carries,
  // so the npm settings the `node` machine needs live there — and must not
  // seed a package.json or a /work tree that every other shell-family
  // machine would inherit.
  const profileFs = MemoryFileSystem.create(
    new SharedArrayBuffer(4 * 1024 * 1024),
  );
  ensureDirRecursive(profileFs, "/home/maker");
  registerShellProfileScripts(profileFs);
  const nodeShellProfile = readVfsText(profileFs, "/etc/profile.d/node.sh");
  expect(nodeShellProfile).toContain("export npm_config_cache=/tmp/.npm-cache");
  expect(nodeShellProfile).not.toContain("PS1");
  expect(nodeShellProfile).not.toContain("package.json");
  expect(() => profileFs.stat("/home/maker/package.json")).toThrow();
  expect(() => profileFs.stat("/work")).toThrow();
});

function readVfsText(fs: MemoryFileSystem, path: string): string {
  const stat = fs.stat(path);
  const handle = fs.open(path, 0, 0);
  try {
    const bytes = new Uint8Array(stat.size);
    const length = fs.read(handle, bytes, null, bytes.length);
    return new TextDecoder().decode(bytes.subarray(0, length));
  } finally {
    fs.close(handle);
  }
}
