/** Where the kernel downloads a lazy file or archive: its URL, or for a path
 *  under the binaries root the image-owned address the deployment serves it at. */
export function deloLazyAddress(from: string): string {
  return from.includes("://") ? from : `binaries/${from}`;
}
