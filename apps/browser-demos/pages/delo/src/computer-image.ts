// The disk of a delo computer, written from its configuration: every file of
// every installed binary and of the computer's own pipeline, the computer's
// config (/etc/delo/config.json), the machine description
// (/etc/kandelo/demo.json), and the terminal program when the
// configuration has a first process. A shell starts as a login shell, which
// reads /etc/profile. A computer whose disk has dinit's boot service starts
// dinit at boot, as root. A computer with a package that provides `web`
// declares port 8080, the port Kandelo's web preview shows. A lazy file is
// written as its address and the size its server gives; the kernel downloads
// its bytes on first read. A lazy archive is written as its member list and
// its length under the same address. No source has a digest, so no bytes are
// checked. Text the pipeline writes on a path a binary or the pipeline
// already wrote goes at the end of that file, which keeps its mode. A directory without a
// source is empty, with its owner. A symlink points to its `from`. A
// `from` of `<image>:<path>` copies a tree out of a Kandelo VFS image; each
// image is read once. A package that writes
// a path Delo writes itself is refused.
//
// A disk is written in steps: a step is every file whose `to` is one path,
// with the package each one comes from. The record of each step and the
// paths it wrote comes in with the disk and goes out with the new one:
// delo.json keeps it on the host, and config.json carries a copy that
// nothing reads back. Writing onto an existing disk skips an
// unchanged step, writes a new step, deletes the paths of a removed step, and
// deletes then writes a changed step, so every other file, the computer's
// data, stays. Text added to the file of another step changes that file, so
// both steps are rewritten together. A new step
// that writes a path already on the disk is refused by name. A removed step
// leaves its directories: the image writer cannot remove one
// (kandelo-problems.md). The record keeps them, so a later step can create
// them again. No kernel runs: the image writer builds the tree and
// exports it. This module touches no DOM, so it runs in the builder worker
// (computer-image-worker.ts) and in a Node test.

import { KandeloImageFs } from "../../../../../images/vfs/lib/kandelo-image-fs";
import { ensureDirRecursive, hasVfsErrorCode, writeVfsBinary, writeVfsFile } from "../../../../../host/src/vfs/image-helpers";
import { ENOENT } from "../../../../../host/src/vfs/vfs-errors";
import { extractZipEntry, parseZipCentralDirectory, type ZipEntry } from "../../../../../host/src/vfs/zip";
import { ABI_VERSION } from "../../../../../host/src/generated/abi";
import { DELO_FIRST_PROCESS_ACCOUNT } from "./account";
import { deloLazyAddress } from "./lazy-address";
import { DELO_CONFIG_PATH, deloComputerConfig, type DeloComputerConfig, type DeloWritten } from "./computer-record";
import { deloBootsDinit, deloImageSource, type DeloFile, type DeloPackage, type DeloPipeline } from "./registry";
import { KANDELO_DEMO_CONFIG_PATH, validateKandeloDemoConfig, type KandeloDemoConfig, type KandeloDemoProfileConfig } from "../../../../../web-libs/kandelo-session/src/demo-config";
import { EXPERIMENTAL_TERMINAL_SESSION_PATH, type ExperimentalTerminalSession } from "../../../../../web-libs/kandelo-session/src/experimental-terminal-session";
import { CUSTOM_VFS_PROFILE_MAX_BYTES } from "../../../../../web-libs/kandelo-session/src/vfs-capacity";

/** The files Delo writes on every disk, which no package may write. */
const DELO_WRITES = [DELO_CONFIG_PATH, KANDELO_DEMO_CONFIG_PATH, EXPERIMENTAL_TERMINAL_SESSION_PATH];

/** The computer's name, its installed binaries, dependencies before the
 *  binaries that need them, and the config the disk is written from. */
export type ComputerImagePlan = { name: string; binaries: DeloPackage[] } & DeloComputerConfig;

/** Reads the bytes of a file's source: a path under the binaries root, or an https URL. */
type ComputerImageSource = (from: string) => Promise<Uint8Array<ArrayBuffer>>;

/** Reads the member list of a lazy archive, each symlink member's target, and the archive's length, without the members' bytes. */
type ComputerImageArchiveIndex = (from: string) => Promise<{ entries: ZipEntry[]; symlinkTargets: Map<string, string>; bytes: number }>;

/** Reads the byte size of a lazy file's source, without its bytes. */
type ComputerImageSize = (from: string) => Promise<number>;

