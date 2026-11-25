import { existsSync, statSync } from "node:fs";
import { browserRootfsCandidates } from "../host/src/browser-rootfs-candidates";
import {
  hasBinaryCandidate,
  resolveBinary,
  sourceOnlyBinaryRoot,
  tryResolveBinaries,
} from "../host/src/binary-resolver";

// One path, or several in one call. Several share ONE freshness check of the
// program-package projection (`tryResolveBinaries`), which is what lets a
// build tool that needs every output of an image (the rootfs manifest
// generator) ask the resolver once instead of paying the check per output.
// Each answer is printed on its own line, in request order.
const relPaths = process.argv.slice(2);
if (relPaths.length === 0) {
  console.error("usage: scripts/resolve-binary.sh <resolver-relative-path>...");
  process.exit(2);
}

try {
  if (relPaths[0] === "--check-candidates") {
    const requests = relPaths.slice(1);
    if (!requests.length || !requests.some(hasBinaryCandidate)) {
      throw new Error(`No artifact candidate for ${requests.join(" or ")}`);
    }
    process.exit(0);
  }
  if (relPaths[0] === "--browser-rootfs") {
    const rootfs = sourceOnlyBinaryRoot() === null
      ? browserRootfsCandidates(process.cwd()).find(existsSync)
      : resolveBinary("programs/wasm32/rootfs.vfs.zst");
    if (!rootfs || !statSync(rootfs).isFile()) {
      throw new Error("Browser rootfs.vfs.zst is missing");
    }
    process.stdout.write(`${rootfs}\n`);
    process.exit(0);
  }
  const resolved = relPaths.length === 1
    ? [resolveBinary(relPaths[0]!)]
    : tryResolveBinaries(relPaths).map((path, index) =>
      // A miss in the batch is re-asked singly, so it fails with the
      // resolver's own explanation (which tiers were checked, and why each
      // candidate was refused) instead of a bare "not found".
      path ?? resolveBinary(relPaths[index]!)
    );
  process.stdout.write(`${resolved.join("\n")}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
