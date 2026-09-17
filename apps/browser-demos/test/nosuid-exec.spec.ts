import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "../../..");
// A BACKEND THE TEST WRITES OUT, not a filesystem. What this spec is about is
// the MOUNT's policy — whether `nosuid` strips a set-ID bit, and whether two
// mounts of one backend agree — so what it needs from a backend is a stat it
// chose, set-ID bits included. `MemoryFileSystem` was here because it existed.
const fixedBackendModulePath = resolve(
  repoRoot,
  "host/test/support/fixed-tree-backend.ts",
);
const timeModulePath = resolve(repoRoot, "host/src/vfs/time.ts");
const typesModulePath = resolve(repoRoot, "host/src/vfs/types.ts");
const vfsModulePath = resolve(repoRoot, "host/src/vfs/vfs.ts");
const abiModulePath = resolve(repoRoot, "host/src/generated/abi.ts");

test("browser mount policy honors set-ID unless nosuid is explicit", async ({
  page,
  baseURL,
}) => {
  expect(baseURL).toBeTruthy();
  const asViteFsUrl = (path: string) => new URL(`/@fs${path}`, baseURL).href;
  const modules = [
    asViteFsUrl(fixedBackendModulePath),
    asViteFsUrl(timeModulePath),
    asViteFsUrl(typesModulePath),
    asViteFsUrl(vfsModulePath),
    asViteFsUrl(abiModulePath),
  ];
  for (const moduleUrl of modules) {
    const response = await fetch(moduleUrl);
    const body = await response.text();
    expect(
      response.ok,
      `${response.status} ${response.url}: ${body.slice(0, 500)}`,
    ).toBe(true);
  }
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);

  const result = await page.evaluate(async ({ modules }) => {
    // Load the shared dependency graph serially so a cold Vite server never
    // optimizes the same host modules through concurrent dynamic entries.
    const backendModule = await import(/* @vite-ignore */ modules[0]);
    const time = await import(/* @vite-ignore */ modules[1]);
    const types = await import(/* @vite-ignore */ modules[2]);
    const vfsModule = await import(/* @vite-ignore */ modules[3]);
    const abi = await import(/* @vite-ignore */ modules[4]);
    // 0o6755: set-user-ID and set-group-ID. The bits are the subject, so the
    // backend states them rather than a filesystem happening to preserve them.
    const mutable = new backendModule.FixedTreeBackend({
      "/": { mode: 0o040755, ino: 1 },
      "/bin": { mode: 0o040755, ino: 2 },
      "/bin/tool": { mode: 0o100000 | 0o6755, uid: 0, gid: 42, ino: 3, size: 4 },
    });
    const ordinary = new vfsModule.VirtualPlatformIO(
      [{ mountPoint: "/", backend: mutable }],
      new time.BrowserTimeProvider(),
    );
    const nosuid = new vfsModule.VirtualPlatformIO(
      [{
        mountPoint: "/",
        backend: mutable,
        nosuid: true,
      }],
      new time.BrowserTimeProvider(),
    );
    const aliased = new vfsModule.VirtualPlatformIO(
      [
        {
          mountPoint: "/normal",
          backend: mutable,
        },
        { mountPoint: "/scratch", backend: mutable, nosuid: true },
      ],
      new time.BrowserTimeProvider(),
    );
    const normalHandle = aliased.open(
      "/normal/bin/tool",
      abi.OPEN_FLAGS.O_RDONLY,
      0,
    );
    const nosuidHandle = aliased.open(
      "/scratch/bin/tool",
      abi.OPEN_FLAGS.O_RDONLY,
      0,
    );
    const normalHandleFlags = aliased.fstatfs(normalHandle).flags;
    const nosuidHandleFlags = aliased.fstatfs(nosuidHandle).flags;
    aliased.close(normalHandle);
    aliased.close(nosuidHandle);

    return {
      mutableFlags: ordinary.statfs("/bin/tool").flags,
      mutableNosuid: ordinary.getMountNosuid("/bin/tool"),
      nosuidFlags: nosuid.statfs("/bin/tool").flags,
      nosuidPolicy: nosuid.getMountNosuid("/bin/tool"),
      mutableMode: ordinary.stat("/bin/tool").mode,
      normalHandleFlags,
      nosuidHandleFlags,
      stNosuid: types.ST_NOSUID,
    };
  }, {
    modules,
  });

  expect(result.mutableFlags & result.stNosuid).toBe(0);
  expect(result.mutableNosuid).toBe(false);
  expect(result.nosuidFlags & result.stNosuid).toBe(result.stNosuid);
  expect(result.nosuidPolicy).toBe(true);
  expect(result.mutableMode & 0o6000).toBe(0o6000);
  expect(result.normalHandleFlags & result.stNosuid).toBe(0);
  expect(result.nosuidHandleFlags & result.stNosuid).toBe(result.stNosuid);
});
