/**
 * The GNU build tools Kandelo ships for building software inside a machine:
 * Autoconf, Automake, Libtool, the Autoconf Archive, gettext, pkgconf, Bison,
 * gperf, Texinfo and help2man.
 *
 * The shell installs them lazily, as SHELL_LAZY_BINARY_SPECS and
 * SHELL_LAZY_ARCHIVE_SPECS entries, so images built on it inherit them. The
 * build image that package builds boot (images/vfs/scripts/
 * build-kandelo-build-image.ts) writes the same files resident. Both read
 * these lists, so the two cannot drift.
 *
 * The script-based tools run the guest's /usr/bin/perl, /usr/bin/m4 and
 * /bin/sh, which their recipes record (scripts/rewrite-guest-tool-paths.py).
 */
import type { VfsBinarySpec } from "./shell-binaries";

/** A package-owned ZIP expanded under `mountPrefix`. */
export interface DevToolArchiveSpec {
  id: string;
  dependency: string;
  resolverPath: string;
  mountPrefix: "/usr/";
  /** A regular file the archive must contain; proves it is mounted. */
  requiredMember: string;
}

/** Compiled programs, each its package's declared output. */
export const DEV_TOOL_BINARY_SPECS = [
  {
    id: "pkgconf",
    resolverPath: "programs/wasm32/pkgconf/pkgconf.wasm",
    vfsPath: "/usr/bin/pkgconf",
    symlinks: ["/usr/bin/pkg-config"],
  },
  { id: "bison", resolverPath: "programs/wasm32/bison/bison.wasm", vfsPath: "/usr/bin/bison", symlinks: [] },
  { id: "gperf", resolverPath: "programs/wasm32/gperf.wasm", vfsPath: "/usr/bin/gperf", symlinks: [] },
  {
    id: "install-info",
    dependency: "texinfo",
    resolverPath: "programs/wasm32/texinfo/install-info.wasm",
    vfsPath: "/usr/bin/install-info",
    symlinks: [],
  },
  // GNU gettext's programs, each fetched on first use. gettext, ngettext,
  // msgfmt and xgettext replace the base image's posix-utils-lite
  // placeholders at the same paths.
  { id: "envsubst", dependency: "gettext", resolverPath: "programs/wasm32/gettext/envsubst.wasm", vfsPath: "/usr/bin/envsubst", symlinks: [] },
  { id: "gettext", dependency: "gettext", resolverPath: "programs/wasm32/gettext/gettext.wasm", vfsPath: "/usr/bin/gettext", symlinks: [], displaces: ["/usr/bin/gettext"] },
  { id: "ngettext", dependency: "gettext", resolverPath: "programs/wasm32/gettext/ngettext.wasm", vfsPath: "/usr/bin/ngettext", symlinks: [], displaces: ["/usr/bin/ngettext"] },
  { id: "printf_gettext", dependency: "gettext", resolverPath: "programs/wasm32/gettext/printf_gettext.wasm", vfsPath: "/usr/bin/printf_gettext", symlinks: [] },
  { id: "printf_ngettext", dependency: "gettext", resolverPath: "programs/wasm32/gettext/printf_ngettext.wasm", vfsPath: "/usr/bin/printf_ngettext", symlinks: [] },
  { id: "msgattrib", dependency: "gettext", resolverPath: "programs/wasm32/gettext/msgattrib.wasm", vfsPath: "/usr/bin/msgattrib", symlinks: [] },
  { id: "msgcat", dependency: "gettext", resolverPath: "programs/wasm32/gettext/msgcat.wasm", vfsPath: "/usr/bin/msgcat", symlinks: [] },
  { id: "msgcmp", dependency: "gettext", resolverPath: "programs/wasm32/gettext/msgcmp.wasm", vfsPath: "/usr/bin/msgcmp", symlinks: [] },
  { id: "msgcomm", dependency: "gettext", resolverPath: "programs/wasm32/gettext/msgcomm.wasm", vfsPath: "/usr/bin/msgcomm", symlinks: [] },
  { id: "msgconv", dependency: "gettext", resolverPath: "programs/wasm32/gettext/msgconv.wasm", vfsPath: "/usr/bin/msgconv", symlinks: [] },
  { id: "msgen", dependency: "gettext", resolverPath: "programs/wasm32/gettext/msgen.wasm", vfsPath: "/usr/bin/msgen", symlinks: [] },
  { id: "msgexec", dependency: "gettext", resolverPath: "programs/wasm32/gettext/msgexec.wasm", vfsPath: "/usr/bin/msgexec", symlinks: [] },
  { id: "msgfilter", dependency: "gettext", resolverPath: "programs/wasm32/gettext/msgfilter.wasm", vfsPath: "/usr/bin/msgfilter", symlinks: [] },
  { id: "msgfmt", dependency: "gettext", resolverPath: "programs/wasm32/gettext/msgfmt.wasm", vfsPath: "/usr/bin/msgfmt", symlinks: [], displaces: ["/usr/bin/msgfmt"] },
  { id: "msggrep", dependency: "gettext", resolverPath: "programs/wasm32/gettext/msggrep.wasm", vfsPath: "/usr/bin/msggrep", symlinks: [] },
  { id: "msginit", dependency: "gettext", resolverPath: "programs/wasm32/gettext/msginit.wasm", vfsPath: "/usr/bin/msginit", symlinks: [] },
  { id: "msgmerge", dependency: "gettext", resolverPath: "programs/wasm32/gettext/msgmerge.wasm", vfsPath: "/usr/bin/msgmerge", symlinks: [] },
  { id: "msgpre", dependency: "gettext", resolverPath: "programs/wasm32/gettext/msgpre.wasm", vfsPath: "/usr/bin/msgpre", symlinks: [] },
  { id: "msgunfmt", dependency: "gettext", resolverPath: "programs/wasm32/gettext/msgunfmt.wasm", vfsPath: "/usr/bin/msgunfmt", symlinks: [] },
  { id: "msguniq", dependency: "gettext", resolverPath: "programs/wasm32/gettext/msguniq.wasm", vfsPath: "/usr/bin/msguniq", symlinks: [] },
  { id: "recode-sr-latin", dependency: "gettext", resolverPath: "programs/wasm32/gettext/recode-sr-latin.wasm", vfsPath: "/usr/bin/recode-sr-latin", symlinks: [] },
  { id: "xgettext", dependency: "gettext", resolverPath: "programs/wasm32/gettext/xgettext.wasm", vfsPath: "/usr/bin/xgettext", symlinks: [], displaces: ["/usr/bin/xgettext"] },
] as const satisfies readonly VfsBinarySpec[];

