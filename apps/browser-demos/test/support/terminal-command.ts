import { randomBytes } from "node:crypto";
import type { Page } from "@playwright/test";

const MARKER_PREFIX = "__KANDELO_TERMINAL_";
const MARKER_SUFFIX = "__";
const MARKER_ID_PATTERN = /^[a-z0-9]+$/;

export interface TerminalCommandProtocol {
  command: string;
  startMarker: string;
  endMarker: string;
}

export interface TerminalCommandResult {
  output: string;
  exitCode: number;
}

function encodeShellSource(source: string): string {
  if (source.includes("\0")) {
    throw new Error("terminal command source cannot contain NUL");
  }

  // WHY: Playwright's insertText reaches xterm through its single-line input
  // path, which discards literal CR/LF bytes. Octal escapes preserve the exact
  // source without relying on optional guest utilities such as base64.
  const guardedSource = `${source}\n# Kandelo terminal transport guard preserves trailing newlines`;
  return Array.from(
    new TextEncoder().encode(guardedSource),
    (byte) => `\\0${byte.toString(8).padStart(3, "0")}`,
  ).join("");
}

function marker(kind: "START" | "END", id: string): string {
  return `${MARKER_PREFIX}${kind}_${id}${MARKER_SUFFIX}`;
}

function markerPrint(kind: "START" | "END", id: string): string {
  // Split the marker across printf arguments so the terminal's echoed input
  // never contains the contiguous token that proves guest-side execution.
  return `printf '%s%s%s' '${MARKER_PREFIX}' '${kind}_' '${id}${MARKER_SUFFIX}'`;
}

export function buildTerminalCommand(
  source: string,
  id = randomBytes(12).toString("hex"),
): TerminalCommandProtocol {
  // The child keeps `exit`, shell options, and variables inside the command
  // while the interactive parent remains available to report its status.
  return buildFramedTerminalCommand(
    source,
    id,
    (encodedSource) => `/bin/bash -c "$(printf '%b' '${encodedSource}')" bash`,
  );
}

export function buildParentShellProbe(
  source: string,
  id = randomBytes(12).toString("hex"),
): TerminalCommandProtocol {
  return buildFramedTerminalCommand(
    source,
    id,
    (encodedSource) => `eval "$(printf '%b' '${encodedSource}')"`,
  );
}

function buildFramedTerminalCommand(
  source: string,
  id: string,
  execution: (encodedSource: string) => string,
): TerminalCommandProtocol {
  if (!MARKER_ID_PATTERN.test(id)) {
    throw new Error(
      "terminal command marker id must be lowercase alphanumeric",
    );
  }

  const encodedSource = encodeShellSource(source);
  const statusVariable = `__kandelo_terminal_status_${id}`;
  const statusExpansion = "${" + statusVariable + "}";
  const startMarker = marker("START", id);
  const endMarker = marker("END", id);
  const command = [
    markerPrint("START", id),
    // A conditional preserves the real execution status without letting an
    // ordinary failure skip the completion frame.
    `if ${execution(encodedSource)}`,
    `then ${statusVariable}=0`,
    `else ${statusVariable}=$?`,
    "fi",
    `${markerPrint("END", id)}:${statusExpansion}`,
    `unset ${statusVariable}`,
  ].join("; ");

  if (/[\r\n]/.test(command)) {
    throw new Error("terminal transport command must be one physical line");
  }
  if (command.includes(startMarker) || command.includes(endMarker)) {
    throw new Error(
      "terminal transport markers must not appear in echoed input",
    );
  }

  return { command, startMarker, endMarker };
}

export function parseTerminalCommandResult(
  transcript: string,
  protocol: Pick<TerminalCommandProtocol, "startMarker" | "endMarker">,
): TerminalCommandResult | undefined {
  const start = transcript.lastIndexOf(protocol.startMarker);
  if (start < 0) return undefined;

  const outputStart = start + protocol.startMarker.length;
  const statusPrefix = `${protocol.endMarker}:`;
  const end = transcript.indexOf(statusPrefix, outputStart);
  if (end < 0) return undefined;

  const statusText = transcript.slice(end + statusPrefix.length);
  const statusMatch = /^([0-9]{1,3})(?![0-9])/.exec(statusText);
  if (!statusMatch) return undefined;
  const exitCode = Number(statusMatch[1]);
  if (exitCode > 255) {
    throw new Error(
      `terminal command reported invalid exit status ${exitCode}`,
    );
  }

  return {
    output: transcript.slice(outputStart, end),
    exitCode,
  };
}

function matchesExpected(output: string, expected: string | RegExp): boolean {
  if (typeof expected === "string") return output.includes(expected);
  return new RegExp(expected.source, expected.flags).test(output);
}

export function assertTerminalCommandResult(
  result: TerminalCommandResult,
  expected?: string | RegExp,
): TerminalCommandResult {
  if (result.exitCode !== 0) {
    throw new Error(
      `terminal command exited with status ${result.exitCode}: ${result.output}`,
    );
  }
  if (expected !== undefined && !matchesExpected(result.output, expected)) {
    throw new Error(
      `terminal command completed without ${String(expected)} in its output: ${result.output}`,
    );
  }
  return result;
}

async function terminalText(page: Page): Promise<string> {
  return page
    .locator(".xterm-rows")
    .first()
    .evaluate((node) => node.textContent ?? "");
}

export async function runTerminalCommand(
  page: Page,
  source: string,
  expected?: string | RegExp,
  timeout = 180_000,
): Promise<TerminalCommandResult> {
  const protocol = buildTerminalCommand(source);
  return runTerminalProtocol(page, protocol, expected, timeout);
}

/**
 * Observe the interactive parent shell without replacing it with child Bash.
 *
 * Keep probes read-only: `exit`, shell options, and variable mutations would
 * affect the actual interactive session because this deliberately uses eval.
 */
export async function runParentShellProbe(
  page: Page,
  source: string,
  expected?: string | RegExp,
  timeout = 180_000,
): Promise<TerminalCommandResult> {
  const protocol = buildParentShellProbe(source);
  return runTerminalProtocol(page, protocol, expected, timeout);
}

async function runTerminalProtocol(
  page: Page,
  protocol: TerminalCommandProtocol,
  expected: string | RegExp | undefined,
  timeout: number,
): Promise<TerminalCommandResult> {
  const input = page.getByRole("textbox", { name: "Terminal input" }).first();
  if (await input.count()) {
    await input.focus();
  } else {
    await page.locator(".kshell-host").first().click();
  }
  await page.keyboard.insertText(protocol.command);
  await page.waitForTimeout(250);
  await page.keyboard.press("Enter");

  const deadline = Date.now() + timeout;
  let transcript = "";
  while (Date.now() < deadline) {
    transcript = await terminalText(page);
    const result = parseTerminalCommandResult(transcript, protocol);
    if (result !== undefined) {
      return assertTerminalCommandResult(result, expected);
    }
    await page.waitForTimeout(100);
  }

  throw new Error(
    `timed out waiting for terminal command completion: ${transcript}`,
  );
}
