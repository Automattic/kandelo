import type {
  LazyFileEntry,
  MemoryFileSystem,
} from "../../../../host/src/vfs/memory-fs";
import {
  SHELL_LAZY_BINARY_SPECS,
  shellLazyPlaceholderUrl,
} from "../../../../images/vfs/lib/init/shell-binaries";
import {
  isRootfsLazyFileUrl,
  rewriteRootfsLazyFileUrls,
} from "./rootfs-lazy-files";

import coreutilsWasmUrl from "@binaries/programs/wasm32/coreutils.wasm?url";
import grepWasmUrl from "@binaries/programs/wasm32/grep.wasm?url";
import sedWasmUrl from "@binaries/programs/wasm32/sed.wasm?url";
import bcWasmUrl from "@binaries/programs/wasm32/bc.wasm?url";
import fileWasmUrl from "@binaries/programs/wasm32/file/file.wasm?url";
import lessWasmUrl from "@binaries/programs/wasm32/less.wasm?url";
import m4WasmUrl from "@binaries/programs/wasm32/m4.wasm?url";
import makeWasmUrl from "@binaries/programs/wasm32/make.wasm?url";
import tarWasmUrl from "@binaries/programs/wasm32/tar.wasm?url";
import curlWasmUrl from "@binaries/programs/wasm32/curl.wasm?url";
import ncWasmUrl from "@binaries/programs/wasm32/nc.wasm?url";
import wgetWasmUrl from "@binaries/programs/wasm32/wget.wasm?url";
import gitWasmUrl from "@binaries/programs/wasm32/git/git.wasm?url";
import gitRemoteHttpWasmUrl from "@binaries/programs/wasm32/git/git-remote-http.wasm?url";
import gzipWasmUrl from "@binaries/programs/wasm32/gzip.wasm?url";
import bzip2WasmUrl from "@binaries/programs/wasm32/bzip2.wasm?url";
import xzWasmUrl from "@binaries/programs/wasm32/xz.wasm?url";
import zstdWasmUrl from "@binaries/programs/wasm32/zstd.wasm?url";
import zipWasmUrl from "@binaries/programs/wasm32/zip.wasm?url";
import unzipWasmUrl from "@binaries/programs/wasm32/unzip.wasm?url";
import lsofWasmUrl from "@binaries/programs/wasm32/lsof.wasm?url";
import nanoWasmUrl from "@binaries/programs/wasm32/nano.wasm?url";

const SHELL_LAZY_ASSET_URLS: Record<(typeof SHELL_LAZY_BINARY_SPECS)[number]["id"], string> = {
  coreutils: coreutilsWasmUrl,
  grep: grepWasmUrl,
  sed: sedWasmUrl,
  bc: bcWasmUrl,
  file: fileWasmUrl,
  less: lessWasmUrl,
  m4: m4WasmUrl,
  make: makeWasmUrl,
  tar: tarWasmUrl,
  curl: curlWasmUrl,
  netcat: ncWasmUrl,
  wget: wgetWasmUrl,
  git: gitWasmUrl,
  "git-remote-http": gitRemoteHttpWasmUrl,
  gzip: gzipWasmUrl,
  bzip2: bzip2WasmUrl,
  xz: xzWasmUrl,
  zstd: zstdWasmUrl,
  zip: zipWasmUrl,
  unzip: unzipWasmUrl,
  lsof: lsofWasmUrl,
  nano: nanoWasmUrl,
};

const SHELL_LAZY_PLACEHOLDER_URLS = new Map(
  SHELL_LAZY_BINARY_SPECS.map((spec) => [
    shellLazyPlaceholderUrl(spec),
    SHELL_LAZY_ASSET_URLS[spec.id],
  ]),
);

const SHELL_LAZY_SOURCE_URL_SET = new Set(SHELL_LAZY_PLACEHOLDER_URLS.keys());
const SHELL_LAZY_ASSET_URL_SET = new Set(SHELL_LAZY_PLACEHOLDER_URLS.values());

export function rewriteShellLazyFileUrls(fs: MemoryFileSystem): void {
  rewriteRootfsLazyFileUrls(fs);
  fs.rewriteLazyFileUrls((url) => SHELL_LAZY_PLACEHOLDER_URLS.get(url) ?? url);
}

export function shellLazyFileEntries(fs: MemoryFileSystem): LazyFileEntry[] {
  return fs.exportLazyEntries().filter((entry) => {
    if (isRootfsLazyFileUrl(entry.url)) return true;
    if (SHELL_LAZY_SOURCE_URL_SET.has(entry.url)) return true;
    return SHELL_LAZY_ASSET_URL_SET.has(entry.url);
  });
}
