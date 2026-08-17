import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { extractAbiVersion } from "../src/constants";
import { ABI_VERSION } from "../src/generated/abi";

const FIXTURE_INPUT_SECTION = "kandelo.test_fixture.inputs";
const FIXTURE_FINGERPRINT_SCHEMA = "kandelo-test-fixture-inputs-v1";

export interface ProgramFixtureBuildContract {
  readonly repoRoot: string;
  readonly inputFingerprint: string;
}

interface InputRecord {
  readonly name: string;
  readonly kind: "file" | "symlink";
  readonly bytes: Uint8Array;
}

function relativeInputName(repoRoot: string, path: string): string {
  const name = relative(resolve(repoRoot), resolve(path));
  if (
    name === ""
    || name === ".."
    || name.startsWith(`..${sep}`)
    || isAbsolute(name)
  ) {
    throw new Error(`fixture build input is outside the repository: ${path}`);
  }
  return name.split(sep).join("/");
}

function collectInputRecords(
  repoRoot: string,
  path: string,
  records: Map<string, InputRecord>,
  activeDirectories: Set<string>,
): void {
  const name = relativeInputName(repoRoot, path);
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink()) {
    records.set(`${name}\0link`, {
      name,
      kind: "symlink",
      bytes: Buffer.from(readlinkSync(path)),
    });
    const followed = statSync(path);
    if (followed.isFile()) {
      records.set(`${name}\0file`, {
        name,
        kind: "file",
        bytes: readFileSync(path),
      });
      return;
    }
    if (!followed.isDirectory()) return;
  } else if (metadata.isFile()) {
    records.set(`${name}\0file`, {
      name,
      kind: "file",
      bytes: readFileSync(path),
    });
    return;
  } else if (!metadata.isDirectory()) {
    return;
  }

  // WHY: sysroots may contain directory symlinks. Guard the followed identity,
  // not its logical spelling, so a recursive symlink fails closed instead of
  // walking forever.
  const directoryIdentity = realpathSync(path);
  if (activeDirectories.has(directoryIdentity)) {
    throw new Error(`recursive fixture build-input directory: ${path}`);
  }
  activeDirectories.add(directoryIdentity);
  try {
    for (const entry of readdirSync(path).sort()) {
      collectInputRecords(
        repoRoot,
        join(path, entry),
        records,
        activeDirectories,
      );
    }
  } finally {
    activeDirectories.delete(directoryIdentity);
  }
}

function updateFramed(
  hash: ReturnType<typeof createHash>,
  value: string | Uint8Array,
): void {
  const bytes = typeof value === "string" ? Buffer.from(value) : value;
  hash.update(String(bytes.byteLength));
  hash.update(":");
  hash.update(bytes);
}

/**
 * Capture the exact compiler/sysroot/glue input state shared by a family of
 * fixtures. The returned digest is content-based; touching an old output or
 * preserving an ABI number cannot make it current.
 */
export function captureProgramFixtureBuildContract(
  repoRoot: string,
  identity: string,
  inputPaths: readonly string[],
): ProgramFixtureBuildContract {
  const resolvedRepoRoot = resolve(repoRoot);
  const records = new Map<string, InputRecord>();
  for (const path of inputPaths) {
    collectInputRecords(resolvedRepoRoot, path, records, new Set());
  }
  const hash = createHash("sha256");
  // Bump this schema if the framing or record semantics change.
  updateFramed(hash, FIXTURE_FINGERPRINT_SCHEMA);
  updateFramed(hash, identity);
  for (const record of Array.from(records.values()).sort((left, right) =>
    left.name.localeCompare(right.name) || left.kind.localeCompare(right.kind)
  )) {
    updateFramed(hash, record.kind);
    updateFramed(hash, record.name);
    updateFramed(hash, record.bytes);
  }
  return {
    repoRoot: resolvedRepoRoot,
    inputFingerprint: hash.digest("hex"),
  };
}

function fixtureAbiVersion(path: string): number | null {
  try {
    const bytes = readFileSync(path);
    const exact = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    return extractAbiVersion(exact);
  } catch {
    return null;
  }
}

function readUleb(
  bytes: Uint8Array,
  offset: number,
): { value: number; next: number } | null {
  let value = 0;
  let shift = 0;
  for (let index = offset; index < bytes.byteLength && shift <= 28; index++) {
    const byte = bytes[index]!;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) {
      return { value, next: index + 1 };
    }
    shift += 7;
  }
  return null;
}

function fixtureInputFingerprint(path: string): string | null {
  try {
    const bytes = readFileSync(path);
    if (
      bytes.byteLength < 8
      || !bytes.subarray(0, 4).equals(Buffer.from([0, 0x61, 0x73, 0x6d]))
    ) {
      return null;
    }
    const matches: string[] = [];
    let offset = 8;
    while (offset < bytes.byteLength) {
      const sectionId = bytes[offset++]!;
      const size = readUleb(bytes, offset);
      if (!size) return null;
      offset = size.next;
      const end = offset + size.value;
      if (end > bytes.byteLength) return null;
      if (sectionId === 0) {
        const nameLength = readUleb(bytes, offset);
        if (!nameLength) return null;
        const nameStart = nameLength.next;
        const nameEnd = nameStart + nameLength.value;
        if (nameEnd > end) return null;
        const name = bytes.subarray(nameStart, nameEnd).toString("utf8");
        if (name === FIXTURE_INPUT_SECTION) {
          matches.push(bytes.subarray(nameEnd, end).toString("ascii"));
        }
      }
      offset = end;
    }
    return matches.length === 1 && /^[0-9a-f]{64}$/.test(matches[0]!)
      ? matches[0]!
      : null;
  } catch {
    return null;
  }
}

function expectedFixtureFingerprint(
  sourcePath: string,
  contract: ProgramFixtureBuildContract,
): string {
  const hash = createHash("sha256");
  updateFramed(hash, contract.inputFingerprint);
  updateFramed(hash, relativeInputName(contract.repoRoot, sourcePath));
  updateFramed(hash, readFileSync(sourcePath));
  return hash.digest("hex");
}

function encodeUleb(value: number): Uint8Array {
  const bytes: number[] = [];
  do {
    let byte = value & 0x7f;
    value = Math.floor(value / 128);
    if (value > 0) byte |= 0x80;
    bytes.push(byte);
  } while (value > 0);
  return Uint8Array.from(bytes);
}

/** Append the exact input digest to a freshly compiled fixture. */
export function stampProgramFixture(
  sourcePath: string,
  outputPath: string,
  contract: ProgramFixtureBuildContract,
): void {
  const name = Buffer.from(FIXTURE_INPUT_SECTION);
  const fingerprint = Buffer.from(
    expectedFixtureFingerprint(sourcePath, contract),
    "ascii",
  );
  const payloadLength = encodeUleb(name.byteLength);
  const payload = Buffer.concat([payloadLength, name, fingerprint]);
  appendFileSync(
    outputPath,
    Buffer.concat([
      Buffer.from([0]),
      encodeUleb(payload.byteLength),
      payload,
    ]),
  );
}

/**
 * Decide whether a compiled C fixture represents its source, actual linked
 * sysroot/glue/compiler inputs, and current process ABI.
 */
export function programFixtureNeedsRebuild(
  sourcePath: string,
  outputPath: string,
  contract: ProgramFixtureBuildContract,
): boolean {
  if (!existsSync(outputPath)) return true;
  if (fixtureAbiVersion(outputPath) !== ABI_VERSION) return true;
  return fixtureInputFingerprint(outputPath)
    !== expectedFixtureFingerprint(sourcePath, contract);
}
