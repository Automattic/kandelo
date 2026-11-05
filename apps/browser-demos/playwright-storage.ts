import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const storageKey = "KANDELO_PLAYWRIGHT_STORAGE_ROOT";
const rootPrefix = "kandelo-playwright-storage-";
const writableName = /^FileSystemWritableStream[A-Za-z0-9]{6}$/;

export function browserStorageHome(browser: "firefox" | "webkit"): string {
  let root = process.env[storageKey];
  if (root === undefined) {
    root = mkdtempSync(join(tmpdir(), rootPrefix));
    writeFileSync(join(root, "owner.json"), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
    process.env[storageKey] = root;
  }
  validateStorageRoot(root);
  const home = join(root, browser);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return home;
}

function validateStorageRoot(root: string): void {
  if (!basename(root).startsWith(rootPrefix) || realpathSync(dirname(root)) !== realpathSync(tmpdir())) {
    throw new Error("Invalid Playwright storage root");
  }
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.()) {
    throw new Error("Playwright storage root must be an owned directory");
  }
}

export function ownedBrowserStorageRoot(): string | undefined {
  const root = process.env[storageKey];
  if (root === undefined) return undefined;
  validateStorageRoot(root);
  const owner = JSON.parse(readFileSync(join(root, "owner.json"), "utf8"));
  return owner.pid === process.pid ? root : undefined;
}

export async function removeBrowserStorageRoot(root: string): Promise<void> {
  if (root !== ownedBrowserStorageRoot()) throw new Error("Cannot remove another runner's browser storage");
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  delete process.env[storageKey];
}

export function webkitTemporaryDirectory(): string | undefined {
  if (process.platform !== "darwin") return undefined;
  const base = execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).trim();
  return join(realpathSync(base), "com.apple.WebKit.Networking+org.webkit.Playwright");
}

export function webkitBrowsersRunning(): boolean {
  const processes = execFileSync("/bin/ps", ["-U", String(process.getuid!()), "-o", "comm="], { encoding: "utf8" });
  return processes.split("\n").some(command =>
    command.includes("Playwright.app/Contents/MacOS/Playwright")
    || (command.includes("ms-playwright/") && command.includes("com.apple.WebKit.")));
}

export function writableStreamFiles(directory: string): Set<string> {
  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.()) {
      throw new Error("WebKit temporary storage must be an owned directory");
    }
    return new Set(readdirSync(directory).filter(name => writableName.test(name)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw error;
  }
}

export function removeNewWritableStreams(
  directory: string,
  baseline: ReadonlySet<string>,
  browsersRunning: () => boolean = webkitBrowsersRunning,
  fileClosed: (path: string) => boolean = writableStreamClosed,
): { files: number; bytes: number } {
  const result = { files: 0, bytes: 0 };
  if (browsersRunning()) return result;
  for (const name of writableStreamFiles(directory)) {
    if (baseline.has(name)) continue;
    const path = join(directory, name);
    let stat;
    try { stat = lstatSync(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.()) continue;
    if (!fileClosed(path)) continue;
    if (browsersRunning()) break;
    const current = lstatSync(path);
    if (current.ino !== stat.ino || current.dev !== stat.dev || current.size !== stat.size
      || current.mtimeMs !== stat.mtimeMs || current.ctimeMs !== stat.ctimeMs
      || current.uid !== stat.uid || current.nlink !== 1 || !current.isFile()) continue;
    unlinkSync(path);
    result.files += 1;
    result.bytes += stat.blocks * 512;
  }
  return result;
}

function writableStreamClosed(path: string): boolean {
  const result = spawnSync("/usr/sbin/lsof", ["-t", "--", path], { encoding: "utf8" });
  if (result.error || result.signal || result.stderr !== "" || ![0, 1].includes(result.status!)) {
    throw new Error("Unable to establish ownership of WebKit staging files");
  }
  return result.status === 1 && result.stdout === "";
}