/** How the build reads the sources of the plan's files. */
interface ComputerImageSources {
  read: ComputerImageSource;
  index: ComputerImageArchiveIndex;
  size: ComputerImageSize;
}

/** A computer's disk: its image bytes, and what Delo wrote on it. */
export interface ComputerDisk<Bytes extends Uint8Array = Uint8Array> {
  image: Bytes;
  written: DeloWritten;
}

/** The package a file belongs to, the
 *  package that wrote each path so far, the paths the current step writes,
 *  the directories removed steps left, and the Kandelo images read so far. */
interface Owner {
  name: string;
  writers: Map<string, string>;
  claims: Record<string, string>;
  left: ReadonlySet<string>;
  images: Map<string, KandeloImageFs>;
}

/** Write the computer's disk onto `base`, its current disk, or onto an
 *  empty disk when `base` is null, and return the new disk. */
export async function buildComputerImage(plan: ComputerImagePlan, sources: ComputerImageSources, base: ComputerDisk | null = null): Promise<ComputerDisk> {
  const fs = KandeloImageFs.create();
  if (base === null) fs.setImageCapacity(CUSTOM_VFS_PROFILE_MAX_BYTES);
  else fs.loadImage(base.image);
  const written = base?.written ?? { steps: {}, left: [] };
  const before = written.steps;
  const packages: DeloPackage[] = [...plan.binaries, { ...plan.pipeline, name: DELO_CONFIG_PATH, type: "pipeline", description: plan.name }];
  const steps = stepsOf(packages);
  const stale = staleSteps(before, steps);
  const left = new Set([...written.left, ...deleteSteps(fs, before, stale)]);

  const writers = new Map<string, string>();
  for (const [key, step] of Object.entries(before)) {
    if (!stale.has(key)) for (const [path, writer] of Object.entries(step.claims)) writers.set(path, writer);
  }
  const images = new Map<string, KandeloImageFs>();
  const after: DeloWritten["steps"] = {};
  for (const [key, text] of steps) after[key] = stale.has(key) ? { text, claims: {} } : before[key];
  for (const entry of packages) {
    for (const file of entry.files) {
      if (!stale.has(file.to)) continue;
      await writeFileOf(fs, { name: entry.name, writers, claims: after[file.to].claims, left, images }, file, sources);
    }
  }

  const claimed = new Set(Object.values(after).flatMap((step) => Object.keys(step.claims)));
  const record: DeloWritten = { steps: after, left: [...left].filter((path) => !claimed.has(path) && exists(fs, path)) };
  ensureDirRecursive(fs, "/etc/delo");
  writeVfsFile(fs, DELO_CONFIG_PATH, `${JSON.stringify({ ...deloComputerConfig(plan.description, plan), written: record }, null, 2)}\n`, 0o644);

  const config: KandeloDemoConfig = { version: 1, image: { title: plan.name } };
  const machine = machineOf(packages);
  if (Object.keys(machine).length > 0) Object.assign(config, { defaultProfile: "delo", profiles: { delo: machine } });
  validateKandeloDemoConfig(config);
  ensureDirRecursive(fs, "/etc/kandelo");
  writeVfsFile(fs, KANDELO_DEMO_CONFIG_PATH, `${JSON.stringify(config)}\n`, 0o644);

  if (plan.firstProcess === null) {
    if (exists(fs, EXPERIMENTAL_TERMINAL_SESSION_PATH)) fs.unlink(EXPERIMENTAL_TERMINAL_SESSION_PATH);
  } else {
    const entry = plan.binaries.find((installed) => installed.name === plan.firstProcess);
    if (entry === undefined) throw new Error(`${plan.firstProcess} is the first process but is not installed`);
    const path = firstProcessPath(entry);
    const name = path.slice(path.lastIndexOf("/") + 1);
    const session: ExperimentalTerminalSession = {
      kind: "kandelo-experimental-terminal-session",
      version: 1,
      initial: { path, argv: [entry.provide.includes("shell") ? `-${name}` : name], ...DELO_FIRST_PROCESS_ACCOUNT },
    };
    writeVfsFile(fs, EXPERIMENTAL_TERMINAL_SESSION_PATH, `${JSON.stringify(session)}\n`, 0o644);
  }

  return { image: await fs.saveImage({ metadata: { version: 1, kernelAbi: ABI_VERSION, createdBy: "delo" } }), written: record };
}

