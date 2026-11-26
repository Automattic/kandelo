import { readFileSync } from "node:fs";
import { resolveBinary } from "../../src/binary-resolver";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";
import { compileSdkFixture } from "./compile-sdk-fixture";

export async function indirectCallTrapImage(): Promise<Uint8Array> {
  const image = KandeloImageFs.create();
  image.mkdir("/bin", 0o755);
  const { programPath, cleanup } = compileSdkFixture(
    new URL("../fixtures/indirect-call-trap.c", import.meta.url),
  );
  try {
    image.writeFile("/bin/indirect-call-trap-test", readFileSync(programPath), 0o755);
  } finally {
    cleanup();
  }
  image.writeFile(
    "/bin/dmesg",
    readFileSync(resolveBinary("programs/toybox/dmesg.wasm")),
    0o755,
  );
  return image.saveImage();
}
