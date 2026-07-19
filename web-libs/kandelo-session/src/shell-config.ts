export const KANDELO_SHELL_CONFIG_PATH = "/etc/kandelo/shell.json";
export const MAX_KANDELO_SHELL_CONFIG_BYTES = 65_536;
export const MAX_KANDELO_SHELL_EXECUTABLE_BYTES = 64 * 1024 * 1024;

const MAX_SHELL_PATH_BYTES = 4_096;
const MAX_SHELL_ARGS = 64;
const MAX_SHELL_ARG_BYTES = 4_096;
const MAX_SHELL_ARGV_BYTES = 65_536;

export interface KandeloShellConfig {
  version: 1;
  path: string;
  argv: string[];
}

/**
 * Parse the image-owned default interactive-shell contract.
 *
 * The file is untrusted VFS input. Keep this schema intentionally small: the
 * boot descriptor continues to own identity, environment, and working
 * directory, while the image identifies only the executable it actually
 * contains and the arguments needed to start it as an interactive shell.
 */
export function parseKandeloShellConfig(text: string): KandeloShellConfig | null {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || value.version !== 1) return null;

  const keys = Object.keys(value).sort();
  if (keys.join("\0") !== ["argv", "path", "version"].join("\0")) {
    throw new Error("shell config must contain exactly version, path, and argv");
  }

  const path = requireBoundedString(value.path, "path", MAX_SHELL_PATH_BYTES);
  validateAbsoluteGuestPath(path);

  if (!Array.isArray(value.argv) || value.argv.length === 0) {
    throw new Error("shell config argv must be a non-empty array");
  }
  if (value.argv.length > MAX_SHELL_ARGS) {
    throw new Error(`shell config argv exceeds ${MAX_SHELL_ARGS} arguments`);
  }

  let argvBytes = 0;
  const argv = value.argv.map((arg, index) => {
    const parsed = requireBoundedString(arg, `argv[${index}]`, MAX_SHELL_ARG_BYTES);
    if (parsed.length === 0) {
      throw new Error(`shell config argv[${index}] must not be empty`);
    }
    argvBytes += utf8Bytes(parsed);
    return parsed;
  });
  if (argvBytes > MAX_SHELL_ARGV_BYTES) {
    throw new Error(`shell config argv exceeds ${MAX_SHELL_ARGV_BYTES} UTF-8 bytes`);
  }

  return { version: 1, path, argv };
}

function validateAbsoluteGuestPath(path: string): void {
  if (!path.startsWith("/") || path === "/" || path.endsWith("/")) {
    throw new Error("shell config path must be an absolute guest file path");
  }
  if (path.includes("\\") || path.includes("\0")) {
    throw new Error("shell config path contains a forbidden character");
  }
  const segments = path.split("/").slice(1);
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error("shell config path must be normalized without empty, . or .. segments");
  }
}

function requireBoundedString(value: unknown, field: string, maxBytes: number): string {
  if (typeof value !== "string") {
    throw new Error(`shell config ${field} must be a string`);
  }
  if (value.includes("\0")) {
    throw new Error(`shell config ${field} contains a NUL byte`);
  }
  if (utf8Bytes(value) > maxBytes) {
    throw new Error(`shell config ${field} exceeds ${maxBytes} UTF-8 bytes`);
  }
  return value;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
