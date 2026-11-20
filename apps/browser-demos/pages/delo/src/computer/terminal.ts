// The terminal of a delo computer: xterm.js on the computer's first PTY.

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { KernelHost } from "../../../../../../web-libs/kandelo-session/src/kernel-host";
import type { OpenSurface } from "./surface";

const PTY_PATH = "/dev/pts/0";

export interface OpenTerminal extends OpenSurface {
  /** Read the page theme's colors again. */
  retheme(): void;
  /** The text the terminal shows, one line per row. */
  screen(): string;
  /** Type `text` as the user's keys do; false while the terminal is not attached. */
  type(text: string): boolean;
}

const themeOf = (container: HTMLElement) => {
  const colors = getComputedStyle(container);
  return {
    background: colors.getPropertyValue("--delo-terminal-bg").trim(),
    foreground: colors.getPropertyValue("--delo-terminal-text").trim(),
    cursor: colors.getPropertyValue("--delo-accent").trim(),
    selectionBackground: colors.getPropertyValue("--delo-selection").trim(),
  };
};

export function openTerminal(host: KernelHost, container: HTMLElement): OpenTerminal {
  const term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace',
    theme: themeOf(container),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(container);
  fit.fit();
  term.focus();
  let attached = false;
  new ResizeObserver(() => fit.fit()).observe(container);
  void host.attachPty(PTY_PATH, { cols: term.cols, rows: term.rows }).then((pty) => {
    pty.onData((bytes) => term.write(bytes));
    term.onData((data) => pty.write(data));
    term.onResize(({ cols, rows }) => pty.resize(cols, rows));
    pty.resize(term.cols, term.rows);
    attached = true;
  }, (error) => term.writeln(`delo: the terminal could not attach: ${error instanceof Error ? error.message : String(error)}`));
  return {
    focus: () => term.focus(),
    retheme: () => {
      term.options.theme = themeOf(container);
    },
    screen: () => {
      const buffer = term.buffer.active;
      return Array.from({ length: term.rows }, (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "").join("\n");
    },
    type: (text) => {
      if (!attached) return false;
      term.input(text);
      return true;
    },
  };
}
