// Shell pane — xterm.js attached to a PtyHandle from host.attachPty().
//
// Falls back to a placeholder banner before the PTY is ready (and while
// status === 'idle' / 'booting'). Resizes the PTY when xterm fits its
// container. Disposes the terminal on unmount.

import * as React from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

import { useBootProgress, useKernelHost, useStatus } from "../kernel-host/react";
import type {
  BootProgress,
  PtyHandle,
} from "../../../../../web-libs/kandelo-session/src/kernel-host";
import type { TerminalLinkContext } from "../../../../../web-libs/kandelo-session/src/terminal-links";
import { registerTerminalLinks } from "../../../lib/terminal-links";
import { requestTerminalAutoFocus } from "./terminal-focus";

export interface ShellProps {
  dragProps?: import("./PaneHead").PaneHeadDragProps;
  onCollapse?: () => void;
  onMaximize?: () => void;
  isMax?: boolean;
  autoFocus?: boolean;
  terminals?: ShellTerminal[];
  activeTerminalId?: string;
  onActiveTerminalId?: (id: string) => void;
  onAddTerminal?: () => void;
}

export interface ShellTerminal {
  id: string;
  label: string;
  path: string;
}

export function createShellTerminal(index: number): ShellTerminal {
  return {
    id: `tty-${index}`,
    label: `TTY${index}`,
    path: `/dev/pts/${index - 1}`,
  };
}

export const Shell: React.FC<ShellProps> = ({
  autoFocus = false,
  terminals: controlledTerminals,
  activeTerminalId: controlledActiveTerminalId,
  onActiveTerminalId,
}) => {
  const [localTerminals] = React.useState<ShellTerminal[]>(() => [createShellTerminal(1)]);
  const [localActiveTerminalId, setLocalActiveTerminalId] = React.useState("tty-1");

  const terminals = controlledTerminals ?? localTerminals;
  const activeTerminalId = controlledActiveTerminalId ?? localActiveTerminalId;
  const activeTerminal = terminals.find((terminal) => terminal.id === activeTerminalId) ?? terminals[0];
  const focusTerminalRef = React.useRef<(() => void) | null>(null);
  const setFocusTerminal = React.useCallback((focusTerminal: (() => void) | null) => {
    focusTerminalRef.current = focusTerminal;
  }, []);

  const setActiveTerminal = React.useCallback((id: string) => {
    if (onActiveTerminalId) onActiveTerminalId(id);
    else setLocalActiveTerminalId(id);
  }, [onActiveTerminalId]);

  React.useEffect(() => {
    if (!activeTerminal && terminals[0]) setActiveTerminal(terminals[0].id);
  }, [activeTerminal, setActiveTerminal, terminals]);

  return (
    <div
      className="kshell-surface"
      onPointerDown={() => {
        focusTerminalRef.current?.();
      }}
    >
      {activeTerminal && (
        <ShellTerminalHost
          key={activeTerminal.id}
          terminal={activeTerminal}
          autoFocus={autoFocus}
          onFocusTerminalChange={setFocusTerminal}
        />
      )}
    </div>
  );
};

