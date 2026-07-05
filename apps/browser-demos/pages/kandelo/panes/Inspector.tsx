// Inspector pane — live internals tabs.
//
// Each tab reads through the KernelHost interface. Methods whose live
// kernel-side endpoints are unavailable throw a clear "not implemented"
// error; the pane catches those and renders a host-endpoint placeholder.

import * as React from "react";
import { useKernelHost, useDmesg, useLazyDownloadLog } from "../kernel-host/react";
import type {
  DmesgLine, ProcessEvent, ProcessInfo, MountInfo, KernelStateKV,
  MemMapEntry, SyscallEvent, VfsDirent, LazyDownloadEvent,
} from "../../../../../web-libs/kandelo-session/src/kernel-host";

export const INSPECTOR_TABS = [
  { id: "syslog", label: "Syslog" },
  { id: "procs", label: "Procs" },
  { id: "vfs", label: "VFS" },
  { id: "lazy-load", label: "Lazy Load" },
  { id: "syscalls", label: "Syscalls" },
  { id: "config", label: "Config" },
];

const LABEL_BY_TAB = new Map(INSPECTOR_TABS.map((t) => [t.id, t.label]));

export const Inspector: React.FC<{
  tab: string;
  showTitle?: boolean;
  dragProps?: import("./PaneHead").PaneHeadDragProps;
  onCollapse?: () => void;
  onMaximize?: () => void;
  isMax?: boolean;
}> = ({ tab, showTitle = true }) => {
  const lines = useDmesg();
  const activeTab = normalizeInspectorTab(tab);
  const title = LABEL_BY_TAB.get(activeTab) ?? activeTab;
  return (
    <div className="kinternals-surface">
      {showTitle && <div className="kinternals-title">{title}</div>}
      <div className="kinternals-body">
        {activeTab === "syslog" && <SyslogTable lines={lines} />}
        {activeTab === "procs" && <ProcsTab />}
        {activeTab === "vfs" && <VfsTab />}
        {activeTab === "lazy-load" && <LazyLoadTab />}
        {activeTab === "config" && <ConfigTab />}
        {activeTab === "syscalls" && <SyscallsTab />}
      </div>
    </div>
  );
};

function normalizeInspectorTab(tab: string): string {
  if (LABEL_BY_TAB.has(tab)) return tab;
  if (tab === "mounts" || tab === "kstate" || tab === "memmap") return "config";
  return "syslog";
}

// ── Syslog ────────────────────────────────────────────────────────────────

const SyslogTable: React.FC<{ lines: DmesgLine[] }> = ({ lines }) => {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines.length]);
  return (
    <div ref={ref} style={{ height: "100%", overflow: "auto", padding: "8px 0" }}>
      {lines.map((l, i) => (
        <div key={i} className="ksys-line">
          <span className="ksys-t">[{(l.t / 1000).toFixed(6).padStart(11, " ")}]</span>
          <span className={`ksys-lvl ksys-lvl-${l.level}`}>{l.level}</span>
          <span className="ksys-msg">{l.msg}</span>
        </div>
      ))}
    </div>
  );
};

// ── Hook: load-once, with a not-implemented graceful fallback ──────────────

type LoadState<T> =
  | { kind: "loading" }
  | { kind: "ready"; value: T }
  | { kind: "missing"; message: string }
  | { kind: "error"; message: string };

/**
 * Returns a counter that bumps whenever a process lifecycle event fires.
 * Pass this into a `useAsyncOnce` dep list to re-run the loader on each
 * spawn/exec/exit instead of polling.
 *
 * `match` is an optional filter: return `true` for events that should
 * trigger a re-run. Defaults to "any event."
 */
