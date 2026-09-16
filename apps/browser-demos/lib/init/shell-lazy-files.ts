import {
  SHELL_LAZY_BINARY_SPECS,
  shellLazyPlaceholderUrl,
} from "../../../../images/vfs/lib/init/shell-binaries";

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
import sqlite3WasmUrl from "@binaries/programs/wasm32/sqlite3.wasm?url";

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
  "sqlite-cli": sqlite3WasmUrl,
};

export const SHELL_LAZY_PLACEHOLDER_URLS = new Map(
  SHELL_LAZY_BINARY_SPECS.map((spec) => [
    shellLazyPlaceholderUrl(spec),
    SHELL_LAZY_ASSET_URLS[spec.id],
  ]),
);


// `rewriteShellLazyFileUrls` and `shellLazyFileEntries` were here. Both wrote
// to, or read from, an image's deferred half — one rewriting every stored lazy
// URL, the other enumerating them to decide which were "ours". Nothing calls
// either since the deployment stopped rewriting the image and started mapping
// addresses when it fetches them (`imageOwnedRuntimeUrlTable`).
//
// `SHELL_LAZY_PLACEHOLDER_URLS` above survives them, and is now the whole of
// what this module contributes: a table from the placeholder URL an image
// records to the asset URL this build serves. That table was always the
// content; walking a filesystem to apply it was the part that could go wrong.
