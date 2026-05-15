// Inspector pane — all 7 tabs.
//
// Each tab reads through the KernelHost interface. MockKernelHost satisfies
// every method with fixture data so the UI is exercisable end-to-end.
// LiveKernelHost throws "not implemented" for methods whose kernel-side
// endpoints haven't landed yet (procs/mounts/kstate/memmap/syscalls); we
// catch those and render a "host endpoint missing" placeholder so designers
// can still review the visual layout against the mock data while the kernel
// gaps fill in.

import * as React from "react";
import { useKernelHost, useDmesg } from "../kernel-host/react";
import type {
  DmesgLine, ProcessEvent, ProcessInfo, MountInfo, KernelStateKV,
  MemMapEntry, SyscallEvent, VfsDirent,
} from "../../../../../host/src/kandelo-ui/kernel-host";
import { PaneHead } from "./PaneHead";

const TABS = [
  { id: "syslog", label: "Syslog" },
  { id: "procs", label: "Procs" },
  { id: "vfs", label: "VFS" },
  { id: "mounts", label: "Mounts" },
  { id: "kstate", label: "Kernel" },
  { id: "memmap", label: "Memory" },
  { id: "syscalls", label: "Syscalls" },
];

const ICON = (
  <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.4">
    <circle cx="5.5" cy="5.5" r="3.2" />
    <path d="M8 8l3 3" />
  </svg>
);

const LABEL_BY_TAB = new Map(TABS.map((t) => [t.id, t.label]));

