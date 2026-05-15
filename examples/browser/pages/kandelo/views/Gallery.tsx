// Gallery — browse and launch Kandelo computers.
//
// Tabs: Presets · Recent · Saved · Shared with you · Public. Each tab is
// fetched via host.galleryQuery(); the host decides what each tab means
// (presets = signed registry, recent = IndexedDB, etc.).
//
// Click a card → host.applyBootDescriptor(descriptorFromPreset(item)).

import * as React from "react";
import { useKernelHost } from "../kernel-host/react";
import { classifyTier } from "../../../../../host/src/kandelo-ui/boot-descriptor";
import type {
  GalleryItem, GalleryTab,
  BootDescriptor,
} from "../../../../../host/src/kandelo-ui/kernel-host";

const TABS: { id: GalleryTab; label: string }[] = [
  { id: "presets", label: "Presets" },
  { id: "recent", label: "Recent" },
  { id: "saved", label: "Saved" },
  { id: "shared", label: "Shared with you" },
  { id: "public", label: "Public" },
];

const SUBTITLE: Record<GalleryTab, string> = {
  presets: "Official Kandelo computers — signed, reproducible, ready to boot.",
  recent: "Machines you've booted in this browser.",
  saved: "Machines you've given a name.",
  shared: "Computers other people have sent you.",
  public: "Recently popular, browsable public computers.",
};

export interface GalleryProps {
  onLaunch: (item: GalleryItem) => void;
  onShare?: (item: GalleryItem) => void;
}

export const Gallery: React.FC<GalleryProps> = ({ onLaunch, onShare }) => {
  const host = useKernelHost();
  const [tab, setTab] = React.useState<GalleryTab>("presets");
  const [q, setQ] = React.useState("");
  const [items, setItems] = React.useState<GalleryItem[]>([]);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void host.galleryQuery({ tab }).then(
      (result) => {
        if (cancelled) return;
        setItems(result);
        setLoading(false);
      },
      () => {
        if (cancelled) return;
        setItems([]);
        setLoading(false);
      },
    );
    return () => { cancelled = true; };
  }, [host, tab]);

  const filtered = q
    ? items.filter((i) => (i.title + " " + i.summary).toLowerCase().includes(q.toLowerCase()))
    : items;

  const title = tab === "presets" ? "Gallery" : TABS.find((t) => t.id === tab)?.label ?? "Gallery";

  return (
    <div className="kgallery">
      <div className="kgal-hdr">
        <div>
          <h1 className="kgal-title">{title}</h1>
          <div className="kgal-sub">{SUBTITLE[tab]}</div>
        </div>
        <div className="kgal-tabs">
          {TABS.map((t) => (
            <button key={t.id} className="kgal-tab" aria-current={t.id === tab} onClick={() => setTab(t.id)}>
              {t.label}
              <span className="kgal-tab-count">{tab === t.id ? items.length : ""}</span>
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div className="kgal-search">
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ color: "var(--k-text-faint)" }}>
            <circle cx="5.5" cy="5.5" r="3.2" />
            <path d="M8 8l3 3" />
          </svg>
          <input
            type="search"
            placeholder="Filter…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div style={{ fontFamily: "var(--k-font-mono)", fontSize: 11, color: "var(--k-text-faint)" }}>
          {filtered.length} of {items.length}
        </div>
      </div>

      {loading ? (
        <div className="kgal-empty">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="kgal-empty">
          {q ? `No machines match "${q}".` : `Nothing in ${tab} yet.`}
        </div>
      ) : (
        <div className="kgal-grid">
          {filtered.map((item) => (
            <Card
              key={item.id}
              item={item}
              onLaunch={() => onLaunch(item)}
              onShare={onShare ? () => onShare(item) : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
};

const Card: React.FC<{
  item: GalleryItem;
  onLaunch: () => void;
  onShare?: () => void;
}> = ({ item, onLaunch, onShare }) => {
  const tier = classifyTier(item.estimatedUrlBytes);
  const thumbStyle: React.CSSProperties = {
    background: `radial-gradient(70% 80% at 30% 20%, color-mix(in oklch, ${item.accent} 60%, white), ${item.accent} 60%, color-mix(in oklch, ${item.accent} 80%, black) 100%)`,
  };
  return (
    <div className="kgal-card" onClick={onLaunch}>
      <div className="kgal-card-thumb" style={thumbStyle}>{item.glyph}</div>
      <div className="kgal-card-body">
        <div className="kgal-card-row">
          <div className="kgal-card-title">{item.title}</div>
          <div className="kgal-card-tier" data-tier={tier}>{tier}</div>
        </div>
        <div className="kgal-card-summary">{item.summary}</div>
        <div className="kgal-card-meta">
          <span>{item.estimatedUrlBytes} B</span>
          <span className="kgal-card-meta-dot" />
          <span>{item.packages.length} pkgs</span>
          {item.lastBootedAt && (
            <>
              <span className="kgal-card-meta-dot" />
              <span>{item.lastBootedAt}</span>
            </>
          )}
          {item.author && (
            <>
              <span className="kgal-card-meta-dot" />
              <span>{item.author}</span>
            </>
          )}
          <div className="kgal-card-actions">
            {onShare && (
              <button
                className="kgal-card-btn"
                onClick={(e) => { e.stopPropagation(); onShare(); }}
                title="Share"
                aria-label="Share"
              >
                <svg width="10" height="10" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.6">
                  <circle cx="3" cy="5.5" r="1.4" />
                  <circle cx="8.5" cy="2.5" r="1.4" />
                  <circle cx="8.5" cy="8.5" r="1.4" />
                  <path d="M4.2 4.8l3.2-1.8M4.2 6.2l3.2 1.8" />
                </svg>
              </button>
            )}
            <button
              className="kgal-card-btn kgal-card-btn-primary"
              onClick={(e) => { e.stopPropagation(); onLaunch(); }}
            >
              Launch
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

/**
 * Apply a GalleryItem to a base BootDescriptor — used by the App to convert
 * a card click into an applyBootDescriptor() call. Lifts argv + packages
 * from the gallery item; other fields stay from the current descriptor.
 */
export function descriptorFromGalleryItem(
  item: GalleryItem,
  base: BootDescriptor,
): BootDescriptor {
  return {
    ...base,
    id: item.id,
    title: item.title,
    packages: item.packages,
    boot: { ...base.boot, argv: item.bootCommand },
  };
}
