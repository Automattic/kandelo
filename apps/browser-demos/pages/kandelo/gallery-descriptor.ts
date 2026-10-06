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
  // WHY: `item.bootCommand` is display-only gallery metadata (the roster's
  // preview of what the image runs). BOOT IDENTITY COMES FROM THE IMAGE, so
  // it is never assigned onto `boot.argv` here — the receiving boot ignores
  // any caller-supplied argv anyway and always runs the target image's own
  // declared init. `item.bootCommand` is still consulted below only as a
  // signal for which HOME/uid a root-style vs. maker-style profile switch
  // should carry, not as the program that will actually run.
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
      cwd: rootBoot ? "/root" : "/home/maker",
      env: rootBoot ? rootEnv : makerEnv,
      uid: rootBoot ? 0 : 1000,
      gid: rootBoot ? 0 : 1000,
    },
  };
}
