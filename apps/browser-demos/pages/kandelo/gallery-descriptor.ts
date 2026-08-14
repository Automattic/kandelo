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
  const mounts = item.vfsImageUrl
    ? mountsWithRootImageUrl(base.mounts, item.vfsImageUrl)
    : base.mounts;
  const rootBoot = item.bootCommand[0] === "/sbin/dinit";
  const nodeBoot = item.id === "node";
  // WHY: a gallery switch changes runtime profiles. Carrying the previous
  // descriptor's environment into the next profile leaks Node npm settings
  // into Shell (or root service settings into user sessions). The live host
  // merges these identity overrides onto the selected profile's canonical
  // environment.
  const userEnv = nodeBoot
    ? { HOME: "/work", PWD: "/work", USER: "user", LOGNAME: "user" }
    : { HOME: "/home/user", USER: "user", LOGNAME: "user" };
  const rootEnv = { HOME: "/root", USER: "root", LOGNAME: "root" };
  return {
    ...base,
    id: item.id,
    title: item.title,
    packages: item.packages.slice(),
    mounts,
    boot: {
      ...base.boot,
      argv: item.bootCommand.slice(),
      cwd: item.cwd ?? (rootBoot ? "/root" : nodeBoot ? "/work" : "/home/user"),
      env: {
        ...(rootBoot ? rootEnv : userEnv),
        ...item.env,
      },
      uid: rootBoot ? 0 : 1000,
      gid: rootBoot ? 0 : 1000,
    },
  };
}