const ShellTerminalHost: React.FC<{
  terminal: ShellTerminal;
  autoFocus: boolean;
  onFocusTerminalChange: (focusTerminal: (() => void) | null) => void;
}> = ({ terminal, autoFocus, onFocusTerminalChange }) => {
  const host = useKernelHost();
  const status = useStatus();
  const containerRef = React.useRef<HTMLDivElement>(null);
  const terminalRef = React.useRef<Terminal | null>(null);
  const ptyRef = React.useRef<PtyHandle | null>(null);
  const [attached, setAttached] = React.useState(false);
  const [attachError, setAttachError] = React.useState<string | null>(null);

  React.useEffect(() => {
    onFocusTerminalChange(() => {
      terminalRef.current?.focus();
    });
    return () => onFocusTerminalChange(null);
  }, [onFocusTerminalChange]);

  React.useEffect(() => {
    // Don't open the PTY until the kernel is running. The chassis-driven
    // status comes from useStatus after the live boot path finishes.
    if (status !== "running") return;
    if (!containerRef.current) return;

    // React StrictMode mounts this effect twice. Clear renderer nodes that
    // xterm leaves behind without removing the host-owned logical PTY.
    containerRef.current.replaceChildren();

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace',
      theme: readShellTheme(containerRef.current),
      allowProposedApi: true,
    });
    terminalRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    const applyTheme = () => {
      term.options.theme = readShellTheme(containerRef.current);
    };
    applyTheme();
    const themeObserver = new MutationObserver(applyTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-k-theme", "data-k-mode", "style"],
    });
    const links = registerTerminalLinks(term, (): TerminalLinkContext => {
      // Pull the preview on demand rather than subscribing. This callback only
      // runs while resolving a hovered link, and `setWebPreviewPendingRequests`
      // fires on every HTTP request through the bridge — subscribing here would
      // re-render the live terminal host on each one.
      const preview = host.getWebPreview();
      // Loopback URLs the machine prints are reachable from the page only
      // through a running HTTP bridge, and only on the one port it forwards.
      const machine = preview && preview.status === "running" && typeof preview.port === "number"
        ? { url: preview.url, port: preview.port }
        : null;
      return { pageUrl: window.location.href, machine };
    });
    let unsubData = () => {};
    let disposed = false;
    // Fitting the terminal depends on the flex layout, the dock's reserved
    // height (--kdock-height), and xterm's character measurement all being
    // final. None of those are guaranteed on this first synchronous pass, so a
    // single fit here can spawn the shell at the wrong winsize and leave it
    // there — the ResizeObserver below only re-fits on a box-size change, so
    // without this the size stays wrong until the user physically resizes the
    // window. safeFit() is retried after layout settles (see resettle below).
    const safeFit = () => {
      if (disposed || !containerRef.current) return;
      try {
        fit.fit();
      } catch {
        /* xterm can throw if measured before layout; a later pass retries */
      }
    };
    safeFit();
    const focusTerminal = () => {
      term.focus();
      window.requestAnimationFrame(() => {
        if (!disposed) term.focus();
      });
    };
    const onDocumentPointerDown = (event: PointerEvent) => {
      const surface = containerRef.current?.closest(".kshell-surface");
      if (!(surface instanceof HTMLElement)) return;
      if (shouldIgnoreTerminalFocusTarget(event.target)) return;

      const rect = surface.getBoundingClientRect();
      if (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      ) {
        return;
      }
      focusTerminal();
    };
    const focusTerm = () => {
      const container = containerRef.current;
      if (!container) return;
      requestTerminalAutoFocus({
        autoFocus,
        container,
        focusTerminal: () => term.focus(),
        isDisposed: () => disposed,
      });
    };
    focusTerm();
    document.addEventListener("pointerdown", onDocumentPointerDown, true);

    void (async () => {
      try {
        const pty = await host.attachPty(terminal.path, {
          cols: term.cols,
          rows: term.rows,
        });
        if (disposed) {
          pty.close();
          return;
        }
        ptyRef.current = pty;
        unsubData = pty.onData((bytes) => term.write(bytes));
        const onInput = term.onData((data) => pty.write(data));
        const onResize = term.onResize(({ cols, rows }) => pty.resize(cols, rows));
        const ro = new ResizeObserver(() => {
          safeFit();
        });
        ro.observe(containerRef.current!);
        setAttached(true);
        focusTerm();

        // The shell was spawned with the first (possibly premature) fit. Re-fit
        // once the browser has laid out and painted this subtree (two frames)
        // and once web fonts have settled, then push the result to the PTY.
        // term.onResize only fires when the dimensions actually change, so an
        // explicit resize is needed for the case where the corrected fit equals
        // the size the shell was spawned with yet the kernel winsize is stale.
        // Without this the terminal only becomes correct after a manual window
        // resize (the sole event that re-fits).
        let rafId = 0;
        const resettle = () => {
          safeFit();
          if (!disposed) pty.resize(term.cols, term.rows);
        };
        rafId = window.requestAnimationFrame(() => {
          rafId = window.requestAnimationFrame(resettle);
        });
        void document.fonts?.ready?.then(() => {
          if (!disposed) resettle();
        });

        // store extra disposers via the unsubData closure
        const origUnsubData = unsubData;
        unsubData = () => {
          origUnsubData();
          onInput.dispose();
          onResize.dispose();
          ro.disconnect();
          if (rafId) window.cancelAnimationFrame(rafId);
        };
      } catch (err) {
        setAttachError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      disposed = true;
      try { unsubData(); } catch { /* noop */ }
      if (ptyRef.current) {
        try { ptyRef.current.close(); } catch { /* noop */ }
        ptyRef.current = null;
      }
      document.removeEventListener("pointerdown", onDocumentPointerDown, true);
      themeObserver.disconnect();
      links.dispose();
      term.dispose();
      terminalRef.current = null;
      setAttached(false);
    };
  }, [autoFocus, host, status, terminal.path]);

  return (
    <>
      {status === "running" ? (
        <div className="kshell-host" ref={containerRef} />
      ) : (
        <PreBoot status={status} />
      )}
      {attachError && (
        <div style={{ color: "var(--k-err)", padding: "8px 12px", fontFamily: "var(--k-font-mono)", fontSize: 11 }}>
          attachPty failed: {attachError}
        </div>
      )}
      {/* attached is used purely to keep the effect's value in sync with
          React's reconciler; intentionally not rendered. */}
      <span style={{ display: "none" }}>{attached ? "attached" : "idle"}</span>
    </>
  );
};

