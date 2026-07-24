import vimZipUrl from "@binaries/programs/vim.zip?url";
import nethackZipUrl from "@binaries/programs/nethack.zip?url";
import homebrewBootstrapZipUrl from "@binaries/programs/homebrew-bootstrap/homebrew-bootstrap.zip?url";

const SHELL_LAZY_ARCHIVES: Record<string, string> = {
  "vim.zip": vimZipUrl,
  "nethack.zip": nethackZipUrl,
  // The shell descriptor intentionally keeps a package-relative URL. Vite
  // owns the browser deployment path, so resolve it through the package
  // projection instead of baking a development-server URL into the VFS.
  "homebrew-bootstrap.zip": homebrewBootstrapZipUrl,
};

export function resolveShellLazyArchiveUrl(url: string): string {
  const path = url.split(/[?#]/, 1)[0] ?? url;
  const name = path.split("/").filter(Boolean).pop() ?? path;
  const assetUrl = SHELL_LAZY_ARCHIVES[name];
  if (assetUrl) return assetUrl;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("/")) return url;
  return import.meta.env.BASE_URL + url;
}
