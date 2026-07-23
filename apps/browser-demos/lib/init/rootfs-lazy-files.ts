import type { MemoryFileSystem } from "../../../../host/src/vfs/memory-fs";

// Keep this module limited to the canonical rootfs package dependency closure.
// Focused consumers such as the PHP PHPT runner must not need every optional
// utility in the interactive shell catalog just to resolve the rootfs entries
// their VFS image actually carries.
import dashWasmUrl from "@binaries/programs/wasm32/dash.wasm?url";
import bashWasmUrl from "@binaries/programs/wasm32/bash.wasm?url";
import coreutilsWasmUrl from "@binaries/programs/wasm32/coreutils.wasm?url";
import gawkWasmUrl from "@binaries/programs/wasm32/gawk.wasm?url";
import grepWasmUrl from "@binaries/programs/wasm32/grep.wasm?url";
import sedWasmUrl from "@binaries/programs/wasm32/sed.wasm?url";
import bcWasmUrl from "@binaries/programs/wasm32/bc.wasm?url";
import fileWasmUrl from "@binaries/programs/wasm32/file/file.wasm?url";
import m4WasmUrl from "@binaries/programs/wasm32/m4.wasm?url";
import makeWasmUrl from "@binaries/programs/wasm32/make.wasm?url";
import findWasmUrl from "@binaries/programs/wasm32/findutils/find.wasm?url";
import xargsWasmUrl from "@binaries/programs/wasm32/findutils/xargs.wasm?url";
import diffWasmUrl from "@binaries/programs/wasm32/diffutils/diff.wasm?url";
import cmpWasmUrl from "@binaries/programs/wasm32/diffutils/cmp.wasm?url";
import diff3WasmUrl from "@binaries/programs/wasm32/diffutils/diff3.wasm?url";
import sdiffWasmUrl from "@binaries/programs/wasm32/diffutils/sdiff.wasm?url";
import ncursesClearWasmUrl from "@binaries/programs/wasm32/ncurses/clear.wasm?url";
import ncursesResetWasmUrl from "@binaries/programs/wasm32/ncurses/reset.wasm?url";
import ncursesTsetWasmUrl from "@binaries/programs/wasm32/ncurses/tset.wasm?url";
import ncursesTputWasmUrl from "@binaries/programs/wasm32/ncurses/tput.wasm?url";
import ncursesTabsWasmUrl from "@binaries/programs/wasm32/ncurses/tabs.wasm?url";
import ncursesTicWasmUrl from "@binaries/programs/wasm32/ncurses/tic.wasm?url";
import ncursesInfocmpWasmUrl from "@binaries/programs/wasm32/ncurses/infocmp.wasm?url";
import ncursesToeWasmUrl from "@binaries/programs/wasm32/ncurses/toe.wasm?url";
import ncursesCaptoinfoWasmUrl from "@binaries/programs/wasm32/ncurses/captoinfo.wasm?url";
import ncursesInfotocapWasmUrl from "@binaries/programs/wasm32/ncurses/infotocap.wasm?url";
import posixArWasmUrl from "@binaries/programs/wasm32/posix-utils-lite/ar.wasm?url";
import posixAsaWasmUrl from "@binaries/programs/wasm32/posix-utils-lite/asa.wasm?url";
import posixCalWasmUrl from "@binaries/programs/wasm32/posix-utils-lite/cal.wasm?url";
import posixCflowWasmUrl from "@binaries/programs/wasm32/posix-utils-lite/cflow.wasm?url";
import posixCompressWasmUrl from "@binaries/programs/wasm32/posix-utils-lite/compress.wasm?url";
import posixCtagsWasmUrl from "@binaries/programs/wasm32/posix-utils-lite/ctags.wasm?url";
import posixCxrefWasmUrl from "@binaries/programs/wasm32/posix-utils-lite/cxref.wasm?url";
import posixEdWasmUrl from "@binaries/programs/wasm32/posix-utils-lite/ed.wasm?url";
import posixExWasmUrl from "@binaries/programs/wasm32/posix-utils-lite/ex.wasm?url";
import posixFuserWasmUrl from "@binaries/programs/wasm32/posix-utils-lite/fuser.wasm?url";
import posixGencatWasmUrl from "@binaries/programs/wasm32/posix-utils-lite/gencat.wasm?url";
import posixGetconfWasmUrl from "@binaries/programs/wasm32/posix-utils-lite/getconf.wasm?url";
import posixGettextWasmUrl from "@binaries/programs/wasm32/posix-utils-lite/gettext.wasm?url";
import posixIconvWasmUrl from "@binaries/programs/wasm32/posix-utils-lite/iconv.wasm?url";
import posixIpcrmWasmUrl from "@binaries/programs/wasm32/posix-utils-lite/ipcrm.wasm?url";
import posixIpcsWasmUrl from "@binaries/programs/wasm32/posix-utils-lite/ipcs.wasm?url";
import posixLexWasmUrl from "@binaries/programs/wasm32/posix-utils-lite/lex.wasm?url";
import posixLocaleWasmUrl from "@binaries/programs/wasm32/posix-utils-lite/locale.wasm?url";
import posixLoggerWasmUrl from "@binaries/programs/wasm32/posix-utils-lite/logger.wasm?url";
import posixMoreWasmUrl from "@binaries/programs/wasm32/posix-utils-lite/more.wasm?url";
import posixMsgfmtWasmUrl from "@binaries/programs/wasm32/posix-utils-lite/msgfmt.wasm?url";
import posixNgettextWasmUrl from "@binaries/programs/wasm32/posix-utils-lite/ngettext.wasm?url";
import posixNmWasmUrl from "@binaries/programs/wasm32/posix-utils-lite/nm.wasm?url";
import posixPatchWasmUrl from "@binaries/programs/wasm32/posix-utils-lite/patch.wasm?url";
import posixPaxWasmUrl from "@binaries/programs/wasm32/posix-utils-lite/pax.wasm?url";
import posixPgrepWasmUrl from "@binaries/programs/wasm32/posix-utils-lite/pgrep.wasm?url";
import posixPsWasmUrl from "@binaries/programs/wasm32/posix-utils-lite/ps.wasm?url";
import posixReniceWasmUrl from "@binaries/programs/wasm32/posix-utils-lite/renice.wasm?url";
import posixStringsWasmUrl from "@binaries/programs/wasm32/posix-utils-lite/strings.wasm?url";
import posixStripWasmUrl from "@binaries/programs/wasm32/posix-utils-lite/strip.wasm?url";
import posixUncompressWasmUrl from "@binaries/programs/wasm32/posix-utils-lite/uncompress.wasm?url";
import posixUudecodeWasmUrl from "@binaries/programs/wasm32/posix-utils-lite/uudecode.wasm?url";
import posixUuencodeWasmUrl from "@binaries/programs/wasm32/posix-utils-lite/uuencode.wasm?url";
import posixWhatWasmUrl from "@binaries/programs/wasm32/posix-utils-lite/what.wasm?url";
import posixXgettextWasmUrl from "@binaries/programs/wasm32/posix-utils-lite/xgettext.wasm?url";
import posixYaccWasmUrl from "@binaries/programs/wasm32/posix-utils-lite/yacc.wasm?url";

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
  ["binaries/programs/wasm32/ncurses/clear.wasm", ncursesClearWasmUrl],
  ["binaries/programs/wasm32/ncurses/reset.wasm", ncursesResetWasmUrl],
  ["binaries/programs/wasm32/ncurses/tset.wasm", ncursesTsetWasmUrl],
  ["binaries/programs/wasm32/ncurses/tput.wasm", ncursesTputWasmUrl],
  ["binaries/programs/wasm32/ncurses/tabs.wasm", ncursesTabsWasmUrl],
  ["binaries/programs/wasm32/ncurses/tic.wasm", ncursesTicWasmUrl],
  ["binaries/programs/wasm32/ncurses/infocmp.wasm", ncursesInfocmpWasmUrl],
  ["binaries/programs/wasm32/ncurses/toe.wasm", ncursesToeWasmUrl],
  ["binaries/programs/wasm32/ncurses/captoinfo.wasm", ncursesCaptoinfoWasmUrl],
  ["binaries/programs/wasm32/ncurses/infotocap.wasm", ncursesInfotocapWasmUrl],
  ["binaries/programs/wasm32/posix-utils-lite/ar.wasm", posixArWasmUrl],
  ["binaries/programs/wasm32/posix-utils-lite/asa.wasm", posixAsaWasmUrl],
  ["binaries/programs/wasm32/posix-utils-lite/cal.wasm", posixCalWasmUrl],
  ["binaries/programs/wasm32/posix-utils-lite/cflow.wasm", posixCflowWasmUrl],
  ["binaries/programs/wasm32/posix-utils-lite/compress.wasm", posixCompressWasmUrl],
  ["binaries/programs/wasm32/posix-utils-lite/ctags.wasm", posixCtagsWasmUrl],
  ["binaries/programs/wasm32/posix-utils-lite/cxref.wasm", posixCxrefWasmUrl],
  ["binaries/programs/wasm32/posix-utils-lite/ed.wasm", posixEdWasmUrl],
  ["binaries/programs/wasm32/posix-utils-lite/ex.wasm", posixExWasmUrl],
  ["binaries/programs/wasm32/posix-utils-lite/fuser.wasm", posixFuserWasmUrl],
  ["binaries/programs/wasm32/posix-utils-lite/gencat.wasm", posixGencatWasmUrl],
  ["binaries/programs/wasm32/posix-utils-lite/getconf.wasm", posixGetconfWasmUrl],
  ["binaries/programs/wasm32/posix-utils-lite/gettext.wasm", posixGettextWasmUrl],
  ["binaries/programs/wasm32/posix-utils-lite/iconv.wasm", posixIconvWasmUrl],
  ["binaries/programs/wasm32/posix-utils-lite/ipcrm.wasm", posixIpcrmWasmUrl],
  ["binaries/programs/wasm32/posix-utils-lite/ipcs.wasm", posixIpcsWasmUrl],
  ["binaries/programs/wasm32/posix-utils-lite/lex.wasm", posixLexWasmUrl],
  ["binaries/programs/wasm32/posix-utils-lite/locale.wasm", posixLocaleWasmUrl],
  ["binaries/programs/wasm32/posix-utils-lite/logger.wasm", posixLoggerWasmUrl],
  ["binaries/programs/wasm32/posix-utils-lite/more.wasm", posixMoreWasmUrl],
  ["binaries/programs/wasm32/posix-utils-lite/msgfmt.wasm", posixMsgfmtWasmUrl],
  ["binaries/programs/wasm32/posix-utils-lite/ngettext.wasm", posixNgettextWasmUrl],
  ["binaries/programs/wasm32/posix-utils-lite/nm.wasm", posixNmWasmUrl],
  ["binaries/programs/wasm32/posix-utils-lite/patch.wasm", posixPatchWasmUrl],
  ["binaries/programs/wasm32/posix-utils-lite/pax.wasm", posixPaxWasmUrl],
  ["binaries/programs/wasm32/posix-utils-lite/pgrep.wasm", posixPgrepWasmUrl],
  ["binaries/programs/wasm32/posix-utils-lite/ps.wasm", posixPsWasmUrl],
  ["binaries/programs/wasm32/posix-utils-lite/renice.wasm", posixReniceWasmUrl],
  ["binaries/programs/wasm32/posix-utils-lite/strings.wasm", posixStringsWasmUrl],
  ["binaries/programs/wasm32/posix-utils-lite/strip.wasm", posixStripWasmUrl],
  ["binaries/programs/wasm32/posix-utils-lite/uncompress.wasm", posixUncompressWasmUrl],
  ["binaries/programs/wasm32/posix-utils-lite/uudecode.wasm", posixUudecodeWasmUrl],
  ["binaries/programs/wasm32/posix-utils-lite/uuencode.wasm", posixUuencodeWasmUrl],
  ["binaries/programs/wasm32/posix-utils-lite/what.wasm", posixWhatWasmUrl],
  ["binaries/programs/wasm32/posix-utils-lite/xgettext.wasm", posixXgettextWasmUrl],
  ["binaries/programs/wasm32/posix-utils-lite/yacc.wasm", posixYaccWasmUrl],
]);

const ROOTFS_LAZY_SOURCE_URL_SET = new Set(ROOTFS_LAZY_ASSET_URLS.keys());
const ROOTFS_LAZY_ASSET_URL_SET = new Set(ROOTFS_LAZY_ASSET_URLS.values());

export function isRootfsLazyFileUrl(url: string): boolean {
  return ROOTFS_LAZY_SOURCE_URL_SET.has(url) || ROOTFS_LAZY_ASSET_URL_SET.has(url);
}

export function rewriteRootfsLazyFileUrls(fs: MemoryFileSystem): void {
  fs.rewriteLazyFileUrls((url) => ROOTFS_LAZY_ASSET_URLS.get(url) ?? url);
}
