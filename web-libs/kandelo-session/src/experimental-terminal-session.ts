import type {
  TerminalProgram,
  TerminalSessionPolicy,
} from "./kernel-host";

export const EXPERIMENTAL_TERMINAL_SESSION_PATH =
  "/etc/kandelo/experimental-terminal-session.json";
export const MAX_EXPERIMENTAL_TERMINAL_SESSION_BYTES = 65_536;

const SESSION_KIND = "kandelo-experimental-terminal-session";
const MAX_PATH_BYTES = 4_096;
const MAX_ARGS = 64;
const MAX_ARG_BYTES = 4_096;
const MAX_ARGV_BYTES = 65_536;
const MAX_GUEST_ID = 0xffff_ffff;

export interface ExperimentalTerminalProgram {
  path: string;
  argv: string[];
  uid: number;
  gid: number;
}

export interface ExperimentalTerminalSession {
  kind: typeof SESSION_KIND;
  version: 1;
  initial: ExperimentalTerminalProgram;
  afterExit?: ExperimentalTerminalProgram;
}

export function parseExperimentalTerminalSession(
  text: string,
): ExperimentalTerminalSession {
  if (utf8Bytes(text) > MAX_EXPERIMENTAL_TERMINAL_SESSION_BYTES) {
    throw new Error(
      `experimental terminal session exceeds ` +
        `${MAX_EXPERIMENTAL_TERMINAL_SESSION_BYTES} UTF-8 bytes`,
    );
  }
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) {
    throw new Error("experimental terminal session must be an object");
  }
  if (value.kind !== SESSION_KIND || value.version !== 1) {
    throw new Error("experimental terminal session kind or version is unsupported");
  }
  exactKeys(
    value,
    value.afterExit === undefined
      ? ["initial", "kind", "version"]
      : ["afterExit", "initial", "kind", "version"],
    "experimental terminal session",
  );

  return {
    kind: SESSION_KIND,
    version: 1,
    initial: parseProgram(value.initial, "initial"),
    ...(value.afterExit === undefined
      ? {}
      : { afterExit: parseProgram(value.afterExit, "afterExit") }),
  };
}

export function experimentalTerminalSessionPolicy(
  session: ExperimentalTerminalSession,
): TerminalSessionPolicy {
  return {
    initial: terminalProgram(session.initial),
    ...(session.afterExit === undefined
      ? {}
      : { afterExit: terminalProgram(session.afterExit) }),
    shortRunThresholdMs: 2_000,
    initialRestartDelayMs: 250,
    maximumRestartDelayMs: 5_000,
  };
}

function terminalProgram(program: ExperimentalTerminalProgram): TerminalProgram {
  return {
    programPath: program.path,
    argv: program.argv.slice(),
    uid: program.uid,
    gid: program.gid,
  };
}

function parseProgram(value: unknown, field: string): ExperimentalTerminalProgram {
  if (!isRecord(value)) {
    throw new Error(`experimental terminal session ${field} must be an object`);
  }
  exactKeys(
    value,
    ["argv", "gid", "path", "uid"],
    `experimental terminal session ${field}`,
  );

  const path = boundedString(value.path, `${field}.path`, MAX_PATH_BYTES);
  validateAbsoluteGuestPath(path, field);
  if (!Array.isArray(value.argv) || value.argv.length === 0) {
    throw new Error(
      `experimental terminal session ${field}.argv must be a non-empty array`,
    );
  }
  if (value.argv.length > MAX_ARGS) {
    throw new Error(
      `experimental terminal session ${field}.argv exceeds ${MAX_ARGS} arguments`,
    );
  }
  let argvBytes = 0;
  const argv = value.argv.map((arg, index) => {
    const parsed = boundedString(
      arg,
      `${field}.argv[${index}]`,
      MAX_ARG_BYTES,
    );
    if (parsed.length === 0) {
      throw new Error(
        `experimental terminal session ${field}.argv[${index}] must not be empty`,
      );
    }
    argvBytes += utf8Bytes(parsed);
    return parsed;
  });
  if (argvBytes > MAX_ARGV_BYTES) {
    throw new Error(
      `experimental terminal session ${field}.argv exceeds ` +
        `${MAX_ARGV_BYTES} UTF-8 bytes`,
    );
  }

  return {
    path,
    argv,
    uid: guestId(value.uid, `${field}.uid`),
    gid: guestId(value.gid, `${field}.gid`),
  };
}

function validateAbsoluteGuestPath(path: string, field: string): void {
  if (!path.startsWith("/") || path === "/" || path.endsWith("/")) {
    throw new Error(
      `experimental terminal session ${field}.path must be an absolute guest file path`,
    );
  }
  if (path.includes("\\") || path.includes("\0")) {
    throw new Error(
      `experimental terminal session ${field}.path contains a forbidden character`,
    );
  }
  const segments = path.split("/").slice(1);
  if (segments.some((segment) =>
    segment.length === 0 || segment === "." || segment === ".."
  )) {
    throw new Error(
      `experimental terminal session ${field}.path must be normalized`,
    );
  }
}

function guestId(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > MAX_GUEST_ID) {
    throw new Error(
      `experimental terminal session ${field} must be an integer between 0 and ${MAX_GUEST_ID}`,
    );
  }
  return Number(value);
}

function boundedString(value: unknown, field: string, maxBytes: number): string {
  if (typeof value !== "string") {
    throw new Error(`experimental terminal session ${field} must be a string`);
  }
  if (value.includes("\0")) {
    throw new Error(`experimental terminal session ${field} contains a NUL byte`);
  }
  if (utf8Bytes(value) > maxBytes) {
    throw new Error(
      `experimental terminal session ${field} exceeds ${maxBytes} UTF-8 bytes`,
    );
  }
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} contains unknown or missing fields`);
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
