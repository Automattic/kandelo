import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolveBinary } from "../../src/binary-resolver";
import { readWasmCustomSectionPayload } from "../../src/constants";
import { WPK_FORK_CONTRACT_SECTION, WPK_FORK_CONTRACT_VERSION, WPK_FORK_LINKED_FRAME_FORMAT_SECTION, WPK_FORK_LINKED_FRAME_FORMAT_VERSION } from "../../src/generated/abi";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";

const directory = new URL("../../../abi/program-fixtures/v55/", import.meta.url);
export const programCompatibilityManifest = JSON.parse(readFileSync(new URL("manifest.json", directory), "utf8")) as {
  fixtures: { name: string; file: string; size: number; sha256: string }[];
  preparationSource: { file: string; size: number; sha256: string };
  dynamicLinking: {
    program: { name: string; file: string; size: number; sha256: string };
    sideModule: { name: string; file: string; size: number; sha256: string };
  };
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

export const FROZEN_SIDE_MODULE_PATH = "/lib/hello-lib.so";
export const FROZEN_LAZY_EXECUTABLE_PATH = "/launch/lazy-echo";

/** The frozen echo body a lazy fixture serves; its digest is in the manifest. */
export function frozenEchoBytes(): Buffer {
  return frozenBytes(programCompatibilityManifest.fixtures.find(record => record.name === "echo")!);
}

export function addDynamicLinkingFixtures(image: KandeloImageFs): void {
  const { program, sideModule } = programCompatibilityManifest.dynamicLinking;
  image.mkdir("/lib", 0o755);
  image.writeFile(`/bin/${program.name}`, frozenBytes(program), 0o755);
  image.writeFile(FROZEN_SIDE_MODULE_PATH, frozenBytes(sideModule), 0o755);
}

export function addLazyExecutableFixture(image: KandeloImageFs, url: string): void {
  const echo = programCompatibilityManifest.fixtures.find(record => record.name === "echo")!;
  image.registerLazyFile(FROZEN_LAZY_EXECUTABLE_PATH, url, echo.size, 0o755, echo.sha256);
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

function uleb128(value: number): number[] {
  const bytes: number[] = [];
  do {
    const byte = value & 0x7f;
    value >>>= 7;
    bytes.push(value === 0 ? byte : byte | 0x80);
  } while (value !== 0);
  return bytes;
}

/** A copy of `source` as a later wasm-fork-instrument would stamp it. */
export function stampForkContract(source: Uint8Array, version: number = WPK_FORK_CONTRACT_VERSION + 1): Uint8Array {
  const name = new TextEncoder().encode(WPK_FORK_CONTRACT_SECTION);
  const payload = [...uleb128(name.length), ...name, version & 255, version >>> 8 & 255, version >>> 16 & 255, version >>> 24];
  return Uint8Array.from([...source, 0, ...uleb128(payload.length), ...payload]);
}

export async function createProgramCompatibilityImage(lazyEchoUrl: string): Promise<Uint8Array> {
  const image = KandeloImageFs.create();
  image.setImageCapacity(10 * 1024 ** 3);
  image.mkdir("/bin", 0o755);
  image.mkdir("/tmp", 0o1777);
  image.mkdir("/work", 0o700); image.chown("/work", 1000, 1000);
  image.mkdir("/work/temporary", 0o700); image.chown("/work/temporary", 1000, 1000);
  for (const program of ["wasm-fork-instrument", "wasm-opt"]) {
    image.writeFile(`/bin/${program}`, readFileSync(resolveBinary(`programs/${program}.wasm`)), 0o755);
  }
  for (const record of programCompatibilityManifest.fixtures) image.writeFile(`/bin/${record.name}`, frozenBytes(record), 0o755);
  addInitialLaunchFixtures(image, frozenBytes(programCompatibilityManifest.fixtures.find(record => record.name === "echo")!));
  addIncompatibleForkFixture(image, frozenBytes(programCompatibilityManifest.fixtures.find(record => record.name === "environment-lifecycle")!));
  addDynamicLinkingFixtures(image);
  addLazyExecutableFixture(image, lazyEchoUrl);
  image.writeFile("/work/input.wasm", frozenPreparationSource(), 0o755);
  image.chown("/work/input.wasm", 1000, 1000);
  return image.saveImage();
}
