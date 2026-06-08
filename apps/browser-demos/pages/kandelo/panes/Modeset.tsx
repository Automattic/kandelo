// Modeset pane — paints whatever process holds DRM master on CRTC 1 and
// commits page-flips through the KMS pipeline. Mirrors the Framebuffer
// pane in shape: the pane never spawns the renderer (whoever the user
// runs from the shell drives it); it only attaches an OffscreenCanvas
// + stats SAB so the kernel-worker's 60 Hz vblank pump has somewhere
// to land pixels.
//
// Stats slot layout (set by CentralizedKernelWorker.tickVblank):
//   0: frame count (host pump, monotonic)
//   1: last blit timestamp (ms, performance.now() | 0)
//   2: current scanout width
//   3: current scanout height
//   4: last blit µs
//   5: kernel-side PAGE_FLIP commit count
//   6: kernel-side last frame µs (clock at PAGE_FLIP completion)

import * as React from "react";
import { useKernelHost, useStatus } from "../kernel-host/react";
import type { KmsDisplayHandle } from "../../../../../web-libs/kandelo-session/src/kernel-host";
import { PaneHead } from "./PaneHead";

const ICON = (
  <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.4">
    <rect x="1.5" y="2" width="10" height="6.5" rx="1" />
    <path d="M4 11h5M6.5 8.5v2.5" />
  </svg>
);

export interface ModesetProps {
  dragProps?: import("./PaneHead").PaneHeadDragProps;
  onCollapse?: () => void;
  onMaximize?: () => void;
  isMax?: boolean;
  /** CRTC to bind the canvas to. Defaults to 1 (the single CRTC the
   *  kernel currently advertises via MODE_GETRESOURCES). */
  crtcId?: number;
}

interface KmsStats {
  frameCount: number;
  width: number;
  height: number;
  blitUs: number;
  commitCount: number;
  lastFrameUs: number;
}

const ZERO_STATS: KmsStats = {
  frameCount: 0,
  width: 0,
  height: 0,
  blitUs: 0,
  commitCount: 0,
  lastFrameUs: 0,
};

export const Modeset: React.FC<ModesetProps> = ({ dragProps, onCollapse, onMaximize, isMax, crtcId = 1 }) => {
  const host = useKernelHost();
  const status = useStatus();
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const handleRef = React.useRef<KmsDisplayHandle | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [stats, setStats] = React.useState<KmsStats>(ZERO_STATS);

  // Attach the canvas as soon as we have one and the kernel is up.
  React.useEffect(() => {
    if (status !== "running") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (handleRef.current) return;

    try {
      const handle = host.attachKmsDisplay(canvas, crtcId);
      if (!handle) {
        setError("Kernel does not expose kmsAttachCanvas (older ABI?)");
        return;
      }
      handleRef.current = handle;
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }

    return () => {
      handleRef.current?.close();
      handleRef.current = null;
    };
  }, [host, status, crtcId]);

  // Drain the stats SAB at 4 Hz. The numbers are advisory; rAF would
  // re-render every blit, which is overkill for a status panel.
  React.useEffect(() => {
    const handle = handleRef.current;
    if (!handle) return;
    const tick = () => {
      const s = handle.stats;
      setStats({
        frameCount: Atomics.load(s, 0),
        width: Atomics.load(s, 2),
        height: Atomics.load(s, 3),
        blitUs: Atomics.load(s, 4),
        commitCount: Atomics.load(s, 5),
        lastFrameUs: Atomics.load(s, 6),
      });
    };
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [status, error]);

  const showCanvas = status === "running" && !error;
  const hasFrame = stats.width > 0 && stats.height > 0;

  return (
    <div className="kpane">
      <PaneHead
        icon={ICON}
        title={`MODESET · /DEV/DRI/CARD0 · CRTC ${crtcId}`}
        dragProps={dragProps}
        onCollapse={onCollapse}
        onMaximize={onMaximize}
        isMax={isMax}
        right={
          <span style={{
            fontFamily: "var(--k-font-mono)",
            fontSize: 10,
            color: hasFrame ? "var(--k-accent)" : "var(--k-text-faint)",
            padding: "2px 6px",
            borderRadius: 3,
            border: "1px solid var(--k-border)",
            textTransform: "uppercase",
            letterSpacing: "0.04em",
            fontWeight: 600,
          }}>
            {hasFrame
              ? `${stats.commitCount} flips · ${stats.lastFrameUs}µs`
              : "waiting for PAGE_FLIP"}
          </span>
        }
      />
      <div className="kpane-body" style={{
        background: "var(--k-fb-bg)",
        color: "var(--k-fb-text)",
        display: "flex",
        flexDirection: "column",
        alignItems: "stretch",
        padding: 0,
        position: "relative",
      }}>
        <div style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
          position: "relative",
        }}>
          <canvas
            ref={canvasRef}
            style={{
              maxWidth: "100%",
              maxHeight: "100%",
              imageRendering: "pixelated",
              background: "var(--k-fb-bg)",
              display: showCanvas ? "block" : "none",
            }}
          />
          {showCanvas && !hasFrame && (
            <div style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: "var(--k-font-mono)",
              fontSize: 11,
              color: "color-mix(in oklch, var(--k-fb-text) 60%, transparent)",
              pointerEvents: "none",
              textAlign: "center",
              padding: 24,
            }}>
              Waiting for a process to drmModePageFlip on CRTC {crtcId}.<br />
              Run <code>modeset</code> from the shell.
            </div>
          )}
          {(error || status !== "running") && (
            <div style={{
              fontFamily: "var(--k-font-mono)",
              fontSize: 11,
              color: "color-mix(in oklch, var(--k-fb-text) 60%, transparent)",
              textAlign: "center",
              padding: 24,
            }}>
              {error
                ? <>attachKmsDisplay failed: {error}</>
                : <>Waiting for the kernel to reach 'running'.</>}
            </div>
          )}
        </div>
        {hasFrame && (
          <div style={{
            fontFamily: "var(--k-font-mono)",
            fontSize: 10,
            color: "color-mix(in oklch, var(--k-fb-text) 70%, transparent)",
            padding: "6px 10px",
            borderTop: "1px solid var(--k-border)",
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: "2px 16px",
          }}>
            <span>scanout {stats.width}×{stats.height}</span>
            <span>blit {stats.blitUs}µs</span>
            <span>pump frame #{stats.frameCount}</span>
            <span>commits {stats.commitCount}</span>
            <span>last flip {stats.lastFrameUs}µs</span>
            <span>crtc {crtcId}</span>
          </div>
        )}
      </div>
    </div>
  );
};
