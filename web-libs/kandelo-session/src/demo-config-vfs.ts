import {
  KANDELO_DEMO_CONFIG_PATH,
  MAX_KANDELO_DEMO_CONFIG_BYTES,
  parseKandeloDemoConfig,
  validateKandeloDemoConfig,
  type KandeloDemoConfig,
} from "./demo-config";

const S_IFMT = 0xf000;
const S_IFREG = 0x8000;
const O_RDONLY = 0;

export interface DemoConfigFileSystem {
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
 * Read untrusted image-owned demo metadata without letting a malformed or
 * oversized profile hide behind whichever demo the caller selected.
 */
export function readKandeloDemoConfigFromVfs(
  fs: DemoConfigFileSystem,
): KandeloDemoConfig | null {
  let stat: { mode: number; size: number };
  try {
    stat = fs.lstat(KANDELO_DEMO_CONFIG_PATH);
  } catch (error) {
    if (isMissingVfsPath(error)) return null;
    throw error;
  }
  if ((stat.mode & S_IFMT) !== S_IFREG) {
    throw new Error(`${KANDELO_DEMO_CONFIG_PATH} must be a regular file`);
  }
  if (!Number.isSafeInteger(stat.size) || stat.size < 0) {
    throw new Error(`${KANDELO_DEMO_CONFIG_PATH} has an invalid size`);
  }
  if (stat.size > MAX_KANDELO_DEMO_CONFIG_BYTES) {
    throw new Error(
      `${KANDELO_DEMO_CONFIG_PATH} exceeds ${MAX_KANDELO_DEMO_CONFIG_BYTES} bytes`,
    );
  }

  const bytes = new Uint8Array(stat.size);
  const handle = fs.open(KANDELO_DEMO_CONFIG_PATH, O_RDONLY, 0);
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = fs.read(
        handle,
        bytes.subarray(offset),
        null,
        bytes.byteLength - offset,
      );
      if (!Number.isSafeInteger(count) || count <= 0 || count > bytes.byteLength - offset) {
        throw new Error(`${KANDELO_DEMO_CONFIG_PATH} could not be read completely`);
      }
      offset += count;
    }
  } finally {
    fs.close(handle);
  }

  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${KANDELO_DEMO_CONFIG_PATH} is not valid UTF-8`);
  }
  let config: KandeloDemoConfig | null;
  try {
    config = parseKandeloDemoConfig(source);
  } catch {
    throw new Error(`${KANDELO_DEMO_CONFIG_PATH} is not valid JSON`);
  }
  if (config === null) {
    throw new Error(`VFS image has unsupported ${KANDELO_DEMO_CONFIG_PATH} version`);
  }
  validateKandeloDemoConfig(config);
  return config;
}

function isMissingVfsPath(error: unknown): boolean {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (code === -2 || code === "ENOENT") return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /\bENOENT\b/.test(message) || message.includes("No such file or directory");
}
