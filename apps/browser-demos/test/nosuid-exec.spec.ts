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

test("browser mount policy defaults mutable execution to nosuid", async ({
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
    const trustedBackend = memory.createImmutableProductBackend(mutable);
    const trusted = new vfsModule.VirtualPlatformIO(
      [{
        mountPoint: "/",
        backend: trustedBackend,
        readonly: true,
        setIdCapability: {
          kind: "trusted-root-product",
          guestWritable: false,
          stableExecutableIdentity: true,
        },
      }],
      new time.BrowserTimeProvider(),
    );
    const aliased = new vfsModule.VirtualPlatformIO(
      [
        {
          mountPoint: "/trusted",
          backend: trustedBackend,
          readonly: true,
          setIdCapability: {
            kind: "trusted-root-product",
            guestWritable: false,
            stableExecutableIdentity: true,
          },
        },
        { mountPoint: "/raw", backend: trustedBackend, readonly: true },
      ],
      new time.BrowserTimeProvider(),
    );
    const trustedHandle = aliased.open(
      "/trusted/bin/tool",
      abi.OPEN_FLAGS.O_RDONLY,
      0,
    );
    const rawHandle = aliased.open(
      "/raw/bin/tool",
      abi.OPEN_FLAGS.O_RDONLY,
      0,
    );
    const trustedHandleFlags = aliased.fstatfs(trustedHandle).flags;
    const rawHandleFlags = aliased.fstatfs(rawHandle).flags;
    aliased.close(trustedHandle);
    aliased.close(rawHandle);

    return {
      mutableFlags: ordinary.statfs("/bin/tool").flags,
      mutableCapability: ordinary.getMountSetIdCapability("/bin/tool"),
      trustedFlags: trusted.statfs("/bin/tool").flags,
      trustedCapability: trusted.getMountSetIdCapability("/bin/tool"),
      trustedMode: trusted.stat("/bin/tool").mode,
      trustedHandleFlags,
      rawHandleFlags,
      stNosuid: types.ST_NOSUID,
    };
  }, {
    modules,
  });

  expect(result.mutableFlags & result.stNosuid).toBe(result.stNosuid);
  expect(result.mutableCapability).toEqual({ kind: "nosuid" });
  expect(result.trustedFlags & result.stNosuid).toBe(0);
  expect(result.trustedCapability).toEqual({
    kind: "trusted-root-product",
    guestWritable: false,
    stableExecutableIdentity: true,
  });
  expect(result.trustedMode & 0o6000).toBe(0o6000);
  expect(result.trustedHandleFlags & result.stNosuid).toBe(0);
  expect(result.rawHandleFlags & result.stNosuid).toBe(result.stNosuid);
});
