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
