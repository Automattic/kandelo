// System Config — edit the running machine's boot descriptor.
//
// Five tabs: Boot · Mounts · Runtime · Capabilities · Trust. Each tab edits
// the draft descriptor. Apply calls host.applyBootDescriptor(draft), which
// reboots the machine.

import * as React from "react";
import { useKernelHost } from "../kernel-host/react";
import type {
  BootDescriptor, DescriptorMount, MountSource,
} from "../../../../../web-libs/kandelo-session/src/kernel-host";

const TABS = [
  { id: "boot", label: "Boot" },
  { id: "mounts", label: "Mounts" },
  { id: "runtime", label: "Runtime" },
  { id: "caps", label: "Capabilities" },
  { id: "trust", label: "Trust" },
] as const;
type TabId = (typeof TABS)[number]["id"];

const MOUNT_SOURCES: MountSource[] = [
  "image", "package-layer", "inline-overlay", "remote-overlay",
  "scratch", "opfs", "lazy-http", "archive", "git", "cas", "encrypted", "device",
];

export interface ConfigProps {
  onApplied?: () => void;
}

export const Config: React.FC<ConfigProps> = ({ onApplied }) => {
  const host = useKernelHost();
  const [tab, setTab] = React.useState<TabId>("boot");
  const [draft, setDraft] = React.useState<BootDescriptor>(() => host.getBootDescriptor());
  const [original, setOriginal] = React.useState<BootDescriptor>(() => host.getBootDescriptor());

  // If the descriptor changes underneath us (e.g. another surface called
  // applyBootDescriptor), pick up the change.
  React.useEffect(() => {
    return host.subscribeStatus(() => {
      const next = host.getBootDescriptor();
      setOriginal(next);
      setDraft(next);
    });
  }, [host]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(original);

  const reset = () => setDraft(host.getBootDescriptor());
  const apply = async () => {
    try {
      await host.applyBootDescriptor(draft);
      setOriginal(draft);
      onApplied?.();
    } catch (err) {
      console.warn("applyBootDescriptor failed:", err);
    }
  };

  return (
    <div className="kcfg">
      <div className="kcfg-hdr">
        <h1 className="kcfg-title">System Config</h1>
        <div className="kcfg-sub">Edit the running machine's boot descriptor. Apply rebuilds the URL and reboots.</div>
      </div>
      <div className="kcfg-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className="kcfg-tab"
            aria-current={tab === t.id}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="kcfg-body">
        <div className="kcfg-grid">
          {tab === "boot" && <BootTab draft={draft} setDraft={setDraft} />}
          {tab === "mounts" && <MountsTab draft={draft} setDraft={setDraft} />}
          {tab === "runtime" && <RuntimeTab draft={draft} setDraft={setDraft} />}
          {tab === "caps" && <CapsTab draft={draft} setDraft={setDraft} />}
          {tab === "trust" && <TrustTab draft={draft} setDraft={setDraft} />}
        </div>

        <div className="kcfg-foot">
          <div className="kcfg-foot-info">
            {dirty ? "Unsaved changes will rebuild the URL and reboot." : "No changes."}
          </div>
          <button className="kcfg-btn" onClick={reset} disabled={!dirty}>Reset</button>
          <button
            className="kcfg-btn kcfg-btn-primary"
            onClick={apply}
            disabled={!dirty}
          >
            Apply &amp; reboot
          </button>
        </div>
      </div>
    </div>
  );
};

type TabPropsBase = {
  draft: BootDescriptor;
  setDraft: React.Dispatch<React.SetStateAction<BootDescriptor>>;
};

// ── Boot tab ──────────────────────────────────────────────────────────────

const BootTab: React.FC<TabPropsBase> = ({ draft, setDraft }) => {
  const envText = Object.entries(draft.boot.env).map(([k, v]) => `${k}=${v}`).join("\n");
  const setEnv = (text: string) => {
    const obj: Record<string, string> = {};
    for (const line of text.split("\n")) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (m) obj[m[1]] = m[2];
    }
    setDraft((d) => ({ ...d, boot: { ...d.boot, env: obj } }));
  };
  return (
    <>
      <div className="kcfg-card">
        <div className="kcfg-card-hd">Init command</div>
        <div className="kcfg-card-body">
          <div className="kcfg-row">
            <label>argv</label>
            <input
              className="kcfg-input"
              value={draft.boot.argv.join(" ")}
              onChange={(e) => setDraft((d) => ({
                ...d,
                boot: { ...d.boot, argv: e.target.value.split(/\s+/).filter(Boolean) },
              }))}
            />
          </div>
          <div className="kcfg-row">
            <label>cwd</label>
            <input
              className="kcfg-input"
              value={draft.boot.cwd}
              onChange={(e) => setDraft((d) => ({ ...d, boot: { ...d.boot, cwd: e.target.value } }))}
            />
          </div>
          <div className="kcfg-row">
            <label>uid / gid</label>
            <div className="kcfg-num">
              <input
                className="kcfg-input"
                type="number" min={0} max={65535}
                value={draft.boot.uid ?? 1000}
                onChange={(e) => setDraft((d) => ({ ...d, boot: { ...d.boot, uid: Number(e.target.value) } }))}
              />
              <input
                className="kcfg-input"
                type="number" min={0} max={65535}
                value={draft.boot.gid ?? 1000}
                onChange={(e) => setDraft((d) => ({ ...d, boot: { ...d.boot, gid: Number(e.target.value) } }))}
              />
            </div>
          </div>
        </div>
      </div>
      <div className="kcfg-card">
        <div className="kcfg-card-hd">Environment</div>
        <div className="kcfg-card-body">
          <textarea
            className="kcfg-input"
            rows={8}
            style={{ fontFamily: "var(--k-font-mono)", resize: "vertical" }}
            value={envText}
            onChange={(e) => setEnv(e.target.value)}
          />
          <div className="kcfg-help">One KEY=value per line.</div>
        </div>
      </div>
    </>
  );
};

