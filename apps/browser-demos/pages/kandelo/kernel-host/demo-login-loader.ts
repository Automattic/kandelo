import type { BrowserKernel } from "../../../../../host/src/browser-kernel-host";
import type { ClosedLazyAsset } from "../../../../../host/src/vfs/closed-lazy-assets";
import type { MemoryFileSystem } from "../../../../../host/src/vfs/memory-fs";
import {
  publishedPrivilegedProgramMatchesFile,
  type PublishedPrivilegedProgramProduct,
} from "../../../../../host/src/vfs/privileged-projection";
import {
  DEMO_LOGIN_PROGRAM_PATH,
  hasConfiguredDemoLogin,
} from "../../../../../images/vfs/lib/demo-login";

type DemoLoginKernel = Pick<
  BrowserKernel,
  "initFromImage" | "initFromPublishedPrivilegedProgramProduct"
>;

export interface InitializeDemoLoginKernelOptions {
  kernel: DemoLoginKernel;
  fs: MemoryFileSystem;
  kernelWasm?: ArrayBuffer;
  vfsImage: Uint8Array | "default";
  closedLazyAssets?: readonly ClosedLazyAsset[];
  privilegedProduct?: PublishedPrivilegedProgramProduct;
}

/**
 * Select the privileged login path only from the fully staged image and the
 * publisher's private product identity. Image/config data alone always boots
 * through the ordinary, nosuid image path.
 */
export async function initializeDemoLoginKernel(
  options: InitializeDemoLoginKernelOptions,
): Promise<boolean> {
  const { privilegedProduct } = options;
  const loginSessionsEnabled = privilegedProduct !== undefined &&
    hasConfiguredDemoLogin(options.fs) &&
    await publishedPrivilegedProgramMatchesFile(
      privilegedProduct,
      options.fs,
      DEMO_LOGIN_PROGRAM_PATH,
    );
  const common = {
    ...(options.kernelWasm === undefined ? {} : { kernelWasm: options.kernelWasm }),
    vfsImage: options.vfsImage,
    ...(options.closedLazyAssets === undefined
      ? {}
      : { closedLazyAssets: options.closedLazyAssets }),
  };
  if (loginSessionsEnabled) {
    await options.kernel.initFromPublishedPrivilegedProgramProduct({
      ...common,
      privilegedProduct,
    });
  } else {
    await options.kernel.initFromImage(common);
  }
  return loginSessionsEnabled;
}