function useProcessEventBump(match?: (event: ProcessEvent) => boolean): number {
  const host = useKernelHost();
  const [n, setN] = React.useState(0);
  React.useEffect(() => {
    return host.subscribeProcessEvents((event) => {
      if (!match || match(event)) setN((v) => v + 1);
    });
    // `match` is captured at first render — we intentionally don't re-bind
    // the subscription if a parent passes a fresh closure each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host]);
  return n;
}

function useAsyncOnce<T>(load: () => Promise<T>, deps: React.DependencyList): LoadState<T> {
  const [state, setState] = React.useState<LoadState<T>>({ kind: "loading" });
  React.useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    void load().then(
      (value) => { if (!cancelled) setState({ kind: "ready", value }); },
      (err) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("not implemented yet")) {
          setState({ kind: "missing", message: msg });
        } else {
          setState({ kind: "error", message: msg });
        }
      },
    );
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

const MissingEndpoint: React.FC<{ label: string; detail: string }> = ({ label, detail }) => (
  <div style={{
    padding: "24px",
    color: "var(--k-text-faint)",
    fontFamily: "var(--k-font-mono)",
    fontSize: 12,
    lineHeight: 1.6,
  }}>
    <div style={{ color: "var(--k-text-muted)", marginBottom: 6 }}>
      {label.toUpperCase()} — host endpoint not wired
    </div>
    <div style={{ color: "var(--k-text-faint)", fontSize: 11.5 }}>
      {detail}
    </div>
    <div style={{ marginTop: 12, color: "var(--k-text-faint)", fontSize: 11 }}>
      Wire this when the matching method on{" "}
      <code style={{ color: "var(--k-accent)" }}>LiveKernelHost</code> is implemented.
      See{" "}
      <code style={{ color: "var(--k-accent)" }}>
        design_handoff_kandelo_ui/kernel-host-contract.md
      </code>{" "}
      under "What needs to be NEW in <code>kernel/</code> and <code>host/</code>".
    </div>
  </div>
);

const ErrorBox: React.FC<{ message: string }> = ({ message }) => (
  <div style={{
    padding: "16px 24px",
    color: "var(--k-err)",
    fontFamily: "var(--k-font-mono)",
    fontSize: 12,
  }}>
    Error: {message}
  </div>
);

// ── Procs ─────────────────────────────────────────────────────────────────

const ProcsTab: React.FC = () => {
  const host = useKernelHost();
  // Re-fetch the process table on every spawn/exec/exit. The host already
  // knows when these happen (kernel-worker posts exit messages, spawn
  // resolves on the main thread); we just re-run the snapshot loader.
  const bump = useProcessEventBump();
  const [expandedPid, setExpandedPid] = React.useState<number | null>(null);
  const state = useAsyncOnce<ProcessInfo[]>(() => host.enumProcs(), [host, bump]);

  React.useEffect(() => {
    if (state.kind !== "ready" || expandedPid === null) return;
    if (!state.value.some((p) => p.pid === expandedPid)) setExpandedPid(null);
  }, [state, expandedPid]);

  if (state.kind === "loading") return <Loading />;
  if (state.kind === "missing") return <MissingEndpoint label="Procs" detail={state.message} />;
  if (state.kind === "error") return <ErrorBox message={state.message} />;
  return (
    <table className="ktable">
      <thead>
        <tr>
          <th className="num">PID</th>
          <th className="num">PPID</th>
          <th>USER</th>
          <th className="num">MEMORY</th>
          <th>COMMAND</th>
        </tr>
      </thead>
      <tbody>
        {state.value.map((p) => {
          const expanded = expandedPid === p.pid;
          return (
            <React.Fragment key={p.pid}>
              <tr
                onClick={() => setExpandedPid((cur) => (cur === p.pid ? null : p.pid))}
                style={{
                  cursor: "pointer",
                  background: expanded ? "color-mix(in oklch, var(--k-accent) 7%, transparent)" : undefined,
                }}
              >
                <td className="num">
                  <span style={{
                    display: "inline-grid",
                    gridTemplateColumns: "12px 1fr",
                    alignItems: "center",
                    gap: 5,
                    minWidth: 54,
                  }}>
                    <span style={{ color: "var(--k-text-faint)", textAlign: "center" }}>
                      {expanded ? "▾" : "▸"}
                    </span>
                    <span>{p.pid}</span>
                  </span>
                </td>
                <td className="num dim">{p.ppid}</td>
                <td>{p.user}</td>
                <td className="num">{p.memory}</td>
                <td style={{ color: p.cmdline.startsWith("[") ? "var(--k-text-faint)" : "var(--k-text)" }}>{p.cmdline}</td>
              </tr>
              {expanded && (
                <tr>
                  <td colSpan={5} style={{ padding: 0, background: "var(--k-surface-sunk)" }}>
                    <ProcessMemoryDetails pid={p.pid} bump={bump} />
                  </td>
                </tr>
              )}
            </React.Fragment>
          );
        })}
      </tbody>
    </table>
  );
};

const ProcessMemoryDetails: React.FC<{ pid: number; bump: number }> = ({ pid, bump }) => {
  const host = useKernelHost();
  const state = useAsyncOnce<MemMapEntry[]>(() => host.readMemMap(pid), [host, pid, bump]);
  return (
    <div style={{ borderTop: "1px solid var(--k-border)", borderBottom: "1px solid var(--k-border)" }}>
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "7px 10px",
        color: "var(--k-text-muted)",
        fontFamily: "var(--k-font-mono)",
        fontSize: 11,
        borderBottom: "1px solid var(--k-border)",
      }}>
        <span>memory map · pid {pid}</span>
        <span>{state.kind === "ready" ? `${state.value.length} regions` : ""}</span>
      </div>
      {state.kind === "loading" && <Loading />}
      {state.kind === "missing" && <MissingEndpoint label="Memory map" detail={state.message} />}
      {state.kind === "error" && <ErrorBox message={state.message} />}
      {state.kind === "ready" && <MemMapTable entries={state.value} />}
    </div>
  );
};

