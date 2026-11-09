/**
 * Eager-content budget for a composed VFS image.
 *
 * WHY THIS EXISTS: an image's eager content is what every visitor downloads
 * and decompresses before the first prompt. Making optional content lazy is
 * a one-line choice in a composer, and so is undoing it: the browser shell
 * grew from 1,047,839 to 1,436,395 compressed bytes when one change unpacked
 * the whole xkeyboard-config tree (293 files, 3,332,352 bytes) eagerly, and
 * nothing noticed. A checked-in budget turns that silent growth into a build
 * failure, so making an image bigger becomes a reviewed commit that names the
 * content and says why it must be present at boot.
 *
 * WHAT IS MEASURED, and why each number:
 *
 * - Eager bytes: the sum of the sizes of the regular files whose bytes are
 *   stored in the image -- every regular file that is not deferred to a lazy
 *   file or lazy archive -- counted once per inode, because hard links share
 *   one copy. It is a pure function of the tree, so it does not move with a
 *   compressor version, and it can be attributed to paths, which is what the
 *   failure message needs to say what grew. It is also the boot memory cost:
 *   the decompressed image lives in the machine's VFS memory.
 * - Eager files: the same set, counted. Many small files (a keymap tree, a
 *   theme) cost directory and inode records and boot-time work beyond their
 *   bytes; the xkb regression added 293 of them.
 * - Compressed bytes: the size of the serialized `.vfs.zst`, the number a
 *   visitor actually downloads. It also covers growth the eager count cannot
 *   see -- thousands of new lazy-file records or directories add to every
 *   boot download without adding an eager byte. It depends on the zstd
 *   implementation, which the dev shell pins; the headroom absorbs small
 *   drift, and a real compressor change is a reviewed toolchain change too.
 *
 * The walk reads the composer's own in-memory tree, the same tree it then
 * serializes, so the check runs on the normal build path rather than in a
 * separate pass over a published artifact. `xtask vfs-image describe` reads
 * the written image the way the kernel does and must agree: its entries with
 * `kind: "file"` and a `content_sha256` are exactly this set.
 */
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { KandeloImageFs } from "../lib/kandelo-image-fs";

const REGULAR_FILE_MODE = 0o100000;
const DIRECTORY_MODE = 0o040000;
const FILE_TYPE_MASK = 0o170000;

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

export const IMAGE_EAGER_BUDGET_KIND = "kandelo-vfs-image-eager-budget";

/**
 * How far a budget may sit above the measurement recorded beside it. A budget
 * far above what the image holds would let growth back in silently, which is
 * the failure this file exists to prevent; requiring the recorded measurement
 * to be close forces a raise to state the real new size.
 */
export const MAX_BUDGET_HEADROOM = 0.05;

/** How many contributors a failure message lists. */
const REPORTED_CONTRIBUTORS = 12;

export interface ImageEagerMeasurement {
  eagerBytes: number;
  eagerFiles: number;
  compressedBytes: number;
}

export interface ImageEagerBudget {
  image: string;
  maxEagerBytes: number;
  maxEagerFiles: number;
  maxCompressedBytes: number;
  /** What the image measured when this budget was last set. */
  measured: ImageEagerMeasurement;
}

export interface EagerFile {
  /** The first path to the inode in sorted walk order. */
  path: string;
  bytes: number;
}

export interface EagerContent {
  /** One entry per eager inode, largest first, then by path. */
  files: EagerFile[];
  eagerBytes: number;
  eagerFiles: number;
}

/**
 * Every regular file whose bytes are stored in the image. Deferred files --
 * standalone lazy files and lazy-archive members alike -- report their real
 * size through `stat` but carry no bytes in the image, so they are excluded;
 * nothing deferred is read or materialized by this walk.
 */