/** Scripts and data, as ZIPs rooted at /usr. */
export const DEV_TOOL_ARCHIVE_SPECS = [
  {
    id: "autoconf",
    dependency: "autoconf",
    resolverPath: "programs/wasm32/autoconf.zip",
    mountPrefix: "/usr/",
    requiredMember: "bin/autoconf",
  },
  {
    id: "automake",
    dependency: "automake",
    resolverPath: "programs/wasm32/automake.zip",
    mountPrefix: "/usr/",
    requiredMember: "bin/automake",
  },
  {
    id: "libtool",
    dependency: "libtool",
    resolverPath: "programs/wasm32/libtool.zip",
    mountPrefix: "/usr/",
    requiredMember: "bin/libtoolize",
  },
  {
    id: "autoconf-archive",
    dependency: "autoconf-archive",
    resolverPath: "programs/wasm32/autoconf-archive.zip",
    mountPrefix: "/usr/",
    requiredMember: "share/aclocal/ax_check_compile_flag.m4",
  },
  {
    id: "help2man",
    dependency: "help2man",
    resolverPath: "programs/wasm32/help2man.zip",
    mountPrefix: "/usr/",
    requiredMember: "bin/help2man",
  },
  {
    id: "texinfo",
    dependency: "texinfo",
    resolverPath: "programs/wasm32/texinfo/texinfo.zip",
    mountPrefix: "/usr/",
    requiredMember: "bin/texi2any",
  },
  {
    id: "gettext-data",
    dependency: "gettext",
    resolverPath: "programs/wasm32/gettext/gettext-data.zip",
    mountPrefix: "/usr/",
    requiredMember: "bin/autopoint",
  },
  {
    id: "pkgconf-data",
    dependency: "pkgconf",
    resolverPath: "programs/wasm32/pkgconf/pkgconf-data.zip",
    mountPrefix: "/usr/",
    requiredMember: "share/aclocal/pkg.m4",
  },
  {
    id: "bison-data",
    dependency: "bison",
    resolverPath: "programs/wasm32/bison/bison-data.zip",
    mountPrefix: "/usr/",
    requiredMember: "share/bison/m4sugar/m4sugar.m4",
  },
] as const satisfies readonly DevToolArchiveSpec[];