const PreBoot: React.FC<{ status: string }> = ({ status }) => {
  const progress = useBootProgress();
  // Name the image actually being loaded. Before the load starts there is
  // nothing truthful to show, so say so rather than printing a stand-in.
  const image = progress?.label ?? "(not loaded yet)";

  return (
    <div className="kshell-placeholder">
      <pre style={{
        margin: "0 0 10px",
        color: "var(--k-accent-fire)",
        fontFamily: "inherit",
        fontSize: 11,
        lineHeight: 1.1,
      }}>
{`      (        Kandelo Linux 6.8.0
       )       Booting a browser VFS image.
      (
 ___|||___     status: ${status}
|  | | |  |    image: ${image}
|__|_|_|__|    Waiting for the kernel to reach 'running'.`}
      </pre>
      <BootProgressBar progress={progress} />
      <span className="kshell-dim">maker@kandelo</span>
      <span className="kshell-dim">:~$ </span>
      <span className="kshell-cursor" />
    </div>
  );
};

/**
 * Progress of the root VFS image load.
 *
 * This measures bytes materialized, not bytes off the network: a service
 * worker serves shipped images cache-first, so a warm cache fills the bar
 * almost at once. That is still the wait the user experiences, which is why
 * the label reads "loading" rather than "downloading".
 */
const BootProgressBar: React.FC<{ progress: BootProgress | null }> = ({
  progress,
}) => {
  if (progress === null) return null;

  const pct = progress.totalBytes && progress.totalBytes > 0
    ? Math.min(100, Math.max(0, (progress.loadedBytes / progress.totalBytes) * 100))
    : null;
  const detail = progress.status === "error"
    ? progress.error ?? "failed"
    : `${humanBytes(progress.loadedBytes)}${
      progress.totalBytes ? ` / ${humanBytes(progress.totalBytes)}` : ""
    }`;

  return (
    <div className={`kpreboot-progress kpreboot-progress-${progress.status}`}>
      <div className="kpreboot-progress-top">
        <span>loading {progress.label}</span>
        <span className="kpreboot-progress-detail">
          {progress.status === "error"
            ? "ERR"
            : pct === null
            ? "..."
            : `${Math.round(pct)}%`}
        </span>
      </div>
      <div
        className={`kpreboot-bar${pct === null ? " indeterminate" : ""}`}
        role="progressbar"
        aria-label={`Loading ${progress.label}`}
        {...(pct === null
          ? { "aria-valuetext": detail }
          : {
            "aria-valuenow": Math.round(pct),
            "aria-valuemin": 0,
            "aria-valuemax": 100,
          })}
      >
        <span style={{ width: pct === null ? "44%" : `${pct}%` }} />
      </div>
      <div className="kpreboot-progress-detail">{detail}</div>
    </div>
  );
};

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(kib < 10 ? 1 : 0)} KiB`;
  const mib = kib / 1024;
  return `${mib.toFixed(mib < 10 ? 1 : 0)} MiB`;
}

function readShellTheme(element: HTMLElement | null) {
  const styles = getComputedStyle(element ?? document.documentElement);
  const background = cssToken(styles, "--k-shell-bg", "#1e2327");
  return {
    background,
    foreground: cssToken(styles, "--k-shell-text", "#e5e6e6"),
    cursor: cssToken(styles, "--k-shell-prompt", "#fcd34d"),
    cursorAccent: background,
    selectionBackground: cssToken(styles, "--k-shell-selection", "rgba(56, 88, 233, 0.32)"),
    black: cssToken(styles, "--k-shell-ansi-black", "#1e2327"),
    red: cssToken(styles, "--k-shell-ansi-red", "#fa383e"),
    green: cssToken(styles, "--k-shell-ansi-green", "#00a400"),
    yellow: cssToken(styles, "--k-shell-ansi-yellow", "#ffba00"),
    blue: cssToken(styles, "--k-shell-ansi-blue", "#3858e9"),
    magenta: cssToken(styles, "--k-shell-ansi-magenta", "#a855f7"),
    cyan: cssToken(styles, "--k-shell-ansi-cyan", "#0891b2"),
    white: cssToken(styles, "--k-shell-ansi-white", "#e5e6e6"),
    brightBlack: cssToken(styles, "--k-shell-ansi-bright-black", "#9ca3af"),
    brightRed: cssToken(styles, "--k-shell-ansi-bright-red", "#ff8a8f"),
    brightGreen: cssToken(styles, "--k-shell-ansi-bright-green", "#7ee787"),
    brightYellow: cssToken(styles, "--k-shell-ansi-bright-yellow", "#fcd34d"),
    brightBlue: cssToken(styles, "--k-shell-ansi-bright-blue", "#93a4ff"),
    brightMagenta: cssToken(styles, "--k-shell-ansi-bright-magenta", "#d8b4fe"),
    brightCyan: cssToken(styles, "--k-shell-ansi-bright-cyan", "#67e8f9"),
    brightWhite: cssToken(styles, "--k-shell-ansi-bright-white", "#ffffff"),
  };
}

function cssToken(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  return styles.getPropertyValue(name).trim() || fallback;
}

function shouldIgnoreTerminalFocusTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest([
    ".kdock-shell",
    ".kdock-popover",
    ".kdock-pane",
    ".kdownload-toasts",
    "a",
    "button",
    "input",
    "select",
    "textarea",
    "[role='button']",
    "[role='tab']",
  ].join(",")) !== null;
}
