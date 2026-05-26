// Gallery — browse and launch Kandelo computers.
//
// Click a card → host.applyBootDescriptor(descriptorFromPreset(item)).

import * as React from "react";
import { useGalleryItems } from "../kernel-host/react";
import { mountsWithRootImageUrl } from "../url-state";
import { classifyTier } from "../../../../../web-libs/kandelo-session/src/boot-descriptor";
import type {
  GalleryItem,
  BootDescriptor,
} from "../../../../../web-libs/kandelo-session/src/kernel-host";

export interface GalleryProps {
  onLaunch: (item: GalleryItem) => void;
  onShare?: (item: GalleryItem) => void;
}

export const Gallery: React.FC<GalleryProps> = ({ onLaunch, onShare }) => {
  const [q, setQ] = React.useState("");
  const { items, loading } = useGalleryItems("presets");

  const filtered = q
    ? items.filter((i) => (i.title + " " + i.summary).toLowerCase().includes(q.toLowerCase()))
    : items;

  return (
    <div className="kgallery">
      <div className="kgal-hdr">
        <h1 className="kgal-title">Gallery</h1>
        <div className="kgal-tools">
          <div className="kgal-search">
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ color: "var(--k-text-faint)" }}>
              <circle cx="5.5" cy="5.5" r="3.2" />
              <path d="M8 8l3 3" />
            </svg>
            <input
              type="search"
              placeholder="Filter..."
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <div className="kgal-count">
            {filtered.length} of {items.length}
          </div>
        </div>
      </div>

      {loading ? (
        <div className="kgal-empty">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="kgal-empty">
          {q ? `No machines match "${q}".` : "Nothing in the gallery yet."}
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
 * a card click into an applyBootDescriptor() call. Lifts argv, packages, any
 * direct VFS image URL, and the expected user context from the gallery item;
 * other fields stay from the current descriptor.
 */
export function descriptorFromGalleryItem(
  item: GalleryItem,
  base: BootDescriptor,
): BootDescriptor {
  const mounts = item.vfsImageUrl
    ? mountsWithRootImageUrl(base.mounts, item.vfsImageUrl)
    : base.mounts;
  const rootBoot = item.bootCommand[0] === "/sbin/dinit";
  const nodeBoot = item.id === "node";
  const userEnv = nodeBoot
    ? { ...base.boot.env, HOME: "/home/user", PWD: "/work", USER: "user", LOGNAME: "user" }
    : { ...base.boot.env, HOME: "/home/user", USER: "user", LOGNAME: "user" };
  const rootEnv = { ...base.boot.env, HOME: "/root", USER: "root", LOGNAME: "root" };
  return {
    ...base,
    id: item.id,
    title: item.title,
    packages: item.packages,
    mounts,
    boot: {
      ...base.boot,
      argv: item.bootCommand,
      cwd: rootBoot ? "/root" : nodeBoot ? "/work" : "/home/user",
      env: rootBoot ? rootEnv : userEnv,
      uid: rootBoot ? 0 : 1000,
      gid: rootBoot ? 0 : 1000,
    },
  };
}
