// MachineView — the tiled Inspector/Framebuffer/Shell layout.
//
// Three positional slots: [left, top, bot]. Each slot holds one of the
// three tile ids (inspector / fb / shell), so users can swap which pane
// occupies which slot via drag-and-drop on the pane header.
//
// Affordances:
//   - Drag a pane's header to swap it with another slot. Drop target
//     gets an accent-tinted overlay + dashed outline.
//   - Collapse a pane to a 36px (left slot) or 32px (right slots) strip
//     with title rotated for the left slot. Splitter on the collapsed
//     side hides; remaining panes take the freed space.
//   - Maximize a pane to overlay the full tile area. Click again to
//     restore.
//   - Splitter drags resize ratios. Both splitter ratios + slot order +
//     collapse state persist to localStorage so the layout survives
//     reloads (keyed on origin so different deployments stay isolated).

import * as React from "react";
import { Inspector } from "../panes/Inspector";
import { Display } from "../panes/Display";
import { Shell } from "../panes/Shell";
import type { PaneHeadDragProps } from "../panes/PaneHead";

type TileId = "inspector" | "fb" | "shell";
const TILE_IDS: TileId[] = ["inspector", "fb", "shell"];
const DEFAULT_SLOTS: [TileId, TileId, TileId] = ["inspector", "fb", "shell"];

const COLLAPSED_V = 36;
const COLLAPSED_H = 32;

const STORAGE_KEY = "kandelo.machine-view";
interface PersistedLayout {
  slots?: [TileId, TileId, TileId];
  collapsed?: Partial<Record<TileId, boolean>>;
  inspRatio?: number;
  fbRatio?: number;
}

function loadLayout(): PersistedLayout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: PersistedLayout = JSON.parse(raw);
    // Validate slot ids; reject anything we don't recognize.
    if (parsed.slots) {
      const valid = parsed.slots.every((id) => TILE_IDS.includes(id))
        && new Set(parsed.slots).size === 3;
      if (!valid) parsed.slots = undefined;
    }
    return parsed;
  } catch {
    return {};
  }
}

function saveLayout(layout: PersistedLayout): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // localStorage unavailable / quota exceeded — skip silently.
  }
}

const TILE_META: Record<TileId, { label: string; icon: React.ReactNode }> = {
  inspector: {
    label: "Inspector",
    icon: (
      <svg width="11" height="11" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.4">
        <circle cx="5.5" cy="5.5" r="3.2" />
        <path d="M8 8l3 3" />
      </svg>
    ),
  },
  fb: {
    label: "Display",
    icon: (
      <svg width="11" height="11" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.4">
        <rect x="1.5" y="2" width="10" height="7.5" rx="1" />
        <path d="M4 11h5M6.5 9.5v1.5" />
      </svg>
    ),
  },
  shell: {
    label: "Shell",
    icon: (
      <svg width="11" height="11" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
        <path d="M2 3l3 3-3 3M6 9.5h5" />
      </svg>
    ),
  },
};

export interface MachineViewProps {
  internalsTab: string;
  onInternalsTab: (id: string) => void;
}

