import type { MountSpec } from "./default-mounts";

/**
 * Canonical product-manifest mount intent shared by protected Node and
 * browser consumers.
 */
export type VfsMountIntentV1 =
  | { source: "built-image"; path: string; readonly: boolean }
  | {
    source: "scratch";
    path: string;
    mode: string;
    uid: number;
    gid: number;
    ephemeral: boolean;
  };

/** Translate manifest-owned mount intent into the exact host mount contract. */
export function hostMountSpecFromProductMounts(
  mounts: readonly VfsMountIntentV1[],
): MountSpec[] {
  return mounts.map((mount) => mount.source === "built-image"
    ? {
      source: "image",
      path: mount.path,
      readonly: mount.readonly,
    }
    : {
      source: "scratch",
      path: mount.path,
      mode: Number.parseInt(mount.mode, 8),
      uid: mount.uid,
      gid: mount.gid,
      ephemeral: mount.ephemeral,
      nosuid: true,
    });
}
