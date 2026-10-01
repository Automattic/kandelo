/** User-visible filesystem layout shared by every Kandelo shell image. */
import type { MemoryFileSystem } from "./vfs/memory-fs";
import { ensureDirRecursive, writeVfsFile } from "./vfs/image-helpers";

/**
 * Populate ordinary shell state without selecting binaries, lazy archives,
 * command aliases, or package provenance.
 */
export function populateShellRuntimeLayout(fs: MemoryFileSystem): void {
  for (const dir of [
    "/bin", "/usr", "/usr/bin", "/usr/local", "/usr/local/bin",
    "/usr/share", "/usr/share/misc", "/usr/share/file",
    "/etc", "/root", "/tmp", "/home", "/home/maker", "/dev", "/usr/sbin",
    // NetHack VAR_PLAYGROUND — writable saves, scores, and bones.
    "/home/.nethack",
  ]) {
    ensureDirRecursive(fs, dir);
  }

  fs.chmod("/tmp", 0o1777);
  fs.chmod("/root", 0o700);
  fs.chown("/home/maker", 1000, 1000);

  fs.chown("/home/.nethack", 1000, 1000);
  fs.chmod("/home/.nethack", 0o777);
  for (const file of ["/home/.nethack/perm", "/home/.nethack/record"]) {
    writeVfsFile(fs, file, "");
    fs.chown(file, 1000, 1000);
    fs.chmod(file, 0o666);
  }

  const gitconfig = [
    "[maintenance]",
    "\tauto = false",
    "[gc]",
    "\tauto = 0",
    "[core]",
    "\tpager = cat",
    "[user]",
    "\tname = Maker",
    "\temail = maker@wasm.local",
    "[init]",
    "\tdefaultBranch = main",
    "",
  ].join("\n");
  writeVfsFile(fs, "/etc/gitconfig", gitconfig);

  // ELinks reads this system-wide file before the user's own
  // ~/.config/elinks/elinks.conf, so everything here is only a default.
  //
  // WHY enable scripts: upstream ELinks ships with page JavaScript off. The
  // Kandelo package is built with the QuickJS-NG engine so that pages which
  // build their content with scripts are readable, and a browser that needs
  // a hidden option flipped before that works would not deliver it.
  //
  // WHY 24-bit color: ELinks has no terminfo here and picks its color depth
  // from a built-in table keyed by $TERM; for xterm-256color (what
  // /etc/profile.d exports) that is the 256-color palette. ELinks draws its
  // menus and dialogs as palette entry 0 on entry 15, assuming those are
  // black and white. A terminal theme is free to recolor the first 16
  // entries, and Kandelo's default light theme makes "white" dark so that
  // white text stays readable on a cream background, which turned every
  // ELinks dialog dark-on-dark. Kandelo's terminal renders 24-bit color, so
  // say so: ELinks then sends exact RGB values that no theme reinterprets.
  const elinksConf = [
    "## System-wide ELinks defaults for Kandelo shell images.",
    "## Override them in ~/.config/elinks/elinks.conf or the options manager.",
    "",
    "## Run the JavaScript in pages (upstream default: 0).",
    "set ecmascript.enable = 1",
    "",
    "## Color depth for TERM=xterm-256color: 4 is 24-bit color (upstream",
    "## default: 3, the 256-color palette). The Kandelo terminal renders",
    "## 24-bit color, and exact colors keep menus and dialogs readable under",
    "## themes that recolor the 16 base palette entries.",
    "set terminal.xterm-256color.colors = 4",
    "",
  ].join("\n");
  ensureDirRecursive(fs, "/etc/elinks");
  writeVfsFile(fs, "/etc/elinks/elinks.conf", elinksConf);

  const profile = [
    "alias ls='ls --color=auto'",
    "alias grep='grep --color=auto'",
    "export USER=maker",
    "export NETHACKOPTIONS='windowtype:curses,color,lit_corridor,hilite_pet'",
    "for kandelo_profile in /etc/profile.d/*.sh; do",
    "  [ -r \"$kandelo_profile\" ] && . \"$kandelo_profile\"",
    "done",
    "unset kandelo_profile",
    "",
  ].join("\n");
  writeVfsFile(fs, "/etc/profile", profile);
}