export const Inspector: React.FC<{
  tab: string;
  onTab: (id: string) => void;
  dragProps?: import("./PaneHead").PaneHeadDragProps;
  onCollapse?: () => void;
  onMaximize?: () => void;
  isMax?: boolean;
}> = ({ tab, onTab, dragProps, onCollapse, onMaximize, isMax }) => {
  const lines = useDmesg();
  const title = tab === "syslog"
    ? `SYSLOG · dmesg · ${lines.length} lines`
    : `INSPECTOR · ${LABEL_BY_TAB.get(tab) ?? tab}`;
  return (
    <div className="kpane">
      <PaneHead
        icon={ICON}
        title={title}
        tabs={TABS}
        activeTab={tab}
        onTab={onTab}
        dragProps={dragProps}
        onCollapse={onCollapse}
        onMaximize={onMaximize}
        isMax={isMax}
      />
      <div className="kpane-body">
        {tab === "syslog" && <SyslogTable lines={lines} />}
        {tab === "procs" && <ProcsTab />}
        {tab === "vfs" && <VfsTab />}
        {tab === "mounts" && <MountsTab />}
        {tab === "kstate" && <KStateTab />}
        {tab === "memmap" && <MemMapTab />}
        {tab === "syscalls" && <SyscallsTab />}
      </div>
    </div>
  );
};

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
          <span className="ksys-fac">{l.facility}:</span>
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
  const state = useAsyncOnce<ProcessInfo[]>(() => host.enumProcs(), [host, bump]);
  if (state.kind === "loading") return <Loading />;
  if (state.kind === "missing") return <MissingEndpoint label="Procs" detail={state.message} />;
  if (state.kind === "error") return <ErrorBox message={state.message} />;
  return (
    <table className="ktable">
      <thead>
        <tr>
          <th className="num">PID</th>
          <th>USER</th>
          <th className="num">VIRT</th>
          <th className="num">RES</th>
          <th>S</th>
          <th className="num">%CPU</th>
          <th className="num">%MEM</th>
          <th>TIME+</th>
          <th>COMMAND</th>
        </tr>
      </thead>
      <tbody>
        {state.value.map((p) => (
          <tr key={p.pid}>
            <td className="num">{p.pid}</td>
            <td>{p.user}</td>
            <td className="num">{p.virt}</td>
            <td className="num">{p.res}</td>
            <td style={{ color: p.state === "R" ? "var(--k-ok)" : "var(--k-text-muted)" }}>{p.state}</td>
            <td className="num" style={{ color: p.cpuPct > 1 ? "var(--k-accent)" : "inherit" }}>{p.cpuPct.toFixed(1)}</td>
            <td className="num">{p.memPct.toFixed(1)}</td>
            <td className="dim">{p.cpuTime}</td>
            <td style={{ color: p.cmdline.startsWith("[") ? "var(--k-text-faint)" : "var(--k-text)" }}>{p.cmdline}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

// ── VFS tree ──────────────────────────────────────────────────────────────

const VfsTab: React.FC = () => (
  <div style={{ padding: "6px 0" }}>
    <VfsNode path="/" depth={0} />
  </div>
);

const VfsNode: React.FC<{ path: string; depth: number }> = ({ path, depth }) => {
  const host = useKernelHost();
  const [open, setOpen] = React.useState(depth === 0);
  const state = useAsyncOnce<VfsDirent[]>(
    () => (open ? host.readDir(path) : Promise.resolve([])),
    [host, path, open],
  );

  return (
    <>
      {state.kind === "missing" && depth === 0 && (
        <MissingEndpoint label="VFS" detail={state.message} />
      )}
      {state.kind === "error" && depth === 0 && (
        <ErrorBox message={state.message} />
      )}
      {state.kind === "ready" && state.value.map((entry) => {
        const childPath = path === "/" ? "/" + entry.name : path + "/" + entry.name;
        const isDir = entry.kind === "d";
        return (
          <VfsRow
            key={childPath}
            entry={entry}
            depth={depth + 1}
            onOpen={isDir ? () => {/* the child VfsNode handles its own open state */} : undefined}
            childPath={childPath}
          />
        );
      })}
    </>
  );
};

const VfsRow: React.FC<{
  entry: VfsDirent;
  depth: number;
  onOpen?: () => void;
  childPath: string;
}> = ({ entry, depth, childPath }) => {
  const [expanded, setExpanded] = React.useState(false);
  const isDir = entry.kind === "d";
  return (
    <>
      <div
        className="kvfs-row"
        style={{ paddingLeft: 12 + depth * 14 }}
        onClick={() => isDir && setExpanded((v) => !v)}
      >
        <span className="kvfs-caret">{isDir ? (expanded ? "▾" : "▸") : " "}</span>
        <span className="kvfs-mode">{entry.mode}</span>
        <span className="kvfs-size">{isDir ? "—" : entry.size}</span>
        <span className={`kvfs-name ${isDir ? "kvfs-dir" : "kvfs-file"}`}>
          {isDir ? entry.name + "/" : entry.name}
        </span>
      </div>
      {isDir && expanded && <VfsNode path={childPath} depth={depth} />}
    </>
  );
};

// ── Mounts ────────────────────────────────────────────────────────────────

const MountsTab: React.FC = () => {
  const host = useKernelHost();
  const state = useAsyncOnce<MountInfo[]>(() => host.getMounts(), [host]);
  if (state.kind === "loading") return <Loading />;
  if (state.kind === "missing") return <MissingEndpoint label="Mounts" detail={state.message} />;
  if (state.kind === "error") return <ErrorBox message={state.message} />;
  return (
    <table className="ktable">
      <thead>
        <tr><th>SOURCE</th><th>TARGET</th><th>FS</th><th>OPTIONS</th></tr>
      </thead>
      <tbody>
        {state.value.map((m, i) => (
          <tr key={i}>
            <td style={{ color: "var(--k-accent)" }}>{m.source}</td>
            <td>{m.target}</td>
            <td className="dim">{m.fs}</td>
            <td className="dim">{m.opts}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

// ── Kernel state ──────────────────────────────────────────────────────────

const KStateTab: React.FC = () => {
  const host = useKernelHost();
  const state = useAsyncOnce<KernelStateKV[]>(() => host.getKernelState(), [host]);
  if (state.kind === "loading") return <Loading />;
  if (state.kind === "missing") return <MissingEndpoint label="Kernel state" detail={state.message} />;
  if (state.kind === "error") return <ErrorBox message={state.message} />;
  return (
    <table className="ktable">
      <thead><tr><th>KEY</th><th>VALUE</th></tr></thead>
      <tbody>
        {state.value.map((kv) => (
          <tr key={kv.k}>
            <td style={{ color: kv.k.startsWith("kandelo.") ? "var(--k-accent)" : "var(--k-text)" }}>{kv.k}</td>
            <td className="dim">{kv.v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

// ── Memory map ────────────────────────────────────────────────────────────

const MemMapTab: React.FC = () => {
  const host = useKernelHost();
  // Pick the most interesting pid to inspect: skip pid 1 (init typically
  // has no mappings) and prefer the highest pid (likely the user's shell
  // / latest spawn). User can extend this to a pid picker later.
  const [pid, setPid] = React.useState<number | null>(null);
  const [pids, setPids] = React.useState<number[]>([]);
  // Re-list pids when a process spawns/exits. The selected pid stays
  // sticky unless it disappears from the list.
  const bump = useProcessEventBump();

  React.useEffect(() => {
    let cancelled = false;
    void host.enumProcs().then(
      (procs) => {
        if (cancelled) return;
        const ids = procs.map((p) => p.pid);
        setPids(ids);
        setPid((prev) => {
          if (prev !== null && ids.includes(prev)) return prev;
          return ids.filter((id) => id !== 1).at(-1) ?? ids[0] ?? null;
        });
      },
      () => { if (!cancelled) { setPids([]); setPid(null); } },
    );
    return () => { cancelled = true; };
  }, [host, bump]);

  const state = useAsyncOnce<MemMapEntry[]>(
    () => pid === null ? Promise.resolve([]) : host.readMemMap(pid),
    // Also refresh maps when the watched pid execs (memory map changes
    // dramatically on exec).
    [host, pid, bump],
  );
  if (pid === null && state.kind === "ready" && state.value.length === 0) {
    return <Loading />;
  }
  if (state.kind === "loading") return <Loading />;
  if (state.kind === "missing") return <MissingEndpoint label="Memory map" detail={state.message} />;
  if (state.kind === "error") return <ErrorBox message={state.message} />;
  return (
    <>
      {pids.length > 0 && (
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "6px 12px",
          borderBottom: "1px solid var(--k-border)",
          background: "var(--k-surface-alt)",
          fontFamily: "var(--k-font-mono)",
          fontSize: 11,
        }}>
          <span style={{ color: "var(--k-text-muted)" }}>pid:</span>
          <select
            value={pid ?? ""}
            onChange={(e) => setPid(Number(e.target.value))}
            style={{
              padding: "2px 6px",
              border: "1px solid var(--k-border)",
              background: "var(--k-surface-sunk)",
              borderRadius: "var(--k-radius-sm)",
              font: "inherit",
              fontSize: 11,
              color: "var(--k-text)",
            }}
          >
            {pids.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <span style={{ color: "var(--k-text-faint)", marginLeft: "auto" }}>
            {state.kind === "ready" ? `${state.value.length} regions` : ""}
          </span>
        </div>
      )}
      <MemMapTable entries={state.kind === "ready" ? state.value : []} />
    </>
  );
};

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

  React.useEffect(() => {
    let off: (() => void) | null = null;
    try {
      // Seed with history if available.
      const history = host.syscallHistory();
      setEvents(history);
      off = host.subscribeSyscalls((e) => setEvents((prev) => [...prev, e].slice(-500)));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not implemented yet")) setMissingMsg(msg);
      else throw err;
    }
    return () => { if (off) off(); };
  }, [host]);

  if (missingMsg) return <MissingEndpoint label="Syscalls" detail={missingMsg} />;
  return (
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
  );
};

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
