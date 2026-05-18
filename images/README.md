# Images

Filesystem image inputs and builders live here.

- `rootfs/` is the source tree for the base root filesystem.
- `vfs/scripts/` builds precomposed VFS images and archive assets used by the
  browser demos and package outputs.

The `tools/mkrootfs` CLI contains the reusable image builder implementation.
Scripts in this directory should compose package outputs into runtime images.
