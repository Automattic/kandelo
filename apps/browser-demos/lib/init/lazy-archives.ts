import vimZipUrl from "@binaries/programs/vim.zip?url";
import nethackZipUrl from "@binaries/programs/nethack.zip?url";
import rubyZipUrl from "@binaries/programs/ruby.zip?url";
import pythonZipUrl from "@binaries/programs/python.zip?url";
import nodeZipUrl from "@binaries/programs/node.zip?url";
import perlZipUrl from "@binaries/programs/perl.zip?url";
import manZipUrl from "@binaries/programs/man.zip?url";
import coreutilsDocsZipUrl from "@binaries/programs/coreutils-docs.zip?url";
import lsofDocsZipUrl from "@binaries/programs/lsof-docs.zip?url";

const SHELL_LAZY_ARCHIVES: Record<string, string> = {
  "vim.zip": vimZipUrl,
  "nethack.zip": nethackZipUrl,
  "ruby.zip": rubyZipUrl,
  "python.zip": pythonZipUrl,
  "node.zip": nodeZipUrl,
  "perl.zip": perlZipUrl,
  "man.zip": manZipUrl,
  "coreutils-docs.zip": coreutilsDocsZipUrl,
  "lsof-docs.zip": lsofDocsZipUrl,
};

export function resolveShellLazyArchiveUrl(url: string): string {
  const path = url.split(/[?#]/, 1)[0] ?? url;
  const name = path.split("/").filter(Boolean).pop() ?? path;
  const assetUrl = SHELL_LAZY_ARCHIVES[name];
  if (assetUrl) return assetUrl;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("/")) return url;
  return import.meta.env.BASE_URL + url;
}
