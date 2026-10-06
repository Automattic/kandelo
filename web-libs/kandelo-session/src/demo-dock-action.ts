// Image-declared dock buttons that replace a machine's foreground program.
//
// The capability is declared in the VFS image (`/etc/kandelo/demo.json` →
// `dockActions`) and executed here. A display machine's command is a
// long-lived foreground program (ScummVM, DOOM) that owns the machine's
// terminal and a single-owner display device, so running another command
// means ending that program first. This does it the way a person at the
// terminal would: Ctrl+C, which the kernel's PTY line discipline turns into
// SIGINT for the foreground process group, then the new command once the
// shell's prompt is back. The prompt is the evidence the old program exited
// and released its devices; without it the action fails rather than typing
// into a program that is still running.
//
// The command is the image author's `restart` string, never user input.

import type { DemoDockCommandConfig } from "./demo-config";
import type { KernelHost } from "./kernel-host";

export type DockActionPhase = "stopping" | "starting" | "done";

export interface RunDemoDockActionOptions {
  /**
   * Awaited before the next step, so a caller can attach to the terminal in
   * `starting` and see the command's first line of output.
   */
  onPhase?: (phase: DockActionPhase) => void | Promise<void>;
  /** How long the foreground program has to exit after Ctrl+C. */
  stopTimeoutMs?: number;
}

export async function runDemoDockAction(
  host: KernelHost,
  action: DemoDockCommandConfig,
  options: RunDemoDockActionOptions = {},
): Promise<void> {
  const { onPhase = () => {}, stopTimeoutMs = 10_000 } = options;
  await onPhase("stopping");
  await host.interruptShellForeground({ timeoutMs: stopTimeoutMs });
  await onPhase("starting");
  // Like the machine's own command, the restart is usually a long-lived
  // foreground program: resolve on the PTY write, not on a later prompt.
  await host.dispatchShellCommand(action.restart);
  await onPhase("done");
}

/**
 * What the action's program says it is doing, read from the machine's
 * terminal output. The display is dark between Ctrl+C and the replacement's
 * first frame (for a download that is most of a minute), so the UI shows the
 * program's own words rather than a spinner that knows nothing.
 *
 * The convention is the one Unix tools already use: a program prefixes its
 * status lines with its own name (`scummvm-play: Verifying…`). Only
 * those lines become the status, so a replacement engine's start-up warnings
 * cannot masquerade as progress. A `#` bar ending in a percentage (curl's
 * `--progress-bar`, redrawn with carriage returns) becomes `percent`, which a
 * new status line resets.
 */
export interface DockActionProgress {
  status: string | null;
  percent: number | null;
}

// CSI sequences (colours, cursor moves) and the few two-byte escapes a
// terminal program emits; none of them are text.
const ANSI_ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b[()][A-Za-z0-9]|\x1b[=>]/g;
const PROGRESS_BAR = /^#[#\s]*?(\d{1,3}(?:\.\d+)?)%$/;

/** The command's program name: the basename of its first word. */
export function dockActionProgramName(restart: string): string {
  const program = restart.trim().split(/\s+/, 1)[0] ?? "";
  return program.slice(program.lastIndexOf("/") + 1);
}

export function dockActionProgress(output: string, programName: string): DockActionProgress {
  const prefix = `${programName}: `;
  let status: string | null = null;
  let percent: number | null = null;
  for (const segment of output.replace(ANSI_ESCAPE, "").split(/\r\n|\n|\r/)) {
    const line = segment.trim();
    if (line.startsWith(prefix)) {
      status = line.slice(prefix.length);
      percent = null;
      continue;
    }
    const bar = PROGRESS_BAR.exec(line);
    if (bar) percent = Math.min(100, Number(bar[1]));
  }
  return { status, percent };
}

/**
 * Whether the shell has printed its prompt again, i.e. the action's command
 * exited instead of becoming the machine's new foreground program.
 *
 * Only the last line counts, and only if nothing redrew it: curl's progress
 * bar is a run of `#` redrawn with carriage returns, and a bar that has
 * reached `#   ` looks exactly like a root prompt's `# ` ending.
 */
export function shellPromptReturned(output: string): boolean {
  const text = output.replace(ANSI_ESCAPE, "");
  const lastLine = text.slice(text.lastIndexOf("\n") + 1);
  return !lastLine.includes("\r")
    && /[$#] $/.test(lastLine)
    && !/^[#\s]*$/.test(lastLine);
}

/**
 * Stream what the machine's shell PTY prints from now on. Output the PTY
 * replays to a new subscriber is history, not progress, so it is skipped.
 * Returns the unsubscribe.
 */
export async function followShellOutput(
  host: KernelHost,
  onText: (text: string) => void,
): Promise<() => void> {
  const pty = await host.attachPty("/dev/pts/0");
  const decoder = new TextDecoder();
  let replayingHistory = true;
  const off = pty.onData((bytes) => {
    if (replayingHistory) return;
    onText(decoder.decode(bytes, { stream: true }));
  });
  replayingHistory = false;
  return () => {
    off();
    pty.close();
  };
}
