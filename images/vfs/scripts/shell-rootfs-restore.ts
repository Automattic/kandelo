import { SffsImageFs } from "../lib/sffs-image-fs";

/**
 * Load the shell's base rootfs image as a filesystem the build may mutate.
 *
 * The name promises that what comes back is TRUSTED, and the load is what
 * makes that true: verification runs inside the module's `sm_load_image`, so
 * an image that reached the return statement is one whose activation cohorts
 * authenticated. There is no window in which an unverified image is loaded,
 * and no second call for a caller to forget -- which is what this function
 * used to be, a wrapper whose whole body was "import, then remember to
 * verify".
 *
 * WHY it still exists: every shell resolver, registration, mutation and save
 * happens after this boundary, so the boundary is worth naming even now that
 * it is one call wide.
 */
export function restoreTrustedShellRootfs(
  image: Uint8Array,
  maxByteLength: number,
): SffsImageFs {
  const fs = SffsImageFs.create();
  fs.loadImage(image);
  // A capacity request the export reads, not a size the tree is poured into.
  fs.setImageCapacity(maxByteLength);
  return fs;
}
