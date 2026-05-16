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
  const [path, setPath] = React.useState("/");
  const [draftPath, setDraftPath] = React.useState("/");
  const ready = preview.status === "running";
  const iframeRef = React.useRef<HTMLIFrameElement | null>(null);
  const iframeSrc = React.useMemo(() => buildPreviewUrl(preview.url, path), [preview.url, path]);

  React.useEffect(() => {
    setPath("/");
    setDraftPath("/");
    setReloadKey(0);
  }, [preview.url]);

  const navigate = React.useCallback((raw: string) => {
    const next = normalizePreviewPath(raw, preview.url);
    setPath(next);
    setDraftPath(next);
    setReloadKey((k) => k + 1);
  }, [preview.url]);

  const syncFromFrame = React.useCallback(() => {
    const frame = iframeRef.current;
    if (!frame) return;
    try {
      const href = frame.contentWindow?.location.href;
      if (!href) return;
      const next = relativePathFromHref(preview.url, href);
      if (!next) return;
      setPath(next);
      setDraftPath(next);
    } catch {
      // Cross-origin navigations are not expected for the service bridge,
      // but ignore them so the preview itself keeps working.
    }
  }, [preview.url]);

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
          <>
            <form
              className="kweb-urlbar"
              onSubmit={(event) => {
                event.preventDefault();
                navigate(draftPath);
              }}
            >
              <span className="kweb-urlbar-origin">{previewOriginLabel(preview.url)}</span>
              <input
                className="kweb-urlbar-input"
                value={draftPath}
                onChange={(event) => setDraftPath(event.currentTarget.value)}
                onBlur={() => setDraftPath((value) => normalizePreviewPath(value, preview.url))}
                spellCheck={false}
                aria-label="Preview URL path"
              />
              <button className="kweb-urlbar-go" type="submit">Go</button>
            </form>
            <iframe
              ref={iframeRef}
              key={`${reloadKey}:${iframeSrc}`}
              src={iframeSrc}
              title={preview.label}
              onLoad={syncFromFrame}
              style={{
                border: 0,
                width: "100%",
                flex: 1,
                minHeight: 0,
                background: "#fff",
              }}
            />
          </>
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

function buildPreviewUrl(base: string, path: string): string {
  if (base === "about:blank") return base;
  try {
    const root = new URL(base, window.location.href);
    const normalized = normalizePreviewPath(path, base);
    const rel = normalized.slice(1);
    return new URL(rel || ".", root).href;
  } catch {
    return base;
  }
}

function normalizePreviewPath(raw: string, base: string): string {
  const value = raw.trim();
  if (!value) return "/";

  const fromAbsolute = relativePathFromHref(base, value);
  if (fromAbsolute) return fromAbsolute;

  if (value.startsWith("?") || value.startsWith("#")) return `/${value}`;
  return value.startsWith("/") ? value : `/${value}`;
}

function relativePathFromHref(base: string, href: string): string | null {
  if (base === "about:blank") return "/";
  try {
    const root = new URL(base, window.location.href);
    const url = new URL(href, root);
    const rootPath = root.pathname.endsWith("/") ? root.pathname : `${root.pathname}/`;
    if (url.origin !== root.origin || !url.pathname.startsWith(rootPath)) return null;
    const suffix = url.pathname.slice(rootPath.length);
    return `/${suffix}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

function previewOriginLabel(base: string): string {
  if (base === "about:blank") return "about:";
  try {
    const root = new URL(base, window.location.href);
    const path = root.pathname.endsWith("/") ? root.pathname : `${root.pathname}/`;
    return `${root.origin}${path}`;
  } catch {
    return base;
  }
}
