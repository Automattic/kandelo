import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";
import {
  MAIN_SHELL_VFS_INODE_CAPACITY,
  MAIN_SHELL_VFS_PROFILE_MAX_BYTES,
} from "../../../web-libs/kandelo-session/src/vfs-capacity";

export async function developmentInodeCapacityImage(bash: Uint8Array, coreutils: Uint8Array): Promise<Uint8Array> {
  const fs = KandeloImageFs.create();
  fs.setImageCapacity(MAIN_SHELL_VFS_PROFILE_MAX_BYTES);
  fs.setExportInodeCapacity(MAIN_SHELL_VFS_INODE_CAPACITY);
  fs.mkdir("/etc", 0o755);
  fs.mkdir("/bin", 0o755);
  fs.writeFile("/bin/bash", bash, 0o755);
  fs.writeFile("/bin/coreutils", coreutils, 0o755);
  for (const command of ["df", "ln", "mkdir", "rm", "stat", "sync", "tail"]) {
    fs.symlink("/bin/coreutils", "/bin/" + command);
  }
  return fs.saveImage();
}

export const developmentInodeCapacityScript = String.raw`
set -eu
read -r filesystem files used free percent mount < <(/bin/df -Pi / | /bin/tail -n 1)
test "$files" -eq ${MAIN_SHELL_VFS_INODE_CAPACITY}
if test "$1" = create; then
    before=$free
    for ((bucket=0; bucket<60; bucket++)); do
        /bin/mkdir "/bucket-$bucket"
        for ((entry=0; entry<100; entry++)); do
            : > "/bucket-$bucket/entry-$entry"
        done
    done
    read -r filesystem files used free percent mount < <(/bin/df -Pi / | /bin/tail -n 1)
    test "$((before - free))" -eq 6060
    /bin/rm /bucket-0/entry-0
    read -r filesystem files used reclaimed percent mount < <(/bin/df -Pi / | /bin/tail -n 1)
    test "$((reclaimed - free))" -eq 1
    printf 'persistent file\n' > /bucket-0/replacement
    /bin/ln /bucket-0/replacement /bucket-0/alias
    /bin/sync
else
    test ! -e /bucket-0/entry-0
    test -e /bucket-59/entry-99
    test "$(< /bucket-0/alias)" = 'persistent file'
    test "$(/bin/stat -c %h /bucket-0/replacement)" -eq 2
fi
read -r filesystem files used free percent mount < <(/bin/df -Pi / | /bin/tail -n 1)
read -r filesystem kilobytes used free_kib percent mount < <(/bin/df -Pk / | /bin/tail -n 1)
test "$kilobytes" -eq ${MAIN_SHELL_VFS_PROFILE_MAX_BYTES / 1024}
test "$free_kib" -gt $((450 * 1024))
printf 'INODE_WORKLOAD_OK %s %s %s %s %s\n' "$1" "$files" "$free" "$free_kib" "$(/bin/stat -c %i /bucket-0/replacement)"
`;
