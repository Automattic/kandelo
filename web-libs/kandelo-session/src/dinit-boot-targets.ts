const S_IFMT = 0xf000;
const S_IFREG = 0x8000;
const O_RDONLY = 0;
const MAX_DINIT_SERVICE_FILE_BYTES = 65_536;

export interface DinitBootTargetsFileSystem {
  lstat(path: string): { mode: number; size: number };
  open(path: string, flags: number, mode: number): number;
  read(
    handle: number,
    buffer: Uint8Array,
    offset: number | null,
    length: number,
  ): number;
  close(handle: number): unknown;
}

/**
 * Read the dependency closure a dinit boot target declares in the image.
 *
 * `images/vfs/scripts/dinit-image-helpers.ts`'s `addDinitInit()` writes an
 * aggregator service (named `boot` by default) whose `depends-on` lines name
 * every service the demo's dinit tree ships. That file is the image's own
 * authoritative statement of "what must come up for this machine to be
 * ready" — reading it here means the browser's readiness watcher can stop
 * hand-maintaining a parallel, driftable copy of the same list.
 *
 * Throws, naming the missing service and its expected path, when
 * `/etc/dinit.d/<target>` does not exist. A demo.json `init.target` with no
 * matching service file is a platform defect (a machine that can never
 * become ready), not something a readiness probe should wait out silently.
 */
export function readDinitBootTargets(
  fs: DinitBootTargetsFileSystem,
  target: string,
): string[] {
  const path = `/etc/dinit.d/${target}`;
  let stat: { mode: number; size: number };
  try {
    stat = fs.lstat(path);
  } catch (error) {
    if (isMissingVfsPath(error)) {
      throw new Error(
        `dinit boot target "${target}" is missing: ${path} does not exist`,
      );
    }
    throw error;
  }
  if ((stat.mode & S_IFMT) !== S_IFREG) {
    throw new Error(`${path} must be a regular file`);
  }
  if (!Number.isSafeInteger(stat.size) || stat.size < 0) {
    throw new Error(`${path} has an invalid size`);
  }
  if (stat.size > MAX_DINIT_SERVICE_FILE_BYTES) {
    throw new Error(`${path} exceeds ${MAX_DINIT_SERVICE_FILE_BYTES} bytes`);
  }

  const bytes = new Uint8Array(stat.size);
  const handle = fs.open(path, O_RDONLY, 0);
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = fs.read(
        handle,
        bytes.subarray(offset),
        null,
        bytes.byteLength - offset,
      );
      if (
        !Number.isSafeInteger(count) ||
        count <= 0 ||
        count > bytes.byteLength - offset
      ) {
        throw new Error(`${path} could not be read completely`);
      }
      offset += count;
    }
  } finally {
    fs.close(handle);
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${path} is not valid UTF-8`);
  }

  const services: string[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^depends-on\s*=\s*(.+)$/);
    if (!match) continue;
    const name = match[1].trim();
    if (name) services.push(name);
  }
  return services;
}

function isMissingVfsPath(error: unknown): boolean {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (code === -2 || code === "ENOENT") return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return (
    /\bENOENT\b/.test(message) || message.includes("No such file or directory")
  );
}
