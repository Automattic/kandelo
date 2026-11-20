import type { StoredComputer } from "../../../../../web-libs/kandelo-session/src/computer-library";
import type { DeloImage } from "./registry";
import {
  computerUrl,
  normalizeVfsImageUrl,
  PROFILE_QUERY_PARAM,
  VFS_IMAGE_QUERY_PARAM,
  vfsImageUrlFromDescriptor,
} from "../../kandelo/url-state";

/**
 * The URL `delo run` opens for a registered image: the delo computer page
 * `computer/?vfs=<image>&profile=<id>`, the same pair the gallery's Launch
 * writes. `pageHref` is the delo page the command was typed on.
 */
export function deloRunUrl(entry: DeloImage, pageHref: string): string {
  const url = new URL("computer/", pageHref);
  url.searchParams.set(VFS_IMAGE_QUERY_PARAM, entry.vfs);
  url.searchParams.set(PROFILE_QUERY_PARAM, entry.profile);
  return url.href;
}

/** The URL `delo run <url>` opens for an image no registry entry names:
 *  `computer/?vfs=<url>` with no profile, so the image's own
 *  `/etc/kandelo/demo.json` picks its default machine. Null when `name` is
 *  not an absolute http or https URL. */
export function deloImageRunUrl(name: string, pageHref: string): string | null {
  if (!/^https?:\/\//i.test(name)) return null;
  const vfs = normalizeVfsImageUrl(name, pageHref);
  if (vfs === null) return null;
  const url = new URL("computer/", pageHref);
  url.searchParams.set(VFS_IMAGE_QUERY_PARAM, vfs);
  return url.href;
}

/** The URL `delo run` opens for a stored computer: the delo computer page
 *  at `computer/?computer=<id>`. */
export function deloComputerUrl(id: string, pageHref: string): string {
  return computerUrl(id, new URL("computer/", pageHref).href);
}

/** The name the delo page gives a stored computer that boots an image URL:
 *  the registered image with the same URL and profile, else the image's own
 *  title. Null for a computer that boots no image URL. */
export function deloImageOf(images: readonly DeloImage[], computer: Pick<StoredComputer, "descriptor" | "profileId">, pageHref: string): string | null {
  const url = vfsImageUrlFromDescriptor(computer.descriptor, pageHref);
  if (url === null) return null;
  const entry = images.find((image) => image.profile === computer.profileId && normalizeVfsImageUrl(image.vfs, pageHref) === url);
  return entry?.name ?? computer.descriptor.title;
}
