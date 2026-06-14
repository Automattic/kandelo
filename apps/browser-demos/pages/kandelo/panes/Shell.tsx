// Shell pane — xterm.js attached to a PtyHandle from host.attachPty().
//
// Falls back to a placeholder banner before the PTY is ready (and while
// status === 'idle' / 'booting'). Resizes the PTY when xterm fits its
// container. Disposes the terminal on unmount.

import * as React from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

import { useKernelHost, useStatus } from "../kernel-host/react";
import type { PtyHandle } from "../../../../../web-libs/kandelo-session/src/kernel-host";
import { PaneHead } from "./PaneHead";

const ICON = (
  <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
    <path d="M2 3l3 3-3 3M6 9.5h5" />
  </svg>
);

const SHELL_THEME = {
  background: "#1a1208",
  foreground: "#f4dca0",
  cursor: "#f08a2c",
  cursorAccent: "#1a1208",
  selectionBackground: "rgba(240,138,44,0.32)",
};

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
  dragProps,
  onCollapse,
  onMaximize,
  isMax,
  autoFocus = false,
  terminals: controlledTerminals,
  activeTerminalId: controlledActiveTerminalId,
  onActiveTerminalId,
  onAddTerminal,
}) => {
  const [localTerminals, setLocalTerminals] = React.useState<ShellTerminal[]>(() => [createShellTerminal(1)]);
  const [localActiveTerminalId, setLocalActiveTerminalId] = React.useState("tty-1");
  const nextLocalTerminalIndex = React.useRef(2);

  const terminals = controlledTerminals ?? localTerminals;
  const activeTerminalId = controlledActiveTerminalId ?? localActiveTerminalId;
  const activeTerminal = terminals.find((terminal) => terminal.id === activeTerminalId) ?? terminals[0];

  const setActiveTerminal = React.useCallback((id: string) => {
    if (onActiveTerminalId) onActiveTerminalId(id);
    else setLocalActiveTerminalId(id);
  }, [onActiveTerminalId]);

  const addTerminal = React.useCallback(() => {
    if (onAddTerminal) {
      onAddTerminal();
      return;
    }
    const next = createShellTerminal(nextLocalTerminalIndex.current++);
    setLocalTerminals((prev) => [...prev, next]);
    setLocalActiveTerminalId(next.id);
  }, [onAddTerminal]);

  React.useEffect(() => {
    if (!activeTerminal && terminals[0]) setActiveTerminal(terminals[0].id);
  }, [activeTerminal, setActiveTerminal, terminals]);

  const tabStrip = (
    <div
      className="kshell-tabs"
      role="tablist"
      aria-label="Terminals"
      onDragStart={(event) => event.stopPropagation()}
    >
      {terminals.map((terminal) => (
        <button
          key={terminal.id}
          type="button"
          className="kshell-tab"
          role="tab"
          aria-selected={terminal.id === activeTerminal?.id}
          onClick={(event) => {
            event.stopPropagation();
            setActiveTerminal(terminal.id);
          }}
        >
          {terminal.label}
        </button>
      ))}
      <button
        type="button"
        className="kshell-tab-add"
        title="New terminal"
        aria-label="New terminal"
        onClick={(event) => {
          event.stopPropagation();
          addTerminal();
        }}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M6 2v8M2 6h8" />
        </svg>
      </button>
    </div>
  );

  return (
    <div className="kpane">
      <PaneHead
        icon={ICON}
        title={activeTerminal ? `${activeTerminal.label} · /BIN/SH` : "TERMINAL"}
        right={tabStrip}
        dragProps={dragProps}
        onCollapse={onCollapse}
        onMaximize={onMaximize}
        isMax={isMax}
      />
      <div className="kpane-body kshell-body">
        {activeTerminal && (
          <ShellTerminalHost
            key={activeTerminal.id}
            terminal={activeTerminal}
            autoFocus={autoFocus}
          />
        )}
      </div>
    </div>
  );
};

const ShellTerminalHost: React.FC<{
  terminal: ShellTerminal;
  autoFocus: boolean;
}> = ({ terminal, autoFocus }) => {
  const host = useKernelHost();
  const status = useStatus();
  const containerRef = React.useRef<HTMLDivElement>(null);
  const ptyRef = React.useRef<PtyHandle | null>(null);
  const [attached, setAttached] = React.useState(false);
  const [attachError, setAttachError] = React.useState<string | null>(null);

  React.useEffect(() => {
    // Don't open the PTY until the kernel is running. The chassis-driven
    // status comes from useStatus after the live boot path finishes.
    if (status !== "running") return;
    if (!containerRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace',
      theme: SHELL_THEME,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();
    let unsubData = () => {};
    let disposed = false;
    const focusTerm = () => {
      if (!autoFocus) return;
      window.requestAnimationFrame(() => {
        if (!disposed) term.focus();
      });
    };
    focusTerm();

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
          fit.fit();
        });
        ro.observe(containerRef.current!);
        setAttached(true);
        focusTerm();

        // store extra disposers via the unsubData closure
        const origUnsubData = unsubData;
        unsubData = () => {
          origUnsubData();
          onInput.dispose();
          onResize.dispose();
          ro.disconnect();
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
      term.dispose();
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

const PreBoot: React.FC<{ status: string }> = ({ status }) => (
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
|  | | |  |    image: b3:9f2a3b81d2c47f1e
|__|_|_|__|    Waiting for the kernel to reach 'running'.`}
    </pre>
    <span className="kshell-dim">user@kandelo</span>
    <span className="kshell-dim">:~$ </span>
    <span className="kshell-cursor" />
  </div>
);
