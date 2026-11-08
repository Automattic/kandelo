import { parsePartialImageManifest } from "../../vite/dev-partial-image.ts";

export function partialLibrarySelection(
  profileId: string,
  pageUrl: string,
  manifestText: string | undefined,
  preparedUrlsText: string | undefined,
): { imageId: string; imageUrl: string; sha256: string; bytes: number } | null {
  if (manifestText === undefined) return null;
  if (preparedUrlsText === undefined) throw new Error("partial Library opt-in requires KANDELO_TEST_MACHINE_URLS");
  const manifest = parsePartialImageManifest(manifestText);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(manifest.image)
      || manifest.file !== `${manifest.image}-partial.vfs.zst`) throw new Error("partial Library manifest image/file mismatch");
  if (!manifest.activities.includes(profileId)
      || manifest.excludedActivities.some(entry => entry.profile === profileId)) {
    throw new Error(`partial Library manifest does not admit profile ${profileId}`);
  }
  const prepared: unknown = JSON.parse(preparedUrlsText);
  if (typeof prepared !== "object" || prepared === null || Array.isArray(prepared)
      || !(profileId in prepared)) throw new Error(`prepared machine URLs lack profile ${profileId}`);
  const selected = Object.getOwnPropertyDescriptor(prepared, profileId)?.value;
  if (typeof selected !== "string") throw new Error(`invalid prepared machine URL for ${profileId}`);
  const machine = new URL(selected), page = new URL(pageUrl);
  if (!/^https?:$/.test(machine.protocol) || machine.origin !== page.origin
      || machine.searchParams.get("profile") !== profileId || !machine.searchParams.get("vfs")) {
    throw new Error(`invalid prepared machine URL for ${profileId}`);
  }
  const image = new URL(machine.searchParams.get("vfs")!, machine);
  // An opt-in may select only the actual dev-partial route. Otherwise an
  // absent partial row could silently turn this run into canonical evidence.
  if (image.origin !== page.origin || !image.pathname.endsWith("/@kandelo-partial/image.vfs.zst")
      || image.search || image.hash || image.username || image.password) {
    throw new Error(`prepared image is not the partial route for ${profileId}`);
  }
  return { imageId: `partial-${manifest.image}`, imageUrl: image.href,
    sha256: manifest.sha256, bytes: manifest.bytes };
}