export function measureEagerContent(fs: KandeloImageFs): EagerContent {
  const byInode = new Map<number, EagerFile>();
  const walk = (dir: string): void => {
    const names: string[] = [];
    const handle = fs.opendir(dir);
    try {
      for (let entry = fs.readdir(handle); entry; entry = fs.readdir(handle)) {
        if (entry.name !== "." && entry.name !== "..") names.push(entry.name);
      }
    } finally {
      fs.closedir(handle);
    }
    // Sorted so the path reported for a hard-linked inode is stable.
    for (const name of names.sort()) {
      const path = dir === "/" ? `/${name}` : `${dir}/${name}`;
      const stat = fs.lstat(path);
      const type = stat.mode & FILE_TYPE_MASK;
      if (type === DIRECTORY_MODE) {
        walk(path);
      } else if (type === REGULAR_FILE_MODE && !stat.deferred && !byInode.has(stat.ino)) {
        byInode.set(stat.ino, { path, bytes: stat.size });
      }
    }
  };
  walk("/");
  const files = [...byInode.values()].sort(
    (a, b) => b.bytes - a.bytes || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
  return {
    files,
    eagerBytes: files.reduce((total, file) => total + file.bytes, 0),
    eagerFiles: files.length,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const extra = Object.keys(value).filter((key) => !keys.includes(key));
  const missing = keys.filter((key) => !(key in value));
  if (extra.length > 0 || missing.length > 0) {
    throw new Error(
      `${label} must have exactly the keys ${keys.join(", ")}` +
        (missing.length ? `; missing ${missing.join(", ")}` : "") +
        (extra.length ? `; unexpected ${extra.join(", ")}` : ""),
    );
  }
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

/**
 * Parse and validate a budget document. The prose fields are required so the
 * file keeps explaining itself to whoever edits it: JSON has no comments, and
 * the reason a limit exists has to travel with the limit.
 */
export function parseImageEagerBudget(text: string, label: string): ImageEagerBudget {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
  if (!isRecord(value)) throw new Error(`${label} must be a JSON object`);
  requireExactKeys(
    value,
    [
      "kind",
      "version",
      "image",
      "why",
      "measurement",
      "raising",
      "maxEagerBytes",
      "maxEagerFiles",
      "maxCompressedBytes",
      "measured",
    ],
    label,
  );
  if (value.kind !== IMAGE_EAGER_BUDGET_KIND || value.version !== 1) {
    throw new Error(`${label} must be ${IMAGE_EAGER_BUDGET_KIND} version 1`);
  }
  for (const key of ["why", "measurement", "raising"] as const) {
    nonEmptyString(value[key], `${label} ${key}`);
  }
  if (!isRecord(value.measured)) {
    throw new Error(`${label} measured must be an object`);
  }
  requireExactKeys(
    value.measured,
    ["eagerBytes", "eagerFiles", "compressedBytes"],
    `${label} measured`,
  );
  const budget: ImageEagerBudget = {
    image: nonEmptyString(value.image, `${label} image`),
    maxEagerBytes: positiveInteger(value.maxEagerBytes, `${label} maxEagerBytes`),
    maxEagerFiles: positiveInteger(value.maxEagerFiles, `${label} maxEagerFiles`),
    maxCompressedBytes: positiveInteger(
      value.maxCompressedBytes,
      `${label} maxCompressedBytes`,
    ),
    measured: {
      eagerBytes: positiveInteger(value.measured.eagerBytes, `${label} measured.eagerBytes`),
      eagerFiles: positiveInteger(value.measured.eagerFiles, `${label} measured.eagerFiles`),
      compressedBytes: positiveInteger(
        value.measured.compressedBytes,
        `${label} measured.compressedBytes`,
      ),
    },
  };
  const pairs = [
    ["maxEagerBytes", budget.maxEagerBytes, budget.measured.eagerBytes],
    ["maxEagerFiles", budget.maxEagerFiles, budget.measured.eagerFiles],
    ["maxCompressedBytes", budget.maxCompressedBytes, budget.measured.compressedBytes],
  ] as const;
  for (const [key, max, measured] of pairs) {
    if (measured > max) {
      throw new Error(`${label} records a measurement above its own ${key}`);
    }
    // The file-count limit is small, so a 5% rule would forbid even one file
    // of slack; allow at least a few files above the measurement.
    const slack = key === "maxEagerFiles"
      ? Math.max(4, Math.floor(measured * MAX_BUDGET_HEADROOM))
      : Math.floor(measured * MAX_BUDGET_HEADROOM);
    if (max > measured + slack) {
      throw new Error(
        `${label} ${key} ${max} is more than ${MAX_BUDGET_HEADROOM * 100}% ` +
          `above the measured ${measured}; record the image's real size ` +
          `and keep the headroom small so growth stays visible`,
      );
    }
  }
  return budget;
}

export function readImageEagerBudget(path: string): ImageEagerBudget {
  return parseImageEagerBudget(readFileSync(path, "utf8"), displayPath(path));
}

/** A repository path in messages, so they name the file a person edits. */
export function displayPath(path: string): string {
  const rel = relative(REPO_ROOT, resolve(path));
  return rel.startsWith("..") ? path : rel;
}

function formatBytes(bytes: number): string {
  return bytes.toLocaleString("en-US");
}

/** Contributors grouped by their parent directory, largest first. */
function eagerDirectories(content: EagerContent): Array<{ dir: string; bytes: number; files: number }> {
  const dirs = new Map<string, { dir: string; bytes: number; files: number }>();
  for (const file of content.files) {
    const dir = file.path.slice(0, file.path.lastIndexOf("/")) || "/";
    const entry = dirs.get(dir) ?? { dir, bytes: 0, files: 0 };
    entry.bytes += file.bytes;
    entry.files += 1;
    dirs.set(dir, entry);
  }
  return [...dirs.values()].sort(
    (a, b) => b.bytes - a.bytes || (a.dir < b.dir ? -1 : 1),
  );
}

function contributorReport(content: EagerContent): string[] {
  const lines = ["Largest eager directories (bytes, files, directory):"];
  for (const dir of eagerDirectories(content).slice(0, REPORTED_CONTRIBUTORS)) {
    lines.push(`  ${formatBytes(dir.bytes).padStart(11)}  ${String(dir.files).padStart(4)}  ${dir.dir}`);
  }
  lines.push("Largest eager files (bytes, path):");
  for (const file of content.files.slice(0, REPORTED_CONTRIBUTORS)) {
    lines.push(`  ${formatBytes(file.bytes).padStart(11)}  ${file.path}`);
  }
  return lines;
}

function overLine(name: string, actual: number, limit: number, measured: number): string {
  return `  ${name}: ${formatBytes(actual)} exceeds the budget of ${formatBytes(limit)} ` +
    `(recorded ${formatBytes(measured)} when the budget was set; ` +
    `+${formatBytes(actual - measured)} since)`;
}

function budgetFailure(
  budget: ImageEagerBudget,
  budgetPath: string,
  over: string[],
  content: EagerContent,
): Error {
  return new Error(
    [
      `${budget.image} image exceeds its eager-content budget in ${displayPath(budgetPath)}:`,
      ...over,
      `  current: ${formatBytes(content.eagerBytes)} eager bytes in ${content.eagerFiles} files`,
      ...contributorReport(content),
      "Optional content belongs behind a lazy file or lazy archive, fetched on " +
        "first read. If the new content must be present at boot, raise the " +
        `budget in ${displayPath(budgetPath)} in a commit that names the ` +
        "content and says why it must be eager (docs/package-management.md, " +
        "\"Image eager-content budgets\").",
    ].join("\n"),
  );
}

/**
 * Fail when the tree's eager content is over budget. Run before the image is
 * serialized, so a rejected composition writes no output.
 */
export function requireEagerContentWithinBudget(
  budget: ImageEagerBudget,
  budgetPath: string,
  content: EagerContent,
): void {
  const over: string[] = [];
  if (content.eagerBytes > budget.maxEagerBytes) {
    over.push(overLine("eager bytes", content.eagerBytes, budget.maxEagerBytes, budget.measured.eagerBytes));
  }
  if (content.eagerFiles > budget.maxEagerFiles) {
    over.push(overLine("eager files", content.eagerFiles, budget.maxEagerFiles, budget.measured.eagerFiles));
  }
  if (over.length > 0) throw budgetFailure(budget, budgetPath, over, content);
}

/**
 * Fail when the serialized, compressed image is over budget. Run on the
 * compressed bytes before they are written.
 */
export function requireCompressedImageWithinBudget(
  budget: ImageEagerBudget,
  budgetPath: string,
  compressedBytes: number,
  content: EagerContent,
): void {
  if (compressedBytes <= budget.maxCompressedBytes) return;
  throw budgetFailure(
    budget,
    budgetPath,
    [overLine("compressed image bytes", compressedBytes, budget.maxCompressedBytes, budget.measured.compressedBytes)],
    content,
  );
}

/** One build-log line, so a budget's remaining headroom is visible. */
export function describeBudgetUse(
  budget: ImageEagerBudget,
  content: EagerContent,
  compressedBytes: number,
): string {
  return `${budget.image} eager-content budget: ` +
    `${formatBytes(content.eagerBytes)} / ${formatBytes(budget.maxEagerBytes)} eager bytes, ` +
    `${content.eagerFiles} / ${budget.maxEagerFiles} eager files, ` +
    `${formatBytes(compressedBytes)} / ${formatBytes(budget.maxCompressedBytes)} compressed bytes`;
}
