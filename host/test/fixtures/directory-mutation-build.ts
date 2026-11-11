import { readFileSync } from "node:fs";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";
import { tryResolveBinary } from "../../src/binary-resolver";
import { compileSdkFixture } from "../support/compile-sdk-fixture";

export const directoryMutationKernel = process.env.KANDELO_DIRECTORY_MUTATION_KERNEL ?? tryResolveBinary("kernel.wasm");
if (!directoryMutationKernel && process.env.KANDELO_REQUIRE_DIRECTORY_MUTATION === "1") {
  throw new Error("Build the current kernel before directory mutation acceptance");
}

export async function createDirectoryMutationFixture() {
  const program = compileSdkFixture(new URL("./directory-mutation.c", import.meta.url));
  try {
    const fs = KandeloImageFs.create();
    fs.setImageCapacity(64 * 1024 ** 2);
    for (const path of ["/usr", "/usr/bin", "/work", "/tmp"]) fs.mkdir(path, path === "/tmp" ? 0o1777 : 0o755);
    fs.chown("/work", 1000, 1000);
    fs.writeFile("/usr/bin/directory-mutation", readFileSync(program.programPath), 0o755);
    return { image: await fs.saveImage({ normalizeTimestampsMs: 0 }), cleanup: program.cleanup };
  } catch (error) { program.cleanup(); throw error; }
}
