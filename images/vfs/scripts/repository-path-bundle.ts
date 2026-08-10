import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const GIT_SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;
const MAX_BUNDLE_ENTRIES = 100_000;

export interface RepositoryBundleSourceIdentity {
  repository: string;
  commit: string;
  tree: string;
}

type RepositoryPathBundleEntry =
  | Readonly<{ path: string; kind: "directory"; mode: number }>
  | Readonly<{
      path: string;
      kind: "file";
      mode: number;
      sha256: string;
      bytes: number;
      content_base64: string;
    }>
  | Readonly<{
      path: string;
      kind: "symlink";
      mode: number;
      target: string;
    }>;

export function createRepositoryPathBundle(options: {
  repositoryRoot: string;
  paths: readonly string[];
  source: Readonly<RepositoryBundleSourceIdentity>;
  outputPath: string;
}): void {
  const repositoryRoot = realDirectory(options.repositoryRoot, "repository root");
  const source = sourceIdentity(options.source, "repository bundle source");
  const paths = normalizedRoots(options.paths);
  const entries: RepositoryPathBundleEntry[] = [];
  const seen = new Set<string>();

  const visit = (relativePath: string): void => {
    if (seen.has(relativePath)) return;
    const absolutePath = within(repositoryRoot, relativePath, "repository path");
    let metadata: ReturnType<typeof lstatSync>;
    try {
      metadata = lstatSync(absolutePath);
    } catch (error) {
      throw new Error(
        `repository path ${JSON.stringify(relativePath)} is missing: ${describeError(error)}`,
      );
    }
    seen.add(relativePath);
    const mode = metadata.mode & 0o7777;
    if (metadata.isDirectory()) {
      entries.push({ kind: "directory", mode, path: relativePath });
      const children = readdirSync(absolutePath).sort(compareText);
      for (const child of children) visit(`${relativePath}/${child}`);
      return;
    }
    if (metadata.isSymbolicLink()) {
      const target = readlinkSync(absolutePath);
      validateSymlinkTarget(relativePath, target);
      const resolvedTarget = resolve(dirname(absolutePath), target);
      assertBelow(repositoryRoot, resolvedTarget, `repository symlink ${relativePath}`);
      entries.push({ kind: "symlink", mode, path: relativePath, target });
      return;
    }
    if (!metadata.isFile()) {
      throw new Error(
        `repository path ${JSON.stringify(relativePath)} is not a regular file, directory, or symlink`,
      );
    }
    const contents = readFileSync(absolutePath);
    entries.push({
      bytes: contents.byteLength,
      content_base64: contents.toString("base64"),
      kind: "file",
      mode,
      path: relativePath,
      sha256: digest(contents),
    });
  };

  for (const path of paths) visit(path);
  entries.sort((left, right) => compareText(left.path, right.path));
  if (entries.length > MAX_BUNDLE_ENTRIES) {
    throw new Error(`repository bundle exceeds ${MAX_BUNDLE_ENTRIES} entries`);
  }
  const body = canonicalJson({
    entries,
    kind: "kandelo-vfs-repository-path-bundle",
    paths,
    schema: 1,
    source,
  });
  if (Buffer.byteLength(body) > MAX_BUNDLE_BYTES) {
    throw new Error(`repository bundle exceeds ${MAX_BUNDLE_BYTES} bytes`);
  }
  assertNewRegularParent(options.outputPath, "repository bundle output");
  writeFileSync(options.outputPath, body, { flag: "wx", mode: 0o600 });
}

function normalizedRoots(value: readonly unknown[]): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) {
    throw new Error("repository bundle paths must contain 1..256 entries");
  }
  const paths = value.map((path, index) =>
    normalizedRelativePath(path, `repository bundle path ${index}`)
  );
  const sorted = [...new Set(paths)].sort(compareText);
  if (
    sorted.length !== paths.length ||
    sorted.some((path, index) => path !== paths[index]) ||
    sorted.some((path, index) =>
      sorted.some((other, otherIndex) =>
        index !== otherIndex && isAtOrBelow(other, path)
      )
    )
  ) {
    throw new Error("repository bundle paths must be sorted, unique, and nonoverlapping");
  }
  return sorted;
}

function sourceIdentity(
  value: unknown,
  label: string,
): RepositoryBundleSourceIdentity {
  const source = exactRecord(value, ["commit", "repository", "tree"], label);
  const repository = textValue(source.repository, `${label} repository`, 255);
  if (!REPOSITORY.test(repository)) throw new Error(`${label} repository is invalid`);
  return {
    repository,
    commit: gitSha(source.commit, `${label} commit`),
    tree: gitSha(source.tree, `${label} tree`),
  };
}

function normalizedRelativePath(value: unknown, label: string): string {
  const path = textValue(value, label, 4096);
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path !== path.normalize("NFC") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`${label} is not a normalized relative POSIX path`);
  }
  return path;
}

function validateSymlinkTarget(path: string, target: string): void {
  if (
    typeof target !== "string" ||
    target.length === 0 ||
    target.length > 4096 ||
    target.includes("\0") ||
    target.includes("\\") ||
    target.startsWith("/") ||
    target !== target.normalize("NFC")
  ) {
    throw new Error(`repository symlink ${JSON.stringify(path)} has an unsafe target`);
  }
  normalizeRelativeTarget(path, target);
}

function normalizeRelativeTarget(path: string, target: string): string {
  const stack = path.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (stack.length === 0) {
        throw new Error(`repository symlink ${JSON.stringify(path)} escapes its bundle`);
      }
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  if (stack.length === 0) {
    throw new Error(`repository symlink ${JSON.stringify(path)} targets the bundle root`);
  }
  return stack.join("/");
}

function realDirectory(path: string, label: string): string {
  const absolute = resolve(path);
  const metadata = lstatSync(absolute);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a real directory`);
  }
  return realpathSync(absolute);
}

function within(root: string, path: string, label: string): string {
  const target = resolve(root, ...path.split("/"));
  assertBelow(root, target, label);
  return target;
}

function assertBelow(root: string, target: string, label: string): void {
  const fromRoot = relative(root, target);
  if (
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error(`${label} escapes its root`);
  }
}

function isAtOrBelow(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function assertNewRegularParent(path: string, label: string): void {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new Error(`${label} must be a normalized absolute path`);
  }
  const parent = lstatSync(dirname(path));
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    throw new Error(`${label} parent must be a real directory`);
  }
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${label} already exists`);
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort(compareText);
  const expected = [...keys].sort(compareText);
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} has unknown or missing fields`);
  }
  return record;
}

function textValue(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    Buffer.byteLength(value) > maximum
  ) {
    throw new Error(`${label} must be bounded text`);
  }
  return value;
}

function gitSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !GIT_SHA.test(value)) {
    throw new Error(`${label} is not a full lowercase Git SHA`);
  }
  return value;
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortJson(value))}\n`;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
