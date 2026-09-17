/**
 * A `RootfsOverlayBaseImage` backed by the Rust module instead of
 * `MemoryFileSystem`.
 *
 * # Where each half comes from, and why
 *
 * The deferred BYTES come from the module: it holds the image and serves any
 * offset, which is what `open`/`read`/`close` and the image window need.
 *
 * The lazy METADATA comes from the module too, and that is a change. It used
 * to come from the container's host-side JSON sections, because `KLZY` carries
 * no fetch description — a parity test established that the hard way by
 * returning empty URLs for every entry. Those sections have no producer any
 * more: every builder writes the image's own `SDEF` section instead, where the
 * address is a typed field the kernel itself reads.
 *
 * SO THE SECTION-READING HALF IS GONE, 2026-09-17, and with it the structural
 * readers, the JSON decode, and the three container-section helpers it
 * imported. What is left is one path: ask the module. A caller that passes no
 * module gets nothing, which is the truthful answer to "what does this
 * container say about its deferred files" from a reader that has asked nobody.
 */
import { resolveLazyUrl } from "./lazy-url";
import type { DeferredBody, RootfsOverlayBaseImage } from "./rootfs-lazy-archives";

/** What `KandeloImageFs.lazyEntries()` answers, named so this file need not import it. */
export interface ModuleLazyEntries {
  files: readonly {
    path: string;
    ino: bigint;
    size: number;
    archiveId: number;
    sourcePath: string;
    /** Where a standalone file's bytes are; empty for an archive member. */
    uri: string;
    digest: Uint8Array;
  }[];
  archives: readonly {
    archiveId: number;
    bytes: number;
    descriptor: Uint8Array;
    /** Where the archive is; the kernel relays it. */
    uri: string;
    /** What its bytes must hash to; 32 zero bytes when none was declared. */
    digest: Uint8Array;
  }[];
}

/** A 32-byte SHA-256 as hex: the image stores a value, the host speaks hex. */
function bytesToSha256Hex(digest: Uint8Array): string {
  let out = "";
  for (const byte of digest) out += byte.toString(16).padStart(2, "0");
  return out;
}

// THE SEAL-PAYLOAD UNWRAPPER IS GONE, and so is the reason it existed.
//
// The module wraps every archive payload as
// `u32 version | u32 descriptor_len | descriptor | u8 has_seal | [seal]`
// (`seal::encode`). This file opened that envelope to JSON-parse the
// descriptor for one field, `mountPrefix` — the only field it could not read
// as a typed value — and nothing downstream ever read the result. With the
// record reduced to what a host acts on, a boot no longer opens an opaque
// blob at all: the address, the length and the digest are typed fields the
// module hands over, and the seal half is authenticated in the loader by
// `rootfs::load_image` rather than inspected here.


/**
 * Build the overlay's base image from the container and a reader for its bytes.
 *
 * There is no filesystem here, and no module interface either. Metadata is
 * decoded from `container`'s own host-side JSON sections, and `imageRead`
 * answers container-offset reads however its owner likes: from the container
 * array itself via `imageReadFromContainer`, or through the wasm bridge's
 * `sm_image_read`, which is a one-line adapter because the coordinates already
 * agree.
 */
export function createBaseImageFromContainer(
  container: Uint8Array,
  imageRead: (at: number, dest: Uint8Array) => number,
  /**
   * The deployment's base path for relative lazy URLs, applied on the way OUT.
   *
   * Applying it here rather than mutating a stored record is what lets the
   * image stay one artifact: `lazyUrlBase` defaults to the site's `BASE_URL`,
   * so the same bytes are served from `/` in dev and from `/kandelo/` in an
   * assembled-site preview. Rewriting on read-out costs nothing and
   * invalidates nothing — V3 deliberately excludes transport locations from
   * descriptor identity, in its own words *"because image composition rewrites
   * mirrors after sealing"*, so no digest covers the string being changed.
   */
  lazyUrlBase?: string,
  /**
   * Where the lazy metadata lives: the module that holds the loaded image.
   *
   * THE OTHER BRANCH IS GONE, 2026-09-17, with the producer that fed it. A
   * `MemoryFileSystem`-built image recorded a deferred URL in host-side JSON
   * sections; a module-built image records it in the image's own `SDEF`
   * section and writes no JSON sections at all. Every builder writes the
   * second kind now, so reading the sections returned an empty list for every
   * shipped image — and this argument is the only way to get an answer.
   *
   * OMITTING IT IS STILL LEGAL AND STILL ANSWERS NOTHING, which is what both
   * worker entries do today: a boot then holds no transport policy and fetches
   * each address as the image wrote it. That is the courier contract working
   * rather than a gap — but it means the declared LENGTH of an archive goes
   * unchecked by the host, and the check that remains is the kernel's digest
   * on materialization. Closing that is a boot-path change (a browser worker
   * would have to hold the image module's bytes), recorded in the master plan
   * rather than smuggled in here.
   */
  moduleLazyEntries?: () => ModuleLazyEntries,
): { baseImage: RootfsOverlayBaseImage; imageRead: (at: number, dest: Uint8Array) => number } {
  const fromModule = moduleLazyEntries?.();

  // No open/read/close. The overlay used to pull deferred bytes THROUGH this
  // object; it now fetches them itself, so what remains is the metadata the
  // image declared — which is the only part the module was ever authoritative
  // about anyway.
  const rebaseUrl = (url: string): string =>
    lazyUrlBase === undefined ? url : resolveLazyUrl(lazyUrlBase, url);

  const baseImage: RootfsOverlayBaseImage = {
    deferredFiles: () => {
      if (fromModule !== undefined) {
        // `archiveId === 0` is the STANDALONE registration: no archive behind
        // it, so `uri` is the whole of what says where the bytes are.
        return fromModule.files
          .filter((file) => file.archiveId === 0)
          .map((file) => ({
            address: rebaseUrl(file.uri),
            transports: [rebaseUrl(file.uri)],
            bytes: file.size,
            sha256: undefined,
          }));
      }
      // NO MODULE, NO ANSWER — and that is the truthful one. The image's
      // deferred description lives in its own `SDEF` section, which only the
      // module reads; a caller that did not pass one is holding a container it
      // has asked nobody about.
      return [];
    },
    deferredArchives: () => {
      if (fromModule !== undefined) {
        return fromModule.archives.map((archive) => {
          // Read as FIELDS, not parsed back out of the descriptor: they were
          // in there only because the format had nowhere typed to put them, so
          // this reader had to open a blob the format says nobody opens — on
          // untrusted input, since an image can arrive from a shared link.
          //
          // NO DESCRIPTOR PARSE AT ALL NOW. It survived here to recover a
          // `mountPrefix` for the legacy record's shape; nothing downstream
          // ever read that field, so a boot no longer JSON-parses an opaque
          // blob to fill a slot nobody looks in.
          if (archive.uri === "") {
            throw new Error(
              `VFS image lazy archive ${archive.archiveId} declares no address, `
                + "so there is nothing that says where its bytes come from.",
            );
          }
          const address = rebaseUrl(archive.uri);
          const declared = archive.digest.length === 32
            && archive.digest.some((byte) => byte !== 0);
          return {
            address,
            transports: [address],
            bytes: declared ? archive.bytes : undefined,
            sha256: declared ? bytesToSha256Hex(archive.digest) : undefined,
          };
        });
      }
      return [];
    },
  };

  return { baseImage, imageRead };
}
