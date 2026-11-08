// A request from inside the machine to open a terminal running a command.
//
// A program in the machine publishes it as a Kandelo exchange output of type
// TERMINAL_REQUEST_MIME (the image's `kandelo-terminal` helper does). The
// browser app opens a new terminal tab for it, as it does for an activity,
// and types the command at that terminal's prompt: the user sees what ran,
// and once it exits, Up and Enter run it again. A dropped ROM uses this so the
// game it starts is an ordinary command in an ordinary terminal.
//
// The command runs as the terminal's own login user, the same account a
// guest publisher already is, so a request grants nothing a program in the
// machine could not do itself. It is still untrusted input: it is typed into
// a shell, so it must be one line with no control characters, and it is shown
// to the user, so it is bounded.

export const TERMINAL_REQUEST_MIME = "application/x-kandelo-terminal-command";
export const MAX_TERMINAL_REQUEST_BYTES = 4096;
const MAX_COMMAND_LENGTH = 2048;
const MAX_TITLE_LENGTH = 80;

export interface TerminalRequest {
  /** One shell command line, typed at the new terminal's prompt. */
  readonly command: string;
  /** The terminal tab's label. */
  readonly title: string;
  /**
   * The command draws on the framebuffer: whatever holds the display is
   * stopped first and the display view is brought forward, as for a
   * graphical activity.
   */
  readonly display?: "framebuffer";
}

/** Why a request was refused, in words the user can be shown. */
export class InvalidTerminalRequestError extends Error {}

// C0 controls and DEL: a newline would run a second command, and the rest
// would be terminal input rather than text.
const CONTROL = /[\u0000-\u001f\u007f]/;

function text(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidTerminalRequestError(`the request has no ${what}`);
  }
  if (CONTROL.test(value)) {
    throw new InvalidTerminalRequestError(`the request's ${what} contains control characters`);
  }
  return value;
}

/** Parse a published request's bytes; throws InvalidTerminalRequestError. */
export function parseTerminalRequest(bytes: Uint8Array): TerminalRequest {
  if (bytes.byteLength > MAX_TERMINAL_REQUEST_BYTES) {
    throw new InvalidTerminalRequestError(`the request is larger than ${MAX_TERMINAL_REQUEST_BYTES} bytes`);
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new InvalidTerminalRequestError("the request is not UTF-8 JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidTerminalRequestError("the request is not a JSON object");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!["version", "command", "title", "display"].includes(key)) {
      throw new InvalidTerminalRequestError(`the request has an unknown field "${key}"`);
    }
  }
  if (record.version !== 1) {
    throw new InvalidTerminalRequestError("the request is not version 1");
  }
  // The command is run, so a long one is refused rather than cut. The title
  // is only a label (a dropped file's name can be long), so it is shortened.
  const command = text(record.command, "command");
  if (command.length > MAX_COMMAND_LENGTH) {
    throw new InvalidTerminalRequestError(`the request's command is longer than ${MAX_COMMAND_LENGTH} characters`);
  }
  const label = [...text(record.title, "title")];
  const title = label.length > MAX_TITLE_LENGTH ? `${label.slice(0, MAX_TITLE_LENGTH - 1).join("")}…` : label.join("");
  if (record.display !== undefined && record.display !== "framebuffer") {
    throw new InvalidTerminalRequestError(`the request names an unknown display "${String(record.display)}"`);
  }
  return {
    command,
    title,
    ...(record.display === "framebuffer" ? { display: "framebuffer" as const } : {}),
  };
}
