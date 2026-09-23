import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

const repoRoot = resolve(import.meta.dirname, "../../..");
const galleryDescriptorModule = resolve(
  repoRoot,
  "apps/browser-demos/pages/kandelo/gallery-descriptor.ts",
);
const defaultMountsModule = resolve(repoRoot, "host/src/vfs/default-mounts.ts");
const imageHelpersModule = resolve(repoRoot, "host/src/vfs/image-helpers.ts");
const memoryFsModule = resolve(repoRoot, "host/src/vfs/memory-fs.ts");
const shellProfilesModule = resolve(
  repoRoot,
  "images/vfs/scripts/shell-lazy-archives.ts",
);
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
      imageHelpersUrl,
      mountsUrl,
      memoryFsUrl,
      shellProfilesUrl,
      timeUrl,
      vfsUrl,
    }) => {
      const { descriptorFromGalleryItem } = await import(
        /* @vite-ignore */ galleryUrl
      );
      const { DEFAULT_MOUNT_SPEC, resolveForBrowser } = await import(
        /* @vite-ignore */ mountsUrl
      );
      const { ensureDirRecursive } = await import(
        /* @vite-ignore */ imageHelpersUrl
      );
      const { MemoryFileSystem } = await import(/* @vite-ignore */ memoryFsUrl);
      const { registerShellProfileScripts } = await import(
        /* @vite-ignore */ shellProfilesUrl
      );
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

      // The shell image ships ONE /etc/profile.d for every machine it
      // carries, so the npm settings the `node` machine needs must live
      // there — and must not seed a package.json or a /work tree that every
      // other shell-family machine would also inherit.
      const nodeFs = MemoryFileSystem.create(
        new SharedArrayBuffer(4 * 1024 * 1024),
      );
      ensureDirRecursive(nodeFs, "/home/maker");
      registerShellProfileScripts(nodeFs);
      const profilePath = "/etc/profile.d/node.sh";
      const profileStat = nodeFs.stat(profilePath);
      const profileFd = nodeFs.open(profilePath, 0, 0);
      const profileBytes = new Uint8Array(profileStat.size);
      const profileLength = nodeFs.read(
        profileFd,
        profileBytes,
        null,
        profileBytes.length,
      );
      nodeFs.close(profileFd);
      let imageSeedsPackage = true;
      try {
        nodeFs.stat("/home/maker/package.json");
      } catch {
        imageSeedsPackage = false;
      }
      let workExists = true;
      try {
        nodeFs.stat("/work");
      } catch {
        workExists = false;
      }

      const homeMount = mounts.find(
        (mount: { mountPoint: string }) => mount.mountPoint === "/home/maker",
      );
      return {
        data: new TextDecoder().decode(actual.subarray(0, length)),
        homeUid: homeMount?.backend.stat("/").uid,
        homeGid: homeMount?.backend.stat("/").gid,
        nodeShellProfile: new TextDecoder().decode(
          profileBytes.subarray(0, profileLength),
        ),
        imageSeedsPackage,
        workExists,
        shell: shell.boot,
        node: node.boot,
      };
    },
    {
      galleryUrl: asViteFsUrl(galleryDescriptorModule),
      imageHelpersUrl: asViteFsUrl(imageHelpersModule),
      mountsUrl: asViteFsUrl(defaultMountsModule),
      memoryFsUrl: asViteFsUrl(memoryFsModule),
      shellProfilesUrl: asViteFsUrl(shellProfilesModule),
      timeUrl: asViteFsUrl(timeModule),
      vfsUrl: asViteFsUrl(vfsModule),
    },
  );

  expect(result).toEqual({
    data: "maker browser profile",
    homeUid: 1000,
    homeGid: 1000,
    nodeShellProfile: expect.any(String),
    imageSeedsPackage: false,
    workExists: false,
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
  expect(result.nodeShellProfile).toContain(
    "export npm_config_cache=/tmp/.npm-cache",
  );
  expect(result.nodeShellProfile).not.toContain("PS1");
  expect(result.nodeShellProfile).not.toContain("package.json");
});
