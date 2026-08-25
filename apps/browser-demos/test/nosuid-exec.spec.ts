import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "../../..");
const memoryFsModulePath = resolve(repoRoot, "host/src/vfs/memory-fs.ts");
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
    asViteFsUrl(memoryFsModulePath),
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
    const memory = await import(/* @vite-ignore */ modules[0]);
    const time = await import(/* @vite-ignore */ modules[1]);
    const types = await import(/* @vite-ignore */ modules[2]);
    const vfsModule = await import(/* @vite-ignore */ modules[3]);
    const abi = await import(/* @vite-ignore */ modules[4]);
    const mutable = memory.MemoryFileSystem.create(
      new SharedArrayBuffer(2 * 1024 * 1024),
    );
    mutable.mkdir("/bin", 0o755);
    mutable.createFileWithOwner(
      "/bin/tool",
      0o6755,
      0,
      42,
      new Uint8Array([0, 97, 115, 109]),
    );
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
