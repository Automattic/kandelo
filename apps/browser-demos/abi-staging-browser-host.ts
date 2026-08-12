// Protected entry consumed only by the ABI evidence harness. Its dedicated
// protected Vite config binds this alias to the exact candidate source root;
// the selection wrapper stays reviewed while BrowserKernel remains the exact
// runtime implementation under test.
export { BrowserKernel } from "@exact-browser-kernel-host";
export type {
  BrowserKernelOptions,
  BrowserKernelOwnedImageInitOptions,
} from "@exact-browser-kernel-host";
