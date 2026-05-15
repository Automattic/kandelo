import * as React from "react";
import { useWebPreview } from "../kernel-host/react";
import { PaneHead } from "./PaneHead";
import { Framebuffer, type FramebufferProps } from "./Framebuffer";

const ICON = (
  <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.4">
    <rect x="1.5" y="2" width="10" height="7.5" rx="1" />
    <path d="M4 11h5M6.5 9.5v1.5" />
  </svg>
);

export const Display: React.FC<FramebufferProps> = (props) => {
  const preview = useWebPreview();
  if (!preview) return <Framebuffer {...props} />;
  return <WebPreviewPane preview={preview} {...props} />;
};

const WebPreviewPane: React.FC<FramebufferProps & {
  preview: NonNullable<ReturnType<typeof useWebPreview>>;
}> = ({ preview, dragProps, onCollapse, onMaximize, isMax }) => {
  const [reloadKey, setReloadKey] = React.useState(0);
  const ready = preview.status === "running";
  return (
    <div className="kpane">
      <PaneHead
        icon={ICON}
        title={`WEB · ${preview.label.toUpperCase()}`}
        dragProps={dragProps}
        onCollapse={onCollapse}
        onMaximize={onMaximize}
        isMax={isMax}
        right={
          <button
            className="kgal-card-btn"
            onClick={() => setReloadKey((k) => k + 1)}
            disabled={!ready}
            title="Reload preview"
            aria-label="Reload preview"
          >
            Reload
          </button>
        }
      />
      <div className="kpane-body" style={{
        background: "var(--k-bg)",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}>
        {ready ? (
          <iframe
            key={reloadKey}
            src={preview.url}
            title={preview.label}
            style={{
              border: 0,
              width: "100%",
              height: "100%",
              background: "#fff",
            }}
          />
        ) : (
          <div style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: preview.status === "error" ? "var(--k-err)" : "var(--k-text-faint)",
            fontFamily: "var(--k-font-mono)",
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
            textAlign: "center",
            padding: 24,
          }}>
            {preview.message ?? "Starting service"}
          </div>
        )}
      </div>
    </div>
  );
};
