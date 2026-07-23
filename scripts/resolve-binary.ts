import { resolveBinary } from "../host/src/binary-resolver";

const [relPath, ...extra] = process.argv.slice(2);
if (!relPath || extra.length > 0) {
  console.error("usage: scripts/resolve-binary.sh <resolver-relative-path>");
  process.exit(2);
}

try {
  process.stdout.write(`${resolveBinary(relPath)}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