// ── VFS browser ───────────────────────────────────────────────────────────

const VfsTab: React.FC = () => {
  const host = useKernelHost();
  const [path, setPath] = React.useState("/");
  const [selected, setSelected] = React.useState<{ path: string; entry: VfsDirent } | null>(null);
  const [refresh, setRefresh] = React.useState(0);
  const state = useAsyncOnce<VfsDirent[]>(
    () => host.readDir(path),
    [host, path, refresh],
  );
  const entries = React.useMemo(() => {
    if (state.kind !== "ready") return [];
    return state.value.slice().sort((a, b) => {
      if (a.kind === "d" && b.kind !== "d") return -1;
      if (a.kind !== "d" && b.kind === "d") return 1;
      return a.name.localeCompare(b.name);
    });
  }, [state]);

  React.useEffect(() => {
    setSelected(null);
  }, [path]);

  if (state.kind === "loading") return <Loading />;
  if (state.kind === "missing") return <MissingEndpoint label="VFS" detail={state.message} />;
  if (state.kind === "error") return <ErrorBox message={state.message} />;

  return (
    <div style={{ height: "100%", display: "grid", gridTemplateRows: "auto 1fr", minHeight: 0 }}>
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "7px 10px",
        borderBottom: "1px solid var(--k-border)",
        background: "var(--k-surface-alt)",
        fontFamily: "var(--k-font-mono)",
        fontSize: 11,
      }}>
        <button
          type="button"
          onClick={() => setPath(parentPath(path))}
          disabled={path === "/"}
          style={vfsButtonStyle}
          title="Parent directory"
        >
          ..
        </button>
        <div style={{
          display: "flex",
          alignItems: "center",
          minWidth: 0,
          flex: 1,
          color: "var(--k-text)",
          overflow: "hidden",
        }}>
          {pathSegments(path).map((seg, i, all) => {
            const nextPath = "/" + all.slice(1, i + 1).join("/");
            const actual = i === 0 ? "/" : normalizePath(nextPath);
            const label = i === 0 ? "/" : `${seg}/`;
            return (
              <React.Fragment key={`${seg}-${i}`}>
                {i > 0 && (
                  <span style={{
                    color: "var(--k-text-faint)",
                    fontSize: 10,
                    lineHeight: 1,
                    margin: "0 6px",
                    flexShrink: 0,
                  }}>
                    ·
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => setPath(actual)}
                  style={{
                    ...vfsCrumbStyle,
                    color: i === all.length - 1 ? "var(--k-text)" : "var(--k-accent)",
                  }}
                >
                  {label}
                </button>
              </React.Fragment>
            );
          })}
        </div>
        <button
          type="button"
          onClick={() => setRefresh((n) => n + 1)}
          style={vfsButtonStyle}
          title="Refresh"
        >
          refresh
        </button>
      </div>

      <div style={{
        minHeight: 0,
        display: "grid",
        gridTemplateColumns: selected ? "minmax(260px, 1fr) minmax(260px, 0.95fr)" : "1fr",
      }}>
        <div style={{ overflow: "auto", minWidth: 0 }}>
          <table className="ktable">
            <thead>
              <tr>
                <th>NAME</th>
                <th>KIND</th>
                <th>MODE</th>
                <th>OWNER</th>
                <th>GROUP</th>
                <th className="num">SIZE</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => {
                const childPath = joinPath(path, entry.name);
                const isSelected = selected?.path === childPath;
                return (
                  <tr
                    key={childPath}
                    onClick={() => {
                      if (entry.kind === "d") setPath(childPath);
                      else setSelected({ path: childPath, entry });
                    }}
                    style={{
                      cursor: "pointer",
                      background: isSelected ? "color-mix(in oklch, var(--k-accent) 9%, transparent)" : undefined,
                    }}
                  >
                    <td style={{ color: entry.kind === "d" ? "var(--k-accent)" : "var(--k-text)" }}>
                      {entry.kind === "d" ? `${entry.name}/` : entry.name}
                      {entry.target && (
                        <span className="dim" style={{ marginLeft: 8 }}>→ {entry.target}</span>
                      )}
                    </td>
                    <td className="dim">{vfsKindLabel(entry.kind)}</td>
                    <td className="dim">{entry.mode}</td>
                    <td className="dim">{entry.owner}</td>
                    <td className="dim">{entry.group}</td>
                    <td className="num">{entry.kind === "d" ? "—" : entry.size}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {entries.length === 0 && (
            <div style={{
              padding: 24,
              color: "var(--k-text-faint)",
              fontFamily: "var(--k-font-mono)",
              fontSize: 11.5,
            }}>
              Empty directory.
            </div>
          )}
        </div>

        {selected && (
          <FilePreview
            key={selected.path}
            path={selected.path}
            entry={selected.entry}
            onClose={() => setSelected(null)}
          />
        )}
      </div>
    </div>
  );
};

const FilePreview: React.FC<{
  path: string;
  entry: VfsDirent;
  onClose: () => void;
}> = ({ path, entry, onClose }) => {
  const host = useKernelHost();
  const state = useAsyncOnce<Uint8Array>(() => host.readFile(path), [host, path]);
  return (
    <div style={{
      borderLeft: "1px solid var(--k-border)",
      minWidth: 0,
      minHeight: 0,
      display: "grid",
      gridTemplateRows: "auto 1fr",
      background: "var(--k-surface-sunk)",
    }}>
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "7px 10px",
        borderBottom: "1px solid var(--k-border)",
        fontFamily: "var(--k-font-mono)",
        fontSize: 11,
      }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{
            color: "var(--k-text)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}>
            {path}
          </div>
          <div style={{ color: "var(--k-text-faint)", marginTop: 2 }}>
            {entry.mode} · {entry.owner}:{entry.group} · {entry.size}
          </div>
        </div>
        <button type="button" onClick={onClose} style={vfsButtonStyle}>close</button>
      </div>
      <div style={{ overflow: "auto", minHeight: 0 }}>
        {state.kind === "loading" && <Loading />}
        {state.kind === "missing" && <MissingEndpoint label="File" detail={state.message} />}
        {state.kind === "error" && <ErrorBox message={state.message} />}
        {state.kind === "ready" && <FileBytes bytes={state.value} />}
      </div>
    </div>
  );
};

const FileBytes: React.FC<{ bytes: Uint8Array }> = ({ bytes }) => {
  const decoded = React.useMemo(() => decodePreview(bytes), [bytes]);
  return (
    <pre style={{
      margin: 0,
      padding: 12,
      color: decoded.binary ? "var(--k-text-muted)" : "var(--k-text)",
      fontFamily: "var(--k-font-mono)",
      fontSize: 11.5,
      lineHeight: 1.5,
      whiteSpace: "pre-wrap",
      wordBreak: "break-word",
    }}>
      {decoded.text}
    </pre>
  );
};

const vfsButtonStyle: React.CSSProperties = {
  border: "1px solid var(--k-border)",
  borderRadius: "var(--k-radius-sm)",
  background: "transparent",
  color: "var(--k-text-muted)",
  font: "inherit",
  fontSize: 10,
  padding: "3px 7px",
  cursor: "pointer",
};

const vfsCrumbStyle: React.CSSProperties = {
  border: 0,
  background: "transparent",
  font: "inherit",
  padding: 0,
  cursor: "pointer",
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

function normalizePath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length === 0 ? "/" : `/${parts.join("/")}`;
}

function joinPath(base: string, name: string): string {
  return normalizePath(base === "/" ? `/${name}` : `${base}/${name}`);
}

function parentPath(path: string): string {
  const parts = normalizePath(path).split("/").filter(Boolean);
  parts.pop();
  return parts.length === 0 ? "/" : `/${parts.join("/")}`;
}

function pathSegments(path: string): string[] {
  const parts = normalizePath(path).split("/").filter(Boolean);
  return ["/", ...parts];
}

function vfsKindLabel(kind: VfsDirent["kind"]): string {
  switch (kind) {
    case "d": return "dir";
    case "f": return "file";
    case "l": return "link";
    case "b": return "block";
    case "c": return "char";
    case "p": return "pipe";
    case "s": return "socket";
  }
}

function decodePreview(bytes: Uint8Array): { text: string; binary: boolean } {
  const max = 64 * 1024;
  const sample = bytes.subarray(0, Math.min(bytes.byteLength, max));
  let control = 0;
  for (const b of sample) {
    if (b === 0 || (b < 32 && b !== 9 && b !== 10 && b !== 13)) control++;
  }
  const binary = sample.byteLength > 0 && control / sample.byteLength > 0.02;
  const suffix = bytes.byteLength > sample.byteLength
    ? `\n\n[truncated: showing ${sample.byteLength} of ${bytes.byteLength} bytes]`
    : "";
  if (!binary) {
    return {
      text: new TextDecoder("utf-8", { fatal: false }).decode(sample) + suffix,
      binary,
    };
  }
  const rows: string[] = [];
  const hex = Array.from(sample.subarray(0, Math.min(sample.byteLength, 4096)));
  for (let i = 0; i < hex.length; i += 16) {
    const chunk = hex.slice(i, i + 16);
    rows.push(
      `${i.toString(16).padStart(8, "0")}  ` +
      chunk.map((b) => b.toString(16).padStart(2, "0")).join(" ").padEnd(47, " ") +
      "  " +
      chunk.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join(""),
    );
  }
  const binarySuffix = bytes.byteLength > hex.length
    ? `\n\n[truncated: showing ${hex.length} of ${bytes.byteLength} bytes]`
    : suffix;
  return { text: rows.join("\n") + binarySuffix, binary };
}

// ── Config ────────────────────────────────────────────────────────────────

const ConfigTab: React.FC = () => {
  const host = useKernelHost();
  const mounts = useAsyncOnce<MountInfo[]>(() => host.getMounts(), [host]);
  const kstate = useAsyncOnce<KernelStateKV[]>(() => host.getKernelState(), [host]);
  return (
    <div style={{ height: "100%", overflow: "auto", paddingBottom: 8 }}>
      <ConfigSection title="Kernel">
        {kstate.kind === "loading" && <Loading />}
        {kstate.kind === "missing" && <MissingEndpoint label="Kernel state" detail={kstate.message} />}
        {kstate.kind === "error" && <ErrorBox message={kstate.message} />}
        {kstate.kind === "ready" && (
          <table className="ktable">
            <thead><tr><th>KEY</th><th>VALUE</th></tr></thead>
            <tbody>
              {kstate.value.map((kv) => (
                <tr key={kv.k}>
                  <td style={{ color: kv.k.startsWith("kandelo.") ? "var(--k-accent)" : "var(--k-text)" }}>{kv.k}</td>
                  <td className="dim">{kv.v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </ConfigSection>

      <ConfigSection title="Mounts">
        {mounts.kind === "loading" && <Loading />}
        {mounts.kind === "missing" && <MissingEndpoint label="Mounts" detail={mounts.message} />}
        {mounts.kind === "error" && <ErrorBox message={mounts.message} />}
        {mounts.kind === "ready" && (
          <table className="ktable">
            <thead>
              <tr><th>SOURCE</th><th>TARGET</th><th>FS</th><th>OPTIONS</th></tr>
            </thead>
            <tbody>
              {mounts.value.map((m, i) => (
                <tr key={i}>
                  <td style={{ color: "var(--k-accent)" }}>{m.source}</td>
                  <td>{m.target}</td>
                  <td className="dim">{m.fs}</td>
                  <td className="dim">{m.opts}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </ConfigSection>
    </div>
  );
};

const ConfigSection: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <section style={{ borderBottom: "1px solid var(--k-border)" }}>
    <div style={{
      padding: "8px 10px",
      background: "var(--k-surface-alt)",
      color: "var(--k-text-muted)",
      fontFamily: "var(--k-font-mono)",
      fontSize: 10,
      fontWeight: 700,
      letterSpacing: "0.04em",
      textTransform: "uppercase",
      borderBottom: "1px solid var(--k-border)",
    }}>
      {title}
    </div>
    {children}
  </section>
);

const MemMapTable: React.FC<{ entries: MemMapEntry[] }> = ({ entries }) => {
  if (entries.length === 0) {
    return (
      <div style={{
        padding: 24,
        color: "var(--k-text-faint)",
        fontFamily: "var(--k-font-mono)",
        fontSize: 11.5,
      }}>
        No memory mappings for this pid.
      </div>
    );
  }
  return (
    <table className="ktable">
      <thead>
        <tr><th>ADDRESS RANGE</th><th>PERM</th><th>OFFSET</th><th className="num">SIZE</th><th>MAPPING</th></tr>
      </thead>
      <tbody>
        {entries.map((m, i) => (
          <tr key={i}>
            <td>{m.range}</td>
            <td style={{ color: m.perm.includes("x") ? "var(--k-accent)" : "var(--k-text-muted)" }}>{m.perm}</td>
            <td className="dim">{m.offset}</td>
            <td className="num">{m.size}</td>
            <td style={{ color: m.path.startsWith("[") ? "var(--k-info)" : "var(--k-text)" }}>{m.path}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

// ── Syscalls ──────────────────────────────────────────────────────────────

const SyscallsTab: React.FC = () => {
  const host = useKernelHost();
  const [events, setEvents] = React.useState<SyscallEvent[]>([]);
  const [missingMsg, setMissingMsg] = React.useState<string | null>(null);
  const [recording, setRecording] = React.useState(true);

  React.useEffect(() => {
    let off: (() => void) | null = null;
    try {
      // Seed with history if available.
      const history = host.syscallHistory();
      setEvents(history);
      if (recording) {
        off = host.subscribeSyscalls((e) => setEvents((prev) => [...prev, e].slice(-500)));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not implemented yet")) setMissingMsg(msg);
      else throw err;
    }
    return () => { if (off) off(); };
  }, [host, recording]);

  if (missingMsg) return <MissingEndpoint label="Syscalls" detail={missingMsg} />;
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{
        display: "flex",
        justifyContent: "flex-end",
        padding: "8px 10px",
        borderBottom: "1px solid var(--k-border)",
      }}>
        <button
          type="button"
          aria-pressed={recording}
          onClick={() => setRecording((v) => !v)}
          style={{
            border: "1px solid var(--k-border)",
            borderRadius: "var(--k-radius-sm)",
            background: recording ? "color-mix(in oklch, var(--k-accent) 16%, transparent)" : "transparent",
            color: recording ? "var(--k-accent)" : "var(--k-text-muted)",
            fontFamily: "var(--k-font-mono)",
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
            padding: "5px 9px",
            cursor: "pointer",
          }}
        >
          {recording ? "Recording" : "Paused"}
        </button>
      </div>
      <div style={{ overflow: "auto", minHeight: 0 }}>
        <table className="ktable">
          <thead><tr><th>TIME</th><th>CALL</th><th>ARGS</th><th>RETURN</th></tr></thead>
          <tbody>
            {events.map((e, i) => (
              <tr key={i}>
                <td className="dim">{e.t}</td>
                <td style={{ color: "var(--k-accent)" }}>{e.call}</td>
                <td>{e.args}</td>
                <td style={{ color: e.ret.startsWith("-") ? "var(--k-err)" : "var(--k-ok)" }}>{e.ret}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// ── Lazy Load ───────────────────────────────────────────────────────────────

interface LazyDownloadAssetLogEntry {
  id: string;
  kind: LazyDownloadEvent["kind"];
  label: string;
  status: LazyDownloadEvent["status"];
  target: string;
  source: string;
  loadedBytes: number;
  totalBytes?: number;
  startedAt: number;
  updatedAt: number;
  eventCount: number;
  error?: string;
}

const LazyLoadTab: React.FC = () => {
  const events = useLazyDownloadLog();
  const assets = React.useMemo(() => summarizeLazyDownloadLog(events), [events]);

  return (
    <div className="kdownload-log">
      {assets.length === 0 ? (
        <div className="kdownload-empty">No lazy assets retrieved.</div>
      ) : (
        <table className="ktable kdownload-table">
          <thead>
            <tr>
              <th>ASSET</th>
              <th>STATUS</th>
              <th className="num">PROGRESS</th>
              <th className="num">SIZE</th>
              <th>TARGET</th>
              <th>SOURCE</th>
              <th className="num">UPDATED</th>
            </tr>
          </thead>
          <tbody>
            {assets.map((asset) => {
              const pct = downloadPct(asset);
              const sourceLabel = compactUrl(asset.source);
              return (
                <tr key={asset.id}>
                  <td>
                    <span className="kdownload-asset-name">{asset.label}</span>
                    <span className="kdownload-kind">{asset.kind}</span>
                  </td>
                  <td>
                    <span className={`kdownload-status kdownload-status-${asset.status}`}>
                      {downloadStatusLabel(asset.status)}
                    </span>
                    {asset.error && <span className="kdownload-error-text" title={asset.error}>{asset.error}</span>}
                  </td>
                  <td className="num">{downloadProgressText(asset, pct)}</td>
                  <td className="num">{asset.totalBytes ? humanBytes(asset.totalBytes) : humanBytes(asset.loadedBytes)}</td>
                  <td className="kdownload-path" title={asset.target}>{asset.target}</td>
                  <td className="kdownload-source" title={asset.source}>{sourceLabel}</td>
                  <td className="num">{formatDownloadTime(asset.updatedAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
};

function summarizeLazyDownloadLog(events: LazyDownloadEvent[]): LazyDownloadAssetLogEntry[] {
  const byId = new Map<string, LazyDownloadAssetLogEntry>();
  for (const event of events) {
    const existing = byId.get(event.id);
    const loadedBytes = Math.max(existing?.loadedBytes ?? 0, event.loadedBytes);
    const totalBytes = event.totalBytes ?? existing?.totalBytes;
    byId.set(event.id, {
      id: event.id,
      kind: event.kind,
      label: downloadLabel(event),
      status: event.status,
      target: downloadTarget(event),
      source: event.url,
      loadedBytes,
      totalBytes,
      startedAt: existing?.startedAt ?? event.t,
      updatedAt: event.t,
      eventCount: (existing?.eventCount ?? 0) + 1,
      error: event.error ?? existing?.error,
    });
  }

  return Array.from(byId.values()).sort((a, b) => b.updatedAt - a.updatedAt);
}

function downloadLabel(event: LazyDownloadEvent): string {
  const raw = event.kind === "archive"
    ? event.url
    : event.path ?? event.mountPrefix ?? event.url;
  const clean = raw.split(/[?#]/, 1)[0].replace(/\/+$/, "");
  return clean.split("/").pop() || event.kind;
}

function downloadTarget(event: LazyDownloadEvent): string {
  return event.path ?? event.mountPrefix ?? event.url;
}

function downloadStatusLabel(status: LazyDownloadEvent["status"]): string {
  switch (status) {
    case "started": return "Started";
    case "progress": return "Downloading";
    case "complete": return "Complete";
    case "error": return "Error";
  }
}

function downloadPct(asset: Pick<LazyDownloadAssetLogEntry, "loadedBytes" | "totalBytes">): number | null {
  return asset.totalBytes && asset.totalBytes > 0
    ? Math.min(100, Math.max(0, (asset.loadedBytes / asset.totalBytes) * 100))
    : null;
}

function downloadProgressText(asset: LazyDownloadAssetLogEntry, pct: number | null): string {
  if (pct === null) return humanBytes(asset.loadedBytes);
  return `${Math.round(pct)}%`;
}

function compactUrl(raw: string): string {
  try {
    const url = new URL(raw, window.location.href);
    const leaf = url.pathname.split("/").filter(Boolean).pop();
    return leaf ? `${url.host}/${leaf}` : url.host;
  } catch {
    const clean = raw.split(/[?#]/, 1)[0].replace(/\/+$/, "");
    return clean.split("/").filter(Boolean).slice(-2).join("/") || raw;
  }
}

function formatDownloadTime(t: number): string {
  return `${(t / 1000).toFixed(1)}s`;
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(kib < 10 ? 1 : 0)} KiB`;
  const mib = kib / 1024;
  return `${mib.toFixed(mib < 10 ? 1 : 0)} MiB`;
}

const Loading: React.FC = () => (
  <div style={{
    padding: 24,
    color: "var(--k-text-faint)",
    fontFamily: "var(--k-font-mono)",
    fontSize: 11.5,
  }}>
    Loading…
  </div>
);
