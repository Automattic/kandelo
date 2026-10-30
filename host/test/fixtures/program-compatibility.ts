import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolveBinary } from "../../src/binary-resolver";
import { readWasmCustomSectionPayload } from "../../src/constants";
import { WPK_FORK_LINKED_FRAME_FORMAT_SECTION, WPK_FORK_LINKED_FRAME_FORMAT_VERSION } from "../../src/generated/abi";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";

const directory = new URL("../../../abi/program-fixtures/v55/", import.meta.url);
export const programCompatibilityManifest = JSON.parse(readFileSync(new URL("manifest.json", directory), "utf8")) as {
  fixtures: { name: string; file: string; size: number; sha256: string }[];
  preparationSource: { file: string; size: number; sha256: string };
};

function frozenBytes(record: { file: string; size: number; sha256: string }): Buffer {
  const bytes = readFileSync(new URL(record.file, directory));
  if (bytes.byteLength !== record.size || createHash("sha256").update(bytes).digest("hex") !== record.sha256) throw new Error(`Frozen program fixture changed: ${record.file}`);
  return bytes;
}

export function frozenPreparationSource(): Buffer {
  return frozenBytes(programCompatibilityManifest.preparationSource);
}

export function addInitialLaunchFixtures(image: KandeloImageFs, echo: Uint8Array): void {
  image.mkdir("/launch", 0o755);
  image.writeFile("/launch/echo-no-read", echo, 0o111);
  image.writeFile("/launch/not-executable", echo, 0o644);
  image.writeFile("/launch/script", new TextEncoder().encode("#!/bin/echo INITIAL_SCRIPT\n"), 0o755);
  image.writeFile("/launch/invalid", Uint8Array.of(0, 1, 2), 0o755);
}

export function addIncompatibleForkFixture(image: KandeloImageFs, source: Uint8Array): Uint8Array {
  const bytes = Uint8Array.from(source);
  const descriptor = readWasmCustomSectionPayload(bytes.buffer, WPK_FORK_LINKED_FRAME_FORMAT_SECTION);
  if (!descriptor || descriptor.length < 6) throw new Error("Missing frozen linked-frame descriptor");
  new DataView(descriptor.buffer, descriptor.byteOffset, descriptor.byteLength)
    .setUint16(4, WPK_FORK_LINKED_FRAME_FORMAT_VERSION + 1, true);
  image.writeFile("/launch/incompatible-fork", bytes, 0o755);
  return bytes;
}

export async function createProgramCompatibilityImage(): Promise<Uint8Array> {
  const image = KandeloImageFs.create();
  image.setImageCapacity(10 * 1024 ** 3);
  image.mkdir("/bin", 0o755);
  image.mkdir("/tmp", 0o1777);
  image.mkdir("/work", 0o700); image.chown("/work", 1000, 1000);
  image.mkdir("/work/temporary", 0o700); image.chown("/work/temporary", 1000, 1000);
  for (const program of ["wasm-fork-instrument", "wasm-opt"]) {
    image.writeFile(`/bin/${program}`, readFileSync(resolveBinary(`programs/${program}.wasm`)), 0o755);
  }
  image.writeFile("/bin/preparation-descriptors", readFileSync(new URL("program-preparation-descriptors.wasm", import.meta.url)), 0o755);
  for (const record of programCompatibilityManifest.fixtures) image.writeFile(`/bin/${record.name}`, frozenBytes(record), 0o755);
  addInitialLaunchFixtures(image, frozenBytes(programCompatibilityManifest.fixtures.find(record => record.name === "echo")!));
  addIncompatibleForkFixture(image, frozenBytes(programCompatibilityManifest.fixtures.find(record => record.name === "environment-lifecycle")!));
  image.writeFile("/work/input.wasm", frozenPreparationSource(), 0o755);
  image.chown("/work/input.wasm", 1000, 1000);
  return image.saveImage();
}