export const MachineView: React.FC<MachineViewProps> = ({ internalsTab, onInternalsTab }) => {
  const tileRef = React.useRef<HTMLDivElement>(null);
  const rightColRef = React.useRef<HTMLDivElement>(null);

  // Initialize from localStorage so the user's saved layout shows up on first paint.
  const initial = React.useMemo(loadLayout, []);
  const [slots, setSlots] = React.useState<[TileId, TileId, TileId]>(
    initial.slots ?? DEFAULT_SLOTS,
  );
  const [collapsed, setCollapsed] = React.useState<Partial<Record<TileId, boolean>>>(
    initial.collapsed ?? {},
  );
  const [inspRatio, setInspRatio] = React.useState<number>(initial.inspRatio ?? 0.48);
  const [fbRatio, setFbRatio] = React.useState<number>(initial.fbRatio ?? 0.58);
  const [maxPane, setMaxPane] = React.useState<TileId | null>(null);
  const [dragOverSlot, setDragOverSlot] = React.useState<number | null>(null);
  const [draggingTile, setDraggingTile] = React.useState<TileId | null>(null);

  const [tileW, setTileW] = React.useState(800);
  const [rightH, setRightH] = React.useState(500);

  React.useEffect(() => {
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        if (e.target === tileRef.current) setTileW(e.contentRect.width);
        if (e.target === rightColRef.current) setRightH(e.contentRect.height);
      }
    });
    if (tileRef.current) ro.observe(tileRef.current);
    if (rightColRef.current) ro.observe(rightColRef.current);
    return () => ro.disconnect();
  }, []);

  // Persist layout whenever it changes. Debounced via a microtask so a
  // burst of state changes during a drag/splitter motion writes once.
  React.useEffect(() => {
    let pending = false;
    const handle = window.setTimeout(() => {
      pending = false;
      saveLayout({ slots, collapsed, inspRatio, fbRatio });
    }, 120);
    pending = true;
    return () => {
      if (pending) window.clearTimeout(handle);
    };
  }, [slots, collapsed, inspRatio, fbRatio]);

  // ── Drag-rearrange ─────────────────────────────────────────────────────

  const dragPropsFor = (id: TileId): PaneHeadDragProps => ({
    draggable: true,
    onDragStart: (e) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/kandelo-tile", id);
      setDraggingTile(id);
    },
  });

  const slotDropProps = (idx: number) => ({
    onDragOver: (e: React.DragEvent) => {
      if (Array.from(e.dataTransfer.types).includes("text/kandelo-tile")) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (dragOverSlot !== idx) setDragOverSlot(idx);
      }
    },
    onDragLeave: () => {
      setDragOverSlot((s) => (s === idx ? null : s));
    },
    onDrop: (e: React.DragEvent) => {
      const src = e.dataTransfer.getData("text/kandelo-tile") as TileId;
      if (src && TILE_IDS.includes(src)) {
        setSlots((prev) => swapSlots(prev, src, idx));
      }
      setDragOverSlot(null);
      setDraggingTile(null);
    },
    onDragEnd: () => {
      setDragOverSlot(null);
      setDraggingTile(null);
    },
  });

  // ── Splitters ──────────────────────────────────────────────────────────

  const onInspDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startRatio = inspRatio;
    const move = (ev: PointerEvent) => {
      setInspRatio(clamp(startRatio + (ev.clientX - startX) / tileW, 0.2, 0.8));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onFbDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startRatio = fbRatio;
    const move = (ev: PointerEvent) => {
      setFbRatio(clamp(startRatio + (ev.clientY - startY) / rightH, 0.2, 0.8));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // ── Pane callbacks ─────────────────────────────────────────────────────

  const onCollapse = (id: TileId) =>
    setCollapsed((c) => ({ ...c, [id]: !c[id] }));
  const onMaximize = (id: TileId) =>
    setMaxPane((cur) => (cur === id ? null : id));

  const tilePaneFor = (id: TileId, opts: {
    dragProps?: PaneHeadDragProps;
    onCollapse?: () => void;
    onMaximize?: () => void;
    isMax?: boolean;
  }) => {
    if (id === "inspector") {
      return (
        <Inspector
          tab={internalsTab}
          onTab={onInternalsTab}
          {...opts}
        />
      );
    }
    if (id === "fb") {
      return <Display {...opts} />;
    }
    return <Shell {...opts} />;
  };

  // ── Slot layout math ───────────────────────────────────────────────────

  const [leftId, topId, botId] = slots;
  const leftC = !!collapsed[leftId];
  const topC = !!collapsed[topId];
  const botC = !!collapsed[botId];
  const leftWidth = leftC ? COLLAPSED_V : tileW * inspRatio;
  const showVSplit = !leftC;
  const showHSplit = !topC && !botC;

  let topHeight: number;
  let botHeight: number;
  if (topC && botC) {
    topHeight = COLLAPSED_H;
    botHeight = COLLAPSED_H;
  } else if (topC) {
    topHeight = COLLAPSED_H;
    botHeight = rightH - COLLAPSED_H;
  } else if (botC) {
    topHeight = rightH - COLLAPSED_H;
    botHeight = COLLAPSED_H;
  } else {
    topHeight = rightH * fbRatio;
    botHeight = rightH - topHeight;
  }

  const renderSlot = (id: TileId, idx: number, orient: "v" | "h") => {
    const isC = !!collapsed[id];
    const isOver = dragOverSlot === idx;
    const drop = slotDropProps(idx);
    const isDragging = draggingTile === id;

    if (isC) {
      return (
        <CollapsedStrip
          id={id}
          orient={orient}
          onExpand={() => onCollapse(id)}
          dragProps={dragPropsFor(id)}
          isOver={isOver}
          dropProps={drop}
        />
      );
    }
    return (
      <div
        className="kslot"
        {...drop}
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
          minHeight: 0,
          position: "relative",
          outline: isOver
            ? "2px dashed var(--k-accent)"
            : isDragging
              ? "2px dashed color-mix(in oklch, var(--k-accent) 60%, transparent)"
              : undefined,
          outlineOffset: "-2px",
        }}
      >
        {isOver && (
          <div style={{
            position: "absolute",
            inset: 0,
            background: "color-mix(in oklch, var(--k-accent) 12%, transparent)",
            pointerEvents: "none",
            zIndex: 4,
          }} />
        )}
        {tilePaneFor(id, {
          dragProps: dragPropsFor(id),
          onCollapse: () => onCollapse(id),
          onMaximize: () => onMaximize(id),
          isMax: maxPane === id,
        })}
      </div>
    );
  };

  return (
    <div className="ktile" ref={tileRef}>
      <div
        className="ktile-col"
        style={{ width: leftWidth, flexShrink: 0, minWidth: COLLAPSED_V }}
      >
        {renderSlot(leftId, 0, "v")}
      </div>
      {showVSplit && <div className="ksplitter-v" onPointerDown={onInspDown} />}
      <div className="ktile-col" style={{ flex: 1, minWidth: 0 }} ref={rightColRef}>
        <div style={{ height: topHeight, minHeight: COLLAPSED_H, display: "flex" }}>
          {renderSlot(topId, 1, "h")}
        </div>
        {showHSplit && <div className="ksplitter-h" onPointerDown={onFbDown} />}
        <div style={{
          height: (topC || botC) ? botHeight : undefined,
          flex: (topC || botC) ? "0 0 auto" : 1,
          minHeight: COLLAPSED_H,
          display: "flex",
        }}>
          {renderSlot(botId, 2, "h")}
        </div>
      </div>
      {maxPane && (
        <div className="kmax">
          {tilePaneFor(maxPane, {
            onMaximize: () => onMaximize(maxPane),
            isMax: true,
          })}
        </div>
      )}
    </div>
  );
};

