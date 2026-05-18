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
import type { PtyHandle } from "../../../../../host/src/kandelo-ui/kernel-host";
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
}

export const Shell: React.FC<ShellProps> = ({ dragProps, onCollapse, onMaximize, isMax, autoFocus = false }) => {
  const host = useKernelHost();
  const status = useStatus();
  const containerRef = React.useRef<HTMLDivElement>(null);
  const ptyRef = React.useRef<PtyHandle | null>(null);
  const [attached, setAttached] = React.useState(false);
  const [attachError, setAttachError] = React.useState<string | null>(null);

  React.useEffect(() => {
    // Don't open the PTY until the kernel is running. The chassis-driven
    // status comes from useStatus; the MockKernelHost transitions to
    // 'running' once its boot log finishes replaying.
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
        const pty = await host.attachPty("/dev/pts/0", {
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
  }, [autoFocus, host, status]);

  return (
    <div className="kpane">
      <PaneHead
        icon={ICON}
        title="TTY1 · /BIN/SH"
        dragProps={dragProps}
        onCollapse={onCollapse}
        onMaximize={onMaximize}
        isMax={isMax}
      />
      <div className="kpane-body" style={{ background: "var(--k-shell-bg)" }}>
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
      </div>
    </div>
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
       )       Fold a computer into a URL.
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
