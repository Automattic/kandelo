// Gallery — browse and launch Kandelo computers.
//
// Click a row → host.applyBootDescriptor(descriptorFromPreset(item)).

import * as React from "react";
import { useGalleryItems, useKernelHost, useStatus } from "../kernel-host/react";
import { galleryItemUrl, mountsWithRootImageUrl, vfsImageUrlFromDescriptor } from "../url-state";
import { buildShareUrl, encodeBootDescriptor } from "../../../../../web-libs/kandelo-session/src/boot-descriptor";
import type {
  GalleryItem,
  BootDescriptor,
} from "../../../../../web-libs/kandelo-session/src/kernel-host";

export interface GalleryProps {
  onLaunch: (item: GalleryItem) => void;
  onShare?: (item: GalleryItem) => void;
  compact?: boolean;
}

type CopyState = {
  itemId: string;
  status: "copied" | "error";
} | null;

export const Gallery: React.FC<GalleryProps> = ({ onLaunch, onShare, compact = false }) => {
  const host = useKernelHost();
  const status = useStatus();
  const [q, setQ] = React.useState("");
  const [expandedDescriptions, setExpandedDescriptions] = React.useState<Set<string>>(() => new Set());
  const [copyState, setCopyState] = React.useState<CopyState>(null);
  const copyResetTimer = React.useRef<number | null>(null);
  const { items, loading } = useGalleryItems("presets");
  const currentDescriptor = React.useMemo(() => host.getBootDescriptor(), [host, status]);
  const currentVfsImageUrl = React.useMemo(
    () => vfsImageUrlFromDescriptor(currentDescriptor),
    [currentDescriptor],
  );

  const filtered = q
    ? items.filter((i) => (i.title + " " + i.summary).toLowerCase().includes(q.toLowerCase()))
    : items;

  const toggleDescription = React.useCallback((id: string) => {
    setExpandedDescriptions((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  React.useEffect(() => () => {
    if (copyResetTimer.current !== null) {
      window.clearTimeout(copyResetTimer.current);
    }
  }, []);

  const copyGalleryUrl = React.useCallback(async (item: GalleryItem) => {
    try {
      const url = await shareUrlForGalleryItem(item, currentDescriptor);
      await writeClipboardText(url);
      setCopyState({ itemId: item.id, status: "copied" });
    } catch (err) {
      console.warn("Could not copy gallery URL:", err);
      setCopyState({ itemId: item.id, status: "error" });
    }

    if (copyResetTimer.current !== null) {
      window.clearTimeout(copyResetTimer.current);
    }
    copyResetTimer.current = window.setTimeout(() => {
      setCopyState(null);
      copyResetTimer.current = null;
    }, 1400);
  }, [currentDescriptor]);

  return (
    <div className="kgallery">
      <div className="kgal-hdr">
        {!compact && <h1 className="kgal-title">Gallery</h1>}
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
        <div className="kgal-table-shell">
          <table className="kgal-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Description</th>
                <th scope="col">Share URL</th>
                <th scope="col" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((item) => (
                <GalleryRow
                  key={item.id}
                  item={item}
                  current={galleryItemMatchesCurrent(item, currentDescriptor, currentVfsImageUrl)}
                  descriptionExpanded={expandedDescriptions.has(item.id)}
                  copyStatus={copyState?.itemId === item.id ? copyState.status : null}
                  onLaunch={() => onLaunch(item)}
                  onShare={onShare ? () => onShare(item) : undefined}
                  onCopyShareUrl={() => copyGalleryUrl(item)}
                  onToggleDescription={() => toggleDescription(item.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

const GalleryRow: React.FC<{
  item: GalleryItem;
  current: boolean;
  descriptionExpanded: boolean;
  copyStatus: "copied" | "error" | null;
  onLaunch: () => void;
  onShare?: () => void;
  onCopyShareUrl: () => Promise<void>;
  onToggleDescription: () => void;
}> = ({ item, current, descriptionExpanded, copyStatus, onLaunch, onShare, onCopyShareUrl, onToggleDescription }) => {
  const thumbStyle: React.CSSProperties = {
    background: `linear-gradient(135deg, color-mix(in oklch, ${item.accent} 68%, white), ${item.accent} 62%, color-mix(in oklch, ${item.accent} 82%, black))`,
  };
  const descriptionCanExpand = item.summary.length > 150;
  const handleKeyDown = (event: React.KeyboardEvent<HTMLTableRowElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onLaunch();
  };

  return (
    <tr
      className="kgal-row"
      data-current={current ? "true" : undefined}
      tabIndex={0}
      onClick={onLaunch}
      onKeyDown={handleKeyDown}
      aria-label={`Launch ${item.title}`}
    >
      <td className="kgal-machine-cell">
        <div className="kgal-machine">
          <span className="kgal-glyph" style={thumbStyle} aria-hidden="true">{item.glyph}</span>
          <span className="kgal-machine-copy">
            <span className="kgal-machine-title-row">
              <span className="kgal-machine-title">{item.title}</span>
              {current && <span className="kgal-current-badge">Current</span>}
            </span>
          </span>
        </div>
      </td>
      <td className="kgal-description-cell">
        <div
          className={`kgal-description${descriptionExpanded ? " is-expanded" : ""}`}
          id={`kgal-desc-${item.id}`}
        >
          {item.summary}
        </div>
        {descriptionCanExpand && (
          <button
            type="button"
            className="kgal-description-toggle"
            aria-expanded={descriptionExpanded}
            aria-controls={`kgal-desc-${item.id}`}
            onClick={(event) => {
              event.stopPropagation();
              onToggleDescription();
            }}
          >
            {descriptionExpanded ? "Less" : "More"}
          </button>
        )}
      </td>
      <td className="kgal-url-cell">
        <button
          type="button"
          className={`kgal-row-btn kgal-copy-url-btn${copyStatus ? ` is-${copyStatus}` : ""}`}
          title={`Copy ${item.title} gallery URL`}
          aria-label={`Copy ${item.title} gallery URL`}
          onClick={(event) => {
            event.stopPropagation();
            void onCopyShareUrl();
          }}
        >
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="3" y="3" width="6.5" height="6.5" rx="1" />
            <path d="M3 6.5H1.5V1.5h5V3" />
          </svg>
          {copyStatus === "copied" ? "Copied" : copyStatus === "error" ? "Failed" : "Copy"}
        </button>
      </td>
      <td className="kgal-actions-cell">
        <div className="kgal-row-actions">
          {onShare && (
            <button
              className="kgal-row-btn"
              onClick={(event) => {
                event.stopPropagation();
                onShare();
              }}
              title="Share"
              aria-label={`Share ${item.title}`}
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
            className="kgal-row-btn kgal-row-btn-primary"
            onClick={(event) => {
              event.stopPropagation();
              onLaunch();
            }}
          >
            Launch
          </button>
        </div>
      </td>
    </tr>
  );
};

function galleryItemMatchesCurrent(
  item: GalleryItem,
  descriptor: BootDescriptor,
  descriptorVfsImageUrl: string | null,
): boolean {
  if (item.id === descriptor.id) return true;
  return item.vfsImageUrl !== undefined && descriptorVfsImageUrl !== null &&
    item.vfsImageUrl === descriptorVfsImageUrl;
}

async function shareUrlForGalleryItem(
  item: GalleryItem,
  currentDescriptor: BootDescriptor,
): Promise<string> {
  if (item.vfsImageUrl) return galleryItemUrl(item);

  const descriptor = descriptorFromGalleryItem(item, currentDescriptor);
  const encoded = await encodeBootDescriptor(descriptor);
  return buildShareUrl(descriptor, {
    mode: "inline",
    fragment: encoded.fragment,
    presetId: item.id,
  });
}

async function writeClipboardText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  const copied = document.execCommand("copy");
  document.body.removeChild(textarea);
  if (!copied) throw new Error("document.execCommand('copy') returned false");
}

/**
 * Apply a GalleryItem to a base BootDescriptor — used by the App to convert
 * a row click into an applyBootDescriptor() call. Lifts argv, packages, any
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