interface SlotDropProps {
  onDragOver: React.DragEventHandler;
  onDragLeave: React.DragEventHandler;
  onDrop: React.DragEventHandler;
  onDragEnd: React.DragEventHandler;
}

const CollapsedStrip: React.FC<{
  id: TileId;
  orient: "v" | "h";
  onExpand: () => void;
  dragProps: PaneHeadDragProps;
  isOver: boolean;
  dropProps: SlotDropProps;
}> = ({ id, orient, onExpand, dragProps, isOver, dropProps }) => {
  const meta = TILE_META[id];
  return (
    <div
      className={`kcoll kcoll-${orient}${isOver ? " kcoll-over" : ""}`}
      {...dragProps}
      {...dropProps}
    >
      <span className="kcoll-dot" />
      <span className="kcoll-ico">{meta.icon}</span>
      <div className="kcoll-label">{meta.label}</div>
      <button
        className="kcoll-expand"
        title="Expand"
        onClick={(e) => { e.stopPropagation(); onExpand(); }}
      >
        <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.4">
          {orient === "v" ? (
            <>
              <path d="M1.5 5.5h8" />
              <path d="M3.5 3.5l-2 2 2 2" />
              <path d="M7.5 3.5l2 2-2 2" />
            </>
          ) : (
            <>
              <path d="M5.5 1.5v8" />
              <path d="M3.5 3.5l2-2 2 2" />
              <path d="M3.5 7.5l2 2 2-2" />
            </>
          )}
        </svg>
      </button>
    </div>
  );
};

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function swapSlots(
  slots: [TileId, TileId, TileId],
  src: TileId,
  dstIdx: number,
): [TileId, TileId, TileId] {
  const srcIdx = slots.indexOf(src);
  if (srcIdx === -1 || srcIdx === dstIdx) return slots;
  const next: [TileId, TileId, TileId] = [...slots];
  next[srcIdx] = slots[dstIdx];
  next[dstIdx] = src;
  return next;
}
