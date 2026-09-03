import type {
  BootDescriptor,
  GalleryItem,
} from "../../../../web-libs/kandelo-session/src/kernel-host";
import { mountsWithRootImageUrl } from "./url-state";

/**
 * Apply a gallery profile to the current machine descriptor.
 */
export function descriptorFromGalleryItem(
  item: GalleryItem,
  base: BootDescriptor,
): BootDescriptor {
  const rootMounts = item.vfsImageUrl
    ? mountsWithRootImageUrl(base.mounts, item.vfsImageUrl)
    : base.mounts;
  // WHY: browser-storage mounts are per-machine opt-ins. Carrying the
  // previous machine's opfs workspace into the next profile would silently
  // attach its persistent data (and its exclusive workspace lock) to a
  // machine that never asked for it.
  const mounts = [
    ...rootMounts.filter((m) => m.source !== "opfs"),
    ...(item.mounts ?? []),
  ];
  const rootBoot = item.bootCommand[0] === "/sbin/dinit";
  const nodeBoot = item.id === "node";
  // WHY: a gallery switch changes runtime profiles. Carrying the previous
  // descriptor's environment into the next profile leaks Node npm settings
  // into Shell (or root service settings into user sessions). The live host
  // merges these identity overrides onto the selected profile's canonical
  // environment.
  const makerEnv = nodeBoot
    ? {
        HOME: "/home/maker",
        PWD: "/home/maker",
        USER: "maker",
        LOGNAME: "maker",
      }
    : { HOME: "/home/maker", USER: "maker", LOGNAME: "maker" };
  const rootEnv = { HOME: "/root", USER: "root", LOGNAME: "root" };
  return {
    ...base,
    id: item.id,
    title: item.title,
    packages: item.packages,
    mounts,
    boot: {
      ...base.boot,
      argv: item.bootCommand,
      cwd: rootBoot ? "/root" : "/home/maker",
      env: rootBoot ? rootEnv : makerEnv,
      uid: rootBoot ? 0 : 1000,
      gid: rootBoot ? 0 : 1000,
    },
  };
}
