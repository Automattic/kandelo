// Why a load failed, in words a person can act on.
//
// The three reading verbs — `inspect`, `extract`, `add` — load an image with
// `KandeloImageFs`, which is the KERNEL's loader. That is the point of the
// repoint: one reader, so the CLI cannot see an image differently from the
// system that runs it. It also means the verbs inherit the loader's contract,
// and one clause of it is not a corruption check.
//
// `EPROTO` means the image declares a kernel ABI this reader does not speak.
// The image is INTACT — it was built correctly, for a different kernel. An
// image is a product artifact with a long life, written to `local-binaries/`
// and surviving every `ABI_VERSION` bump after it, so meeting one is the
// ordinary consequence of not rebuilding. Reporting that as "not a valid VFS
// image" would send the reader looking for corruption that is not there, and
// the ABI contract asks for the opposite: a stale artifact should fail loudly
// AS stale and be rebuilt through the normal path.
//
// The numbers are not here to report. `sm_load_image` returns an errno and has
// no channel for the declared and expected versions; reading the declared one
// would mean loading the image, which is the thing that just refused. So this
// names the kind of mismatch and the action, and does not invent a number it
// cannot see.

import { ERRNO } from "../../../../host/src/generated/abi.ts";

export function describeImageLoadFailure(error: unknown, image: string): string {
  if ((error as { errno?: number } | null)?.errno === ERRNO.EPROTO) {
    return `${image} was built for a different kernel ABI than this mkrootfs reads `
      + `with. The image is intact; it is stale. Rebuild it with \`mkrootfs build\`.`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return `not a valid VFS image (${image}): ${message}`;
}