/** Each step's text, keyed by its path, in the order its first file comes. */
function stepsOf(packages: readonly DeloPackage[]): Map<string, string> {
  const files = new Map<string, [string, DeloFile][]>();
  for (const entry of packages) {
    for (const file of entry.files) files.set(file.to, [...files.get(file.to) ?? [], [entry.name, file]]);
  }
  return new Map([...files].map(([key, owned]) => [key, JSON.stringify(owned)]));
}

/** The steps to delete or write: the new, changed and removed ones, and every
 *  step linked to one of those: one adds text to a file the other wrote. */
function staleSteps(before: DeloWritten["steps"], steps: Map<string, string>): Set<string> {
  const stale = new Set([...steps].filter(([key, text]) => before[key]?.text !== text).map(([key]) => key));
  for (const key of Object.keys(before)) if (!steps.has(key)) stale.add(key);
  const claimedBy = new Map<string, string>();
  for (const [key, step] of Object.entries(before)) for (const path of Object.keys(step.claims)) claimedBy.set(path, key);
  const links = [...new Set([...Object.keys(before), ...steps.keys()])].flatMap((key) => claimedBy.has(key) && claimedBy.get(key) !== key ? [[key, claimedBy.get(key)!]] : []);
  for (let grown = true; grown;) {
    grown = false;
    for (const [a, b] of links) {
      if (stale.has(a) === stale.has(b)) continue;
      stale.add(a);
      stale.add(b);
      grown = true;
    }
  }
  return stale;
}

/** Delete every file and symlink the stale steps wrote, and return the
 *  directories they leave. A path already gone stays gone. */
function deleteSteps(fs: KandeloImageFs, before: DeloWritten["steps"], stale: ReadonlySet<string>): Set<string> {
  const left = new Set<string>();
  for (const key of stale) {
    for (const path of Object.keys(before[key]?.claims ?? {})) {
      if (!exists(fs, path)) continue;
      if ((fs.lstat(path).mode & 0o170000) === 0o040000) left.add(path);
      else fs.unlink(path);
    }
  }
  return left;
}

async function writeFileOf(fs: KandeloImageFs, owner: Owner, file: DeloFile, { read, index, size }: ComputerImageSources): Promise<void> {
  if ("type" in file && file.type === "symlink") {
    claim(fs, owner, file.to);
    ensureDirRecursive(fs, parentOf(file.to));
    fs.symlink(file.from, file.to);
    return;
  }
  if ("type" in file && !("from" in file)) {
    const [uid, gid] = (file.owner ?? "0:0").split(":").map(Number);
    claim(fs, owner, file.to, owner.left.has(file.to));
    ensureDirRecursive(fs, file.to);
    fs.chown(file.to, uid, gid);
    fs.chmod(file.to, Number.parseInt(file.mode ?? "755", 8));
    return;
  }
  if ("type" in file && file.lazy) {
    const { entries, symlinkTargets, bytes } = await index(file.from);
    for (const entry of entries) {
      if (!entry.isDirectory) claim(fs, owner, `${file.to}/${entry.fileName}`);
    }
    fs.registerLazyArchive({
      url: deloLazyAddress(file.from),
      entries,
      mountPrefix: file.to,
      symlinkTargets,
      integrity: { bytes },
    });
    return;
  }
  if ("type" in file) {
    extract(fs, owner, file.to, await read(file.from));
    return;
  }
  const writer = owner.writers.get(file.to);
  if ("content" in file && owner.name === DELO_CONFIG_PATH && writer !== undefined) {
    if (file.mode !== undefined) throw new Error(`${owner.name}: ${file.to} keeps the mode ${writer} gave it`);
    addToFile(fs, file.to, new TextEncoder().encode(file.content));
    return;
  }
  const source = "from" in file ? deloImageSource(file.from) : null;
  if ("from" in file && source !== null) {
    let image = owner.images.get(source.image);
    if (image === undefined) {
      image = KandeloImageFs.create();
      image.loadImage(await read(source.image));
      owner.images.set(source.image, image);
    }
    copyTree(image, source.path, fs, owner, file.to);
    return;
  }
  const mode = Number.parseInt(file.mode ?? "644", 8);
  const path = file.to;
  if ("content" in file) writeFile(fs, owner, path, new TextEncoder().encode(file.content), mode);
  else if (file.lazy) {
    claim(fs, owner, path);
    fs.registerLazyFile(path, deloLazyAddress(file.from), await size(file.from), mode);
  } else {
    writeFile(fs, owner, path, await read(file.from), mode);
  }
}

function writeFile(fs: KandeloImageFs, owner: Owner, path: string, bytes: Uint8Array, mode: number): void {
  claim(fs, owner, path);
  ensureDirRecursive(fs, parentOf(path));
  writeVfsBinary(fs, path, bytes, mode);
  fs.chmod(path, mode);
}

