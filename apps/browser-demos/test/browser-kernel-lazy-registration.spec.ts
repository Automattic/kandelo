import { expect, test } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const lazyRegistrationModulePath = resolve(
  __dirname,
  "../../../host/src/browser-kernel-lazy-registration.ts",
);
const memoryFsModulePath = resolve(
  __dirname,
  "../../../host/src/vfs/memory-fs.ts",
);

test("BrowserKernel init waits for lazy VFS registration acknowledgement", async ({
  page,
  baseURL,
}) => {
  expect(baseURL).toBeTruthy();

  const lazyRegistrationModuleUrl = new URL(`/@fs/${lazyRegistrationModulePath}`, baseURL).href;
  const memoryFsModuleUrl = new URL(`/@fs/${memoryFsModulePath}`, baseURL).href;

  await page.goto(new URL("/trap-signal-test.html", baseURL).href);
  const result = await page.evaluate(
    async ({ lazyRegistrationModuleUrl, memoryFsModuleUrl }) => {
      const { registerLazyVfsMetadata } = await import(
        /* @vite-ignore */ lazyRegistrationModuleUrl
      );
      const { MemoryFileSystem } = await import(/* @vite-ignore */ memoryFsModuleUrl);

      const memfs = MemoryFileSystem.create(new SharedArrayBuffer(1024 * 1024));
      memfs.registerLazyFile("/bin/lazy", "/assets/lazy.wasm", 123);

      let acknowledge: (() => void) | null = null;
      const sent: any[] = [];
      const registration = registerLazyVfsMetadata(memfs, async (message: any) => {
        sent.push(message);
        await new Promise<void>((resolve) => {
          acknowledge = resolve;
        });
      });
      let resolved = false;
      void registration.then(() => {
        resolved = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
      const resolvedBeforeAck = resolved;
      acknowledge?.();
      await registration;

      return {
        sent,
        resolvedBeforeAck,
        resolvedAfterAck: resolved,
      };
    },
    { lazyRegistrationModuleUrl, memoryFsModuleUrl },
  );

  expect(result.sent).toMatchObject([
    {
      type: "register_lazy_files",
      entries: [{ path: "/bin/lazy", url: "/assets/lazy.wasm", size: 123 }],
    },
  ]);
  expect(result.resolvedBeforeAck).toBe(false);
  expect(result.resolvedAfterAck).toBe(true);
});
