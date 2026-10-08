import { tryResolveBinary } from "../../src/binary-resolver";
import type { ResolvedRootfsArtifact } from "../../src/node-kernel-host";

/**
 * The default rootfs image as the binary resolver finds it -- the same two
 * requests, in the same order, that `resolveRootfsArtifact` (what the Node
 * host boots for `rootfsImage: "default"`) tries -- or `null` when neither is
 * present, so a test can skip instead of failing on an unbuilt tree.
 *
 * A present-but-rejected artifact still throws, as `tryResolveBinary` does:
 * a stale or policy-refused image is a failure to report, not a reason to
 * skip.
 */
export function tryResolveRootfsArtifact(): ResolvedRootfsArtifact | null {
  for (
    const resolverRequest of ["rootfs.vfs.zst", "programs/rootfs.vfs.zst"] as const
  ) {
    const selectedPath = tryResolveBinary(resolverRequest);
    if (selectedPath !== null) return { resolverRequest, selectedPath };
  }
  return null;
}