function addToFile(fs: KandeloImageFs, path: string, bytes: Uint8Array): void {
  const existing = fs.readFile(path);
  const joined = new Uint8Array(existing.byteLength + bytes.byteLength);
  joined.set(existing);
  joined.set(bytes, existing.byteLength);
  writeVfsBinary(fs, path, joined);
}

function extract(fs: KandeloImageFs, owner: Owner, root: string, archive: Uint8Array): void {
  const entries = [...parseZipCentralDirectory(archive)].sort((a, b) =>
    Number(b.isDirectory) - Number(a.isDirectory) || a.fileName.localeCompare(b.fileName));
  for (const entry of entries) {
    const relative = entry.fileName.replace(/\/$/, "");
    if (relative === "" || relative.split("/").some((part) => part === "" || part === "." || part === "..")) {
      throw new Error(`${owner.name}: archive entry ${entry.fileName} escapes ${root}`);
    }
    const path = `${root}/${relative}`;
    if (entry.isDirectory) {
      ensureDirRecursive(fs, path, entry.mode & 0o7777);
      continue;
    }
    const bytes = extractZipEntry(archive, entry);
    if (entry.isSymlink) {
      claim(fs, owner, path);
      ensureDirRecursive(fs, parentOf(path));
      fs.symlink(new TextDecoder("utf-8", { fatal: true }).decode(bytes), path);
      continue;
    }
    writeFile(fs, owner, path, bytes, entry.mode & 0o7777);
  }
}

/** Copy the tree at `from` in `image` to `to`, with the image's modes and
 *  owners. A directory already in the computer keeps its own. A file whose
 *  bytes the image does not contain cannot be copied. */
function copyTree(image: KandeloImageFs, from: string, fs: KandeloImageFs, owner: Owner, to: string): void {
  const stat = image.lstat(from);
  const type = stat.mode & 0o170000;
  if (type === 0o040000) {
    if (!exists(fs, to)) {
      ensureDirRecursive(fs, to);
      fs.chown(to, stat.uid, stat.gid);
      fs.chmod(to, stat.mode & 0o7777);
    }
    for (const name of image.readDirNames(from).sort()) copyTree(image, `${from}/${name}`, fs, owner, `${to}/${name}`);
    return;
  }
  if (type === 0o120000) {
    claim(fs, owner, to);
    ensureDirRecursive(fs, parentOf(to));
    fs.symlink(image.readlink(from), to);
    return;
  }
  if (stat.deferred) throw new Error(`${owner.name}: ${from} is lazy in its image and cannot be copied`);
  writeFile(fs, owner, to, image.readFile(from), stat.mode & 0o7777);
  fs.chown(to, stat.uid, stat.gid);
}

/** Record that `owner` writes `path`, which must not be on the disk yet, or
 *  may be when `reuse` lets a directory a removed step left be written again. */
function claim(fs: KandeloImageFs, owner: Owner, path: string, reuse = false): void {
  if (DELO_WRITES.includes(path)) throw new Error(`${owner.name}: ${path} is a file delo writes itself`);
  if (!reuse && exists(fs, path)) throw new Error(`${owner.name}: ${path} is already in the computer`);
  owner.writers.set(path, owner.name);
  owner.claims[path] = owner.name;
}

function exists(fs: KandeloImageFs, path: string): boolean {
  try {
    fs.lstat(path);
    return true;
  } catch (error) {
    if (!hasVfsErrorCode(error, ENOENT)) throw error;
    return false;
  }
}

/** What the machine starts at boot and the port it serves, from the installed packages. */
function machineOf(packages: readonly DeloPipeline[]): KandeloDemoProfileConfig {
  const machine: KandeloDemoProfileConfig = {};
  if (packages.some(deloBootsDinit)) machine.init = { program: "/sbin/dinit", args: ["--system", "-p", "/run/dinitctl"], ...DELO_FIRST_PROCESS_ACCOUNT };
  if (packages.some((entry) => entry.provide.includes("web"))) machine.web = { requiredPorts: [8080] };
  return machine;
}

function firstProcessPath(entry: DeloPackage): string {
  const program = entry.files.find((file) => !("type" in file) && "mode" in file && (Number.parseInt(file.mode!, 8) & 0o111) !== 0);
  if (program === undefined) throw new Error(`${entry.name} is the first process but installs no executable file`);
  return program.to;
}

function parentOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/")) || "/";
}
