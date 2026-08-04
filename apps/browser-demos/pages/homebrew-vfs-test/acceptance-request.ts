// WHY: this helper is a bounded publisher proof, not a general terminal.
// Keep workflow-provided input small enough to copy and diagnose safely.
const MAX_STDIN_BYTES = 64 * 1024;

export interface HomebrewVfsAcceptanceRequest {
  vfsUrl: string;
  executable: string;
  argv: string[];
  stdin?: string;
  pty?: boolean;
  timeoutMs: number;
}

export type HomebrewVfsAcceptanceInput =
  | { kind: "stdio"; stdin?: Uint8Array }
  | { kind: "pty"; input: Uint8Array };

export function validateHomebrewVfsAcceptanceRequest(
  request: HomebrewVfsAcceptanceRequest,
): HomebrewVfsAcceptanceInput {
  if (!Array.isArray(request.argv) || request.argv.length === 0) {
    throw new Error("argv must contain at least one entry");
  }
  if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1_000) {
    throw new Error("timeoutMs must be an integer of at least 1000");
  }
  if (request.pty !== undefined && typeof request.pty !== "boolean") {
    throw new Error("pty must be a boolean");
  }
  if (request.stdin === undefined) {
    if (request.pty === true) {
      throw new Error("focused PTY acceptance requires bounded terminal input");
    }
    return { kind: "stdio" };
  }
  if (typeof request.stdin !== "string") {
    throw new Error(`stdin must be a string of at most ${MAX_STDIN_BYTES} bytes`);
  }
  const stdin = new TextEncoder().encode(request.stdin);
  if (stdin.byteLength > MAX_STDIN_BYTES) {
    throw new Error(`stdin must be a string of at most ${MAX_STDIN_BYTES} bytes`);
  }
  // WHY: SpawnMessage.stdin is a finite stdio buffer, but the browser worker
  // deliberately ignores it for PTY processes. Keep the two transports
  // distinct so a PTY proof cannot silently wait for input that never arrives.
  return request.pty === true
    ? { kind: "pty", input: stdin }
    : { kind: "stdio", stdin };
}