// ── Mounts tab ────────────────────────────────────────────────────────────

const MountsTab: React.FC<TabPropsBase> = ({ draft, setDraft }) => {
  const setMounts = (mounts: DescriptorMount[]) => setDraft((d) => ({ ...d, mounts }));
  const update = (i: number, patch: Partial<DescriptorMount>) =>
    setMounts(draft.mounts.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  const remove = (i: number) => setMounts(draft.mounts.filter((_, j) => j !== i));
  const add = () => setMounts([
    ...draft.mounts,
    { path: "/new", source: "scratch", ephemeral: true },
  ]);

  return (
    <div className="kcfg-card" style={{ gridColumn: "1 / -1" }}>
      <div className="kcfg-card-hd">Mount graph · {draft.mounts.length} entries</div>
      <div className="kcfg-card-body">
        <div className="kcfg-mounts">
          <div style={{
            display: "grid",
            gridTemplateColumns: "130px 130px 1fr auto",
            gap: 6,
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            color: "var(--k-text-faint)",
            padding: "2px 0",
          }}>
            <span>Path</span>
            <span>Source</span>
            <span>Ref / Data / Name</span>
            <span></span>
          </div>
          {draft.mounts.map((m, i) => (
            <div key={i} className="kcfg-mount">
              <input
                value={m.path}
                onChange={(e) => update(i, { path: e.target.value })}
              />
              <select
                value={m.source}
                onChange={(e) => update(i, { source: e.target.value as MountSource })}
              >
                {MOUNT_SOURCES.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              <input
                value={m.ref ?? m.data ?? m.name ?? ""}
                onChange={(e) => {
                  const v = e.target.value;
                  if (m.source === "opfs") update(i, { name: v });
                  else if (m.source === "inline-overlay" || m.source === "remote-overlay" || m.source === "encrypted") update(i, { data: v });
                  else update(i, { ref: v });
                }}
                placeholder={
                  m.source === "scratch" ? "(empty)"
                  : m.source === "opfs" ? "workspace name"
                  : "content hash"
                }
              />
              <button className="kcfg-mount-del" onClick={() => remove(i)} title="Remove" aria-label="Remove mount">
                <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M2.5 3.5h6M4 3V2h3v1M3.5 3.5l.4 6h3.2l.4-6" />
                </svg>
              </button>
            </div>
          ))}
        </div>
        <button className="kcfg-add" onClick={add}>+ Add mount</button>
      </div>
    </div>
  );
};

// ── Runtime tab ───────────────────────────────────────────────────────────

const RuntimeTab: React.FC<TabPropsBase> = ({ draft, setDraft }) => (
  <>
    <div className="kcfg-card">
      <div className="kcfg-card-hd">Architecture</div>
      <div className="kcfg-card-body">
        <div className="kcfg-row">
          <label>Architecture</label>
          <select
            className="kcfg-input"
            value={draft.runtime.arch}
            onChange={(e) => setDraft((d) => ({
              ...d,
              runtime: { ...d.runtime, arch: e.target.value as BootDescriptor["runtime"]["arch"] },
            }))}
          >
            <option value="wasm32">wasm32</option>
            <option value="wasm64">wasm64 (preview)</option>
          </select>
        </div>
        <div className="kcfg-row">
          <label>Kernel</label>
          <input
            className="kcfg-input"
            value={draft.runtime.kernel}
            onChange={(e) => setDraft((d) => ({ ...d, runtime: { ...d.runtime, kernel: e.target.value } }))}
          />
        </div>
        <div className="kcfg-row">
          <label>Memory pages</label>
          <div className="kcfg-num">
            <input
              className="kcfg-input"
              type="number" min={64} max={65536} step={64}
              value={draft.runtime.memoryPages}
              onChange={(e) => setDraft((d) => ({ ...d, runtime: { ...d.runtime, memoryPages: Number(e.target.value) } }))}
            />
            <span className="kcfg-num-suf">
              × 64 KiB = {(draft.runtime.memoryPages * 64 / 1024).toFixed(1)} MiB
            </span>
          </div>
        </div>
      </div>
    </div>
    <div className="kcfg-card">
      <div className="kcfg-card-hd">Time mode</div>
      <div className="kcfg-card-body">
        {([
          ["real", "Real time", "Wall-clock time as reported by the host."],
          ["frozen", "Frozen", "clock_gettime always returns the boot moment. Good for screenshots."],
          ["deterministic", "Deterministic", "Advances at a fixed rate per syscall. Good for reproducible tests."],
        ] as const).map(([id, label, sub]) => (
          <label key={id} style={{ display: "flex", gap: 10, alignItems: "flex-start", cursor: "pointer", padding: "4px 0" }}>
            <input
              type="radio"
              name="kcfg-time"
              checked={draft.runtime.time === id}
              onChange={() => setDraft((d) => ({ ...d, runtime: { ...d.runtime, time: id } }))}
              style={{ marginTop: 4, accentColor: "var(--k-accent)" }}
            />
            <div>
              <div style={{ fontSize: 12.5, color: "var(--k-text)", fontWeight: 500 }}>{label}</div>
              <div style={{ fontSize: 11, color: "var(--k-text-muted)", marginTop: 1, lineHeight: 1.4 }}>{sub}</div>
            </div>
          </label>
        ))}
      </div>
    </div>
    <div className="kcfg-card">
      <div className="kcfg-card-hd">Features</div>
      <div className="kcfg-card-body">
        <div className="kcfg-toggles">
          {["shared-array-buffer", "pty", "tcp-bridge", "opfs", "signalfd", "epoll"].map((f) => {
            const on = draft.runtime.features.includes(f);
            return (
              <div key={f} className="kcfg-toggle">
                <div>
                  <div className="kcfg-toggle-lbl">{f}</div>
                </div>
                <Switch
                  on={on}
                  onChange={(v) => setDraft((d) => ({
                    ...d,
                    runtime: {
                      ...d.runtime,
                      features: v
                        ? Array.from(new Set([...d.runtime.features, f]))
                        : d.runtime.features.filter((x) => x !== f),
                    },
                  }))}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  </>
);

// ── Capabilities tab ──────────────────────────────────────────────────────

const CAPS: ReadonlyArray<readonly [
  keyof NonNullable<BootDescriptor["caps"]>,
  string,
  string,
]> = [
  ["network", "Network", "Reach the internet via the host TCP/HTTP bridge."],
  ["persistence", "OPFS persistence", "Store writable mounts in the Origin Private File System."],
  ["clipboard", "Clipboard", "Allow programs to read and write the system clipboard."],
  ["camera", "Camera", "Expose /dev/video0 backed by getUserMedia."],
  ["filesystem", "Local files", "Mount the user's File System Access handle into the VFS."],
];

const CapsTab: React.FC<TabPropsBase> = ({ draft, setDraft }) => {
  const caps = draft.caps ?? {};
  return (
    <div className="kcfg-card" style={{ gridColumn: "1 / -1" }}>
      <div className="kcfg-card-hd">Browser capabilities</div>
      <div className="kcfg-card-body">
        <div className="kcfg-toggles">
          {CAPS.map(([k, label, sub]) => (
            <div key={k} className="kcfg-toggle">
              <div>
                <div className="kcfg-toggle-lbl">{label}</div>
                <div className="kcfg-toggle-sub">{sub}</div>
              </div>
              <Switch
                on={!!caps[k]}
                onChange={(v) => setDraft((d) => ({
                  ...d,
                  caps: { ...(d.caps ?? {}), [k]: v },
                }))}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

// ── Trust tab ─────────────────────────────────────────────────────────────

const TrustTab: React.FC<TabPropsBase> = ({ draft, setDraft }) => {
  const caps = draft.caps ?? {};
  return (
    <>
      <div className="kcfg-card" style={{ gridColumn: "1 / -1" }}>
        <div className="kcfg-card-hd">Signature policy</div>
        <div className="kcfg-card-body">
          <div className="kcfg-row">
            <label>Required signatures</label>
            <input
              className="kcfg-input"
              value={(caps.signedSources ?? []).join(", ")}
              onChange={(e) => setDraft((d) => ({
                ...d,
                caps: {
                  ...(d.caps ?? {}),
                  signedSources: e.target.value.split(",").map((s) => s.trim()).filter(Boolean),
                },
              }))}
              placeholder="kandelo-official, my-org-key"
            />
          </div>
          <div className="kcfg-help">
            Boot refuses if any artifact lacks a signature from one of these sources.
          </div>
        </div>
      </div>
      <div className="kcfg-card" style={{ gridColumn: "1 / -1" }}>
        <div className="kcfg-card-hd">Allowed registries</div>
        <div className="kcfg-card-body">
          <textarea
            className="kcfg-input"
            rows={4}
            style={{ fontFamily: "var(--k-font-mono)", resize: "vertical" }}
            placeholder={"https://kandelo.dev/registry\nhttps://my-org.example/registry"}
            defaultValue={"https://kandelo.dev/registry"}
          />
          <div className="kcfg-help">
            One URL per line. Remote artifacts must be served from one of these origins.
          </div>
        </div>
      </div>
    </>
  );
};

const Switch: React.FC<{ on: boolean; onChange: (v: boolean) => void }> = ({ on, onChange }) => (
  <button
    type="button"
    onClick={() => onChange(!on)}
    aria-pressed={on}
    style={{
      width: 32,
      height: 18,
      borderRadius: 999,
      border: 0,
      padding: 0,
      cursor: "pointer",
      background: on ? "var(--k-accent)" : "color-mix(in oklch, var(--k-text) 14%, transparent)",
      position: "relative",
      transition: "background 0.15s",
      flexShrink: 0,
    }}
  >
    <span style={{
      position: "absolute",
      top: 2,
      left: 2,
      width: 14,
      height: 14,
      borderRadius: "50%",
      background: "#fff",
      boxShadow: "0 1px 2px rgba(0, 0, 0, 0.25)",
      transform: on ? "translateX(14px)" : "translateX(0)",
      transition: "transform 0.15s",
    }} />
  </button>
);
