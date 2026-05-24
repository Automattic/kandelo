import type {
  LazyFileEntry,
  MemoryFileSystem,
} from "../../../../host/src/vfs/memory-fs";
import {
  SHELL_LAZY_BINARY_SPECS,
  shellLazyPlaceholderUrl,
} from "../../../../images/vfs/lib/init/shell-binaries";

import dashWasmUrl from "@binaries/programs/wasm32/dash.wasm?url";
import bashWasmUrl from "@binaries/programs/wasm32/bash.wasm?url";
import coreutilsWasmUrl from "@binaries/programs/wasm32/coreutils.wasm?url";
import gawkWasmUrl from "@binaries/programs/wasm32/gawk.wasm?url";
import grepWasmUrl from "@binaries/programs/wasm32/grep.wasm?url";
import sedWasmUrl from "@binaries/programs/wasm32/sed.wasm?url";
import bcWasmUrl from "@binaries/programs/wasm32/bc.wasm?url";
import fileWasmUrl from "@binaries/programs/wasm32/file/file.wasm?url";
import lessWasmUrl from "@binaries/programs/wasm32/less.wasm?url";
import m4WasmUrl from "@binaries/programs/wasm32/m4.wasm?url";
import makeWasmUrl from "@binaries/programs/wasm32/make.wasm?url";
import findWasmUrl from "@binaries/programs/wasm32/findutils/find.wasm?url";
import xargsWasmUrl from "@binaries/programs/wasm32/findutils/xargs.wasm?url";
import diffWasmUrl from "@binaries/programs/wasm32/diffutils/diff.wasm?url";
import cmpWasmUrl from "@binaries/programs/wasm32/diffutils/cmp.wasm?url";
import diff3WasmUrl from "@binaries/programs/wasm32/diffutils/diff3.wasm?url";
import sdiffWasmUrl from "@binaries/programs/wasm32/diffutils/sdiff.wasm?url";
import tarWasmUrl from "@binaries/programs/wasm32/tar.wasm?url";
import curlWasmUrl from "@binaries/programs/wasm32/curl.wasm?url";
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

const ROOTFS_LAZY_ASSET_URLS = new Map<string, string>([
  ["binaries/programs/wasm32/dash.wasm", dashWasmUrl],
  ["binaries/programs/wasm32/bash.wasm", bashWasmUrl],
  ["binaries/programs/wasm32/coreutils.wasm", coreutilsWasmUrl],
  ["binaries/programs/wasm32/gawk.wasm", gawkWasmUrl],
  ["binaries/programs/wasm32/grep.wasm", grepWasmUrl],
  ["binaries/programs/wasm32/sed.wasm", sedWasmUrl],
  ["binaries/programs/wasm32/bc.wasm", bcWasmUrl],
  ["binaries/programs/wasm32/file/file.wasm", fileWasmUrl],
  ["binaries/programs/wasm32/m4.wasm", m4WasmUrl],
  ["binaries/programs/wasm32/make.wasm", makeWasmUrl],
  ["binaries/programs/wasm32/findutils/find.wasm", findWasmUrl],
  ["binaries/programs/wasm32/findutils/xargs.wasm", xargsWasmUrl],
  ["binaries/programs/wasm32/diffutils/diff.wasm", diffWasmUrl],
  ["binaries/programs/wasm32/diffutils/cmp.wasm", cmpWasmUrl],
  ["binaries/programs/wasm32/diffutils/diff3.wasm", diff3WasmUrl],
  ["binaries/programs/wasm32/diffutils/sdiff.wasm", sdiffWasmUrl],
]);

const SHELL_LAZY_URLS = new Map([
  ...SHELL_LAZY_PLACEHOLDER_URLS,
  ...ROOTFS_LAZY_ASSET_URLS,
]);

const SHELL_LAZY_SOURCE_URL_SET = new Set(SHELL_LAZY_URLS.keys());
const SHELL_LAZY_ASSET_URL_SET = new Set(SHELL_LAZY_URLS.values());

export function rewriteShellLazyFileUrls(fs: MemoryFileSystem): void {
  fs.rewriteLazyFileUrls((url) => SHELL_LAZY_URLS.get(url) ?? url);
}

export function shellLazyFileEntries(fs: MemoryFileSystem): LazyFileEntry[] {
  return fs.exportLazyEntries().filter((entry) => {
    if (SHELL_LAZY_SOURCE_URL_SET.has(entry.url)) return true;
    return SHELL_LAZY_ASSET_URL_SET.has(entry.url);
  });
}
