import caCertificatesZipUrl from "@binaries/programs/wasm32/ca-certificates.zip?url";
import espeakNgDataZipUrl from "@binaries/programs/wasm32/espeak-ng/espeak-ng-data.zip?url";
import desktopDataZipUrl from "@binaries/programs/wasm32/wayland-demo/kandelo-desktop-data.zip?url";
import loveExamplesZipUrl from "@binaries/programs/wasm32/love/share/love-examples.zip?url";
import vimZipUrl from "@binaries/programs/vim.zip?url";
import freecivZipUrl from "@binaries/programs/freeciv-browser-bundle/freeciv.zip?url";
import nethackZipUrl from "@binaries/programs/nethack.zip?url";
import rubyZipUrl from "@binaries/programs/ruby.zip?url";
import pythonZipUrl from "@binaries/programs/python-browser-bundle/python.zip?url";
import nodeZipUrl from "@binaries/programs/node.zip?url";
import perlZipUrl from "@binaries/programs/perl.zip?url";
import composerZipUrl from "@binaries/programs/composer.zip?url";
import manZipUrl from "@binaries/programs/man.zip?url";
import coreutilsDocsZipUrl from "@binaries/programs/coreutils-docs.zip?url";
import lsofDocsZipUrl from "@binaries/programs/lsof-docs.zip?url";
import kandeloSdkZipUrl from "@binaries/programs/kandelo-sdk.zip?url";

export const SHELL_LAZY_ARCHIVES: Record<string, string> = {
  "ca-certificates.zip": caCertificatesZipUrl,
  "espeak-ng-data.zip": espeakNgDataZipUrl,
  "kandelo-desktop-data.zip": desktopDataZipUrl,
  "love-examples.zip": loveExamplesZipUrl,
  "vim.zip": vimZipUrl,
  "freeciv.zip": freecivZipUrl,
  "kandelo-sdk.zip": kandeloSdkZipUrl,
  "nethack.zip": nethackZipUrl,
  "ruby.zip": rubyZipUrl,
  "python.zip": pythonZipUrl,
  "node.zip": nodeZipUrl,
  "perl.zip": perlZipUrl,
  "composer.zip": composerZipUrl,
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
