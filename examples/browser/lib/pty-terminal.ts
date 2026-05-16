/**
 * PtyTerminal — connects xterm.js to a BrowserKernel PTY.
 *
 * Provides a real terminal experience: ANSI escape rendering, cursor,
 * scrollback, line editing via kernel line discipline, and proper
 * isatty()/termios for programs.
 */
import { Terminal, type ITerminalOptions } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { BrowserKernel, BrowserKernelBootOptions } from "./browser-kernel";

const encoder = new TextEncoder();

export interface PtyTerminalOptions extends ITerminalOptions {
  /** Whether to auto-fit the terminal to its container on resize (default: true) */
  autoFit?: boolean;
}

export class PtyTerminal {
  readonly terminal: Terminal;
  private fitAddon: FitAddon;
  private pid: number = -1;
  private kernel: BrowserKernel;
  private disposables: Array<{ dispose(): void }> = [];
  private resizeObserver: ResizeObserver | null = null;

  constructor(container: HTMLElement, kernel: BrowserKernel, options?: PtyTerminalOptions) {
    this.kernel = kernel;

    const { autoFit, ...termOptions } = options ?? {};

    this.terminal = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
      theme: {
        background: "#1e1e1e",
        foreground: "#d4d4d4",
        cursor: "#d4d4d4",
      },
      ...termOptions,
    });

    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.open(container);
    this.fitAddon.fit();

    // Auto-fit on container resize
    if (autoFit !== false) {
      this.resizeObserver = new ResizeObserver(() => this.fit());
      this.resizeObserver.observe(container);
    }
  }

  /**
   * Spawn a program with PTY-backed stdio and connect xterm.js I/O.
   * Returns a promise that resolves with the exit code.
   */
  async spawn(
    programBytes: ArrayBuffer,
    argv: string[],
    options?: { env?: string[]; cwd?: string },
  ): Promise<number> {
    // Spawn with PTY enabled. Pass cols/rows pre-spawn so the very first
    // TIOCGWINSZ from the program returns the real width instead of the
    // kernel's 80x24 default — TUI renderers that latch onto width on
    // startup otherwise render with the wrong dimensions until a
    // SIGWINCH arrives mid-render.
    const exitPromise = this.kernel.spawn(programBytes, argv, {
      ...options,
      pty: true,
      ptyCols: this.terminal.cols,
      ptyRows: this.terminal.rows,
    });

    // The spawn creates the process with the next pid. We need to find it.
    // BrowserKernel uses sequential pids starting from 1.
    // The pid is assigned inside spawn() before the worker starts.
    // We can get it from the exit promise's resolver tracking.
    // Since spawn returns immediately after creating the process, the pid
    // is the one that was just assigned. Access it via the kernel's internals.
    const pid = (this.kernel as any).nextPid - 1;
    this.pid = pid;

    // Connect PTY output → xterm.js
    this.kernel.onPtyOutput(pid, (data: Uint8Array) => {
      this.terminal.write(data);
    });

    // Connect xterm.js input → PTY master
    const dataDisposable = this.terminal.onData((data: string) => {
      if (this.pid < 0) return;
      this.kernel.ptyWrite(this.pid, encoder.encode(data));
    });
    this.disposables.push(dataDisposable);

    // Connect xterm.js resize -> PTY winsize. Initial winsize is set
    // pre-spawn via ptyCols/ptyRows above, so no startup ptyResize is
    // needed — a redundant call here would raise SIGWINCH on the
    // just-started process and could interrupt mid-render in TUIs.
    const resizeDisposable = this.terminal.onResize(({ cols, rows }) => {
      if (this.pid < 0) return;
      this.kernel.ptyResize(this.pid, rows, cols);
    });
    this.disposables.push(resizeDisposable);

    return exitPromise;
  }

  /**
   * Boot the kernel from a pre-built VFS image with PTY-backed stdio and
   * connect xterm.js I/O. Same as {@link BrowserKernel.boot} but with PTY
   * forced on. Returns a promise that resolves with the exit code.
   *
   * The kernel worker is the source of truth for the pid; we wait for the
   * spawn round-trip to know it. PTY output that arrives before the
   * onPtyOutput handler is registered is buffered in BrowserKernel and
   * drained when the handler attaches.
   */
  async boot(options: Omit<BrowserKernelBootOptions, "pty">): Promise<number> {
    const { pid, exit } = await this.kernel.boot({ ...options, pty: true });
    this.pid = pid;

    this.kernel.onPtyOutput(pid, (data: Uint8Array) => {
      this.terminal.write(data);
    });

    const dataDisposable = this.terminal.onData((data: string) => {
      if (this.pid < 0) return;
      this.kernel.ptyWrite(this.pid, encoder.encode(data));
    });
    this.disposables.push(dataDisposable);

    const resizeDisposable = this.terminal.onResize(({ cols, rows }) => {
      if (this.pid < 0) return;
      this.kernel.ptyResize(this.pid, rows, cols);
    });
    this.disposables.push(resizeDisposable);

    this.kernel.ptyResize(pid, this.terminal.rows, this.terminal.cols);

    return exit;
  }

  /**
   * Spawn a VFS-resident program with PTY-backed stdio and connect
   * xterm.js I/O. Same wiring as {@link PtyTerminal.spawn} but the
   * kernel reads the binary out of its own VFS instead of receiving
   * `programBytes` from the main thread. Required for `kernelOwnedFs`
   * demos where main-thread bytes don't exist.
   */
  async spawnFromVfs(
    programPath: string,
    argv: string[],
    options?: { env?: string[]; cwd?: string },
  ): Promise<number> {
    const { pid, exit } = await this.kernel.spawnFromVfs(programPath, argv, {
      ...options,
      pty: true,
    });
    this.pid = pid;

    this.kernel.onPtyOutput(pid, (data: Uint8Array) => {
      this.terminal.write(data);
    });

    const dataDisposable = this.terminal.onData((data: string) => {
      if (this.pid < 0) return;
      this.kernel.ptyWrite(this.pid, encoder.encode(data));
    });
    this.disposables.push(dataDisposable);

    const resizeDisposable = this.terminal.onResize(({ cols, rows }) => {
      if (this.pid < 0) return;
      this.kernel.ptyResize(this.pid, rows, cols);
    });
    this.disposables.push(resizeDisposable);

    this.kernel.ptyResize(pid, this.terminal.rows, this.terminal.cols);

    return exit;
  }

  /** Write data to the PTY (for injecting input programmatically). */
  write(data: string | Uint8Array): void {
    if (this.pid < 0) return;
    const bytes = typeof data === "string" ? encoder.encode(data) : data;
    this.kernel.ptyWrite(this.pid, bytes);
  }

  /** Fit the terminal to its container and update PTY winsize. */
  fit(): void {
    this.fitAddon.fit();
    if (this.pid >= 0) {
      this.kernel.ptyResize(this.pid, this.terminal.rows, this.terminal.cols);
    }
  }

  /** Dispose the terminal and all event listeners. */
  dispose(): void {
    this.pid = -1;
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    this.terminal.dispose();
  }
}
