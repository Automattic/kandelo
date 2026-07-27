import {
  MemoryFileSystem,
  type SerializedLazyArchiveEntry,
} from "../src/vfs/memory-fs";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export type LazyAtomicSealForgery = "member" | "cohort";

/**
 * Add one inert first-use tree whose only purpose is to exercise imported v3
 * atomic-seal trust boundaries without downloading an archive.
 */
export async function addSealedLazyAtomicTestTree(
  fs: MemoryFileSystem,
  options: {
    groupId: string;
    member: string;
    root: string;
  },
): Promise<void> {
  const path = `${options.root}/tool`;
  fs.registerLazyTree(
    {
      decoder: "zip-v1",
      mediaType: "application/zip",
      sha256: "1".repeat(64),
      bytes: 1,
      expandedBytes: 1,
      sourceEntryCount: 1,
      transports: ["https://example.invalid/sealed-atomic-test-tree.zip"],
    },
    [{
      vfsPath: path,
      sourcePath: "tool",
      type: "file",
      mode: 0o755,
      size: 1,
      inodeGroup: `${options.groupId}:${options.member}`,
    }],
    options.root,
    {
      mode: "first-use",
      capabilities: [`test:${options.member}`],
      roots: [path],
      atomicGroup: {
        id: options.groupId,
        member: options.member,
      },
    },
    { uid: 0, gid: 0 },
  );
  await fs.sealLazyAtomicGroup(options.groupId, [options.member]);
}

/**
 * Rewrite only the serialized seal claim. The filesystem body and lazy member
 * descriptor remain unchanged, so consumers must detect the forgery by hashing
 * the imported v3 metadata rather than by ordinary structural validation.
 */
export function forgeLazyAtomicSeal(
  image: Uint8Array,
  forgery: LazyAtomicSealForgery,
): Uint8Array {
  const archiveOffset = lazyArchiveMetadataOffset(image);
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  const oldLength = view.getUint32(archiveOffset, true);
  const suffixOffset = archiveOffset + 4 + oldLength;
  const entries = JSON.parse(
    decoder.decode(image.subarray(archiveOffset + 4, suffixOffset)),
  ) as SerializedLazyArchiveEntry[];
  const entry = entries.find((candidate) =>
    candidate.kind === "kandelo-deferred-tree-v3" &&
    candidate.activation?.atomicGroup !== undefined
  );
  const atomicGroup = entry?.activation?.atomicGroup;
  if (
    atomicGroup === undefined ||
    atomicGroup.descriptorSha256 === undefined ||
    atomicGroup.cohortSha256 === undefined
  ) {
    throw new Error("test image has no sealed v3 lazy atomic member");
  }
  const field = forgery === "member" ? "descriptorSha256" : "cohortSha256";
  atomicGroup[field] = atomicGroup[field] === "f".repeat(64)
    ? "e".repeat(64)
    : "f".repeat(64);

  const json = encoder.encode(JSON.stringify(entries));
  const replaced = new Uint8Array(
    archiveOffset + 4 + json.byteLength + image.byteLength - suffixOffset,
  );
  replaced.set(image.subarray(0, archiveOffset), 0);
  new DataView(replaced.buffer).setUint32(archiveOffset, json.byteLength, true);
  replaced.set(json, archiveOffset + 4);
  replaced.set(image.subarray(suffixOffset), archiveOffset + 4 + json.byteLength);
  return replaced;
}

function lazyArchiveMetadataOffset(image: Uint8Array): number {
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  const sharedBufferLength = view.getUint32(12, true);
  const lazyFileOffset = 16 + sharedBufferLength;
  const lazyFileLength = view.getUint32(lazyFileOffset, true);
  return lazyFileOffset + 4 + lazyFileLength;
}
