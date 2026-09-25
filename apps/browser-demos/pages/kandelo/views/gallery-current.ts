// Which gallery row is the machine currently running.
//
// Extracted from Gallery.tsx so it can be tested without mounting React.

import type {
  BootDescriptor,
  GalleryItem,
} from "../../../../../web-libs/kandelo-session/src/kernel-host";

/**
 * Whether `item` is the machine the descriptor describes.
 *
 * A VFS image can declare several machines — `browser-main-shell` alone backs
 * shell, node, doom, modeset, sdl2, evdev and espeak — so sharing an image URL
 * does NOT make a row current. Identity is the machine, not the bytes.
 *
 * Two signals carry it. Once the image has been read, the descriptor's own id
 * is the booted machine's profile id (`descriptorForMachine`), which settles
 * it. Before that, `&profile=` from the URL is the only thing that names a
 * machine, so it decides. With neither, nothing is claimed rather than
 * guessing at one of the image's machines.
 */
export function galleryItemMatchesCurrent(
  item: GalleryItem,
  descriptor: BootDescriptor,
  descriptorVfsImageUrl: string | null,
  requestedProfileId: string | null,
): boolean {
  if (item.id === descriptor.id) return true;
  if (
    item.vfsImageUrl === undefined ||
    descriptorVfsImageUrl === null ||
    item.vfsImageUrl !== descriptorVfsImageUrl
  ) {
    return false;
  }
  return requestedProfileId !== null && item.id === requestedProfileId;
}
