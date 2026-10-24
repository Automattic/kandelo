import {
  SHELL_LAZY_BINARY_SPECS,
  shellLazyPlaceholderUrl,
} from "../../../../images/vfs/lib/init/shell-binaries";

import { SHELL_LAZY_ASSET_URLS } from "./generated/shell-lazy-asset-urls";

export const SHELL_LAZY_PLACEHOLDER_URLS = new Map(
  SHELL_LAZY_BINARY_SPECS.map((spec) => {
    const url = SHELL_LAZY_ASSET_URLS[spec.resolverPath];
    // A spec added without regenerating the table would otherwise map its
    // placeholder to nothing and 404 on first read.
    if (url === undefined) {
      throw new Error(
        `no browser URL for shell lazy file ${spec.resolverPath}; regenerate ` +
          "with scripts/generate-browser-lazy-asset-urls.ts",
      );
    }
    return [shellLazyPlaceholderUrl(spec), url];
  }),
);

// `SHELL_LAZY_PLACEHOLDER_URLS` is the whole of what this module contributes:
// a table from the placeholder URL an image records to the asset URL this
// build serves. The image is never rewritten with it; the deployment applies
// it when the kernel worker fetches deferred bytes
// (`imageOwnedRuntimeUrlTable`).
