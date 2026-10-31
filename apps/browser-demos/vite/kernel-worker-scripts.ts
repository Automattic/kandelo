/**
 * The kernel worker script paths the production service worker's credential
 * gate accepts a grant tag from (`__KERNEL_WORKER_SCRIPT_PATHS__` in
 * public/service-worker.js; see isCredentialGateClient there), from the
 * kernel worker entry chunks the build emitted.
 *
 * A build that bundles the kernel host (`host/src/browser-kernel-host.ts`,
 * which starts the kernel worker) but emitted no kernel worker chunk must
 * fail. The gate would still fail closed, but by refusing every credential
 * grant at run time: a build that succeeded would ship with every grant
 * silently disabled.
 *
 * A build without the kernel host (a page or test fixture that runs no
 * machine) names no kernel worker. That is truthful, not a disabled gate:
 * with no kernel, no process can hold a grant to refuse.
 */
export function kernelWorkerScriptPathsForServiceWorker(
  fileNames: ReadonlySet<string>,
  basePrefix: string,
  bundlesKernelHost: boolean,
): string[] {
  if (fileNames.size === 0 && bundlesKernelHost) {
    throw new Error(
      "the build bundles the kernel host but no kernel worker chunk was emitted, so the " +
        "service worker could accept no credential grant; the build cannot name " +
        "host/src/browser-kernel-worker-entry.ts",
    );
  }
  return [...fileNames].sort().map((fileName) => `${basePrefix}${fileName}`);
}

/** The parts of a Rollup/Rolldown output bundle this module reads. */
export type OutputBundleModules = Record<
  string,
  { type: string; moduleIds?: readonly string[] }
>;

/**
 * Whether any output chunk of `bundle` contains the module at `modulePath`
 * (an absolute, normalized path; a module id's query or hash is ignored).
 */
export function bundleIncludesModule(
  bundle: OutputBundleModules,
  modulePath: string,
): boolean {
  return Object.values(bundle).some(
    (output) =>
      output.type === "chunk" &&
      (output.moduleIds ?? []).some(
        (id) => id.replace(/[?#].*$/, "") === modulePath,
      ),
  );
}
