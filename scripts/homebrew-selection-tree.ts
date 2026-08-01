import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MAX_SELECTION_FILES = 8192;
const MAX_SELECTION_TREE_BYTES = 512 * 1024 * 1024;

function gitObjectId(kind: "blob" | "tree", bytes: Uint8Array): Buffer {
  const header = Buffer.from(`${kind} ${bytes.byteLength}\0`, "ascii");
  return createHash("sha1").update(header).update(bytes).digest();
}

export function filesystemGitTreeOid(root: string): string {
  let fileCount = 0;
  let totalBytes = 0;

  const visit = (directory: string): Buffer => {
    const entries = readdirSync(directory).map((name) => {
      if (
        name === ".git" ||
        name.length === 0 ||
        !/^[\x20-\x7e]+$/.test(name) ||
        name.includes("/") ||
        name.includes("\\")
      ) {
        throw new Error("closed selection tap contains an unsafe path");
      }
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        throw new Error("closed selection tap contains a symlink");
      }
      if (stat.isDirectory()) {
        return {
          mode: "40000",
          name,
          oid: visit(path),
          // Git compares a directory as though its name ends in a slash.
          sortKey: Buffer.from(`${name}/`, "ascii"),
        };
      }
      if (!stat.isFile()) {
        throw new Error("closed selection tap contains a special file");
      }
      fileCount += 1;
      totalBytes += stat.size;
      if (
        fileCount > MAX_SELECTION_FILES ||
        totalBytes > MAX_SELECTION_TREE_BYTES
      ) {
        throw new Error("closed selection tap exceeds its resource bounds");
      }
      const bytes = new Uint8Array(readFileSync(path));
      if (bytes.byteLength !== stat.size) {
        throw new Error("closed selection tap changed while it was verified");
      }
      return {
        mode: (stat.mode & 0o111) === 0 ? "100644" : "100755",
        name,
        oid: gitObjectId("blob", bytes),
        sortKey: Buffer.from(name, "ascii"),
      };
    });
    entries.sort((left, right) => Buffer.compare(left.sortKey, right.sortKey));
    const tree = Buffer.concat(
      entries.map(({ mode, name, oid }) =>
        Buffer.concat([Buffer.from(`${mode} ${name}\0`, "ascii"), oid]),
      ),
    );
    return gitObjectId("tree", tree);
  };

  return visit(root).toString("hex");
}
