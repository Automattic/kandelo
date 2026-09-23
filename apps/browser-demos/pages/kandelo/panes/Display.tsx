import { beginPreviewNavigation, previewDocumentLoaded, previewRendered } from "./preview-progress";
import * as React from "react";
import { useKernelHost, useWebPreview } from "../kernel-host/react";
import { Framebuffer, type FramebufferProps } from "./Framebuffer";
import { Modeset } from "./Modeset";
import type { PrimarySurface } from "../../../../../web-libs/kandelo-session/src/kernel-host";

export interface WordPressLoginOptions {
  username: string;
  password: string;
  loginPath?: string;
  adminPath?: string;
}

export interface DisplayHandle {
  navigate(path: string): void;
  loginToWordPress(options: WordPressLoginOptions): Promise<void>;
}

export interface DisplayProps extends FramebufferProps {
  /**
   * Which demo surface the parent decided to mount. The mount is one of
   * "framebuffer" | "web" | "kms" -- Display routes to the matching pane.
   * Defaults to legacy behavior (web if a preview exists, otherwise
   * framebuffer) for callers that don't yet pass a surface.
   */
  surface?: PrimarySurface;
  onDockControlsChange?: (controls: React.ReactNode | null) => void;
}

export const Display = React.forwardRef<DisplayHandle, DisplayProps>(({ surface, onDockControlsChange, ...props }, ref) => {
  const preview = useWebPreview();

  if (surface === "kms") return <Modeset {...props} onDockControlsChange={onDockControlsChange} />;
  if (surface === "framebuffer") return <Framebuffer {...props} onDockControlsChange={onDockControlsChange} />;
  if (surface === "web" && preview) {
    return <WebPreviewPane ref={ref} preview={preview} onDockControlsChange={onDockControlsChange} {...props} />;
  }
  if (!preview) return <Framebuffer {...props} onDockControlsChange={onDockControlsChange} />;
  return <WebPreviewPane ref={ref} preview={preview} onDockControlsChange={onDockControlsChange} {...props} />;
});

Display.displayName = "Display";

const WebPreviewPane = React.forwardRef<DisplayHandle, FramebufferProps & {
  preview: NonNullable<ReturnType<typeof useWebPreview>>;
  onDockControlsChange?: (controls: React.ReactNode | null) => void;
}>(({ preview, autoFocus = false, onDockControlsChange }, ref) => {
  const host = useKernelHost();
  const [loading, setLoading] = React.useState(true);
  const [path, setPath] = React.useState("/");
  const [iframeSrc, setIframeSrc] = React.useState(() => buildPreviewUrl(preview.url, "/"));
  const ready = preview.status === "running";
  const pendingRequests = preview.pendingRequests ?? 0;
  const iframeRef = React.useRef<HTMLIFrameElement | null>(null);

  React.useEffect(() => {
    beginPreviewNavigation(host, "/");
    setLoading(true);
    setPath("/");
    setIframeSrc(buildPreviewUrl(preview.url, "/"));
  }, [host, preview.url]);

  React.useEffect(() => {
    if (!autoFocus || !ready) return;
    const handle = window.requestAnimationFrame(() => {
      iframeRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(handle);
  }, [autoFocus, iframeSrc, ready]);

  // Keep the iframe's browsing context alive. Internal navigations are synced
  // in onLoad, while parent-initiated navigations target the existing frame.
  const navigateFrame = React.useCallback((target: string) => {
    const progress = beginPreviewNavigation(host, relativePathFromHref(preview.url, target) ?? "/");
    setLoading(true);
    const frame = iframeRef.current;
    if (frame?.contentWindow) {
      try {
        const current = frame.contentWindow.location.href;
        if (current === target) {
          frame.contentWindow.location.reload();
          return;
        }
        if (current.split("#")[0] === target.split("#")[0] && frame.contentDocument?.readyState === "complete") {
          // Fragment-only navigation reuses the document and has no load event.
          frame.contentWindow.location.assign(target);
          progress.http = { state: "not_requested", status: null };
          progress.documentLoaded = true;
          setLoading(false);
          window.requestAnimationFrame(() => window.requestAnimationFrame(() => previewRendered(host, progress)));
          return;
        }
        frame.contentWindow.location.assign(target);
        return;
      } catch {
        // Fall back to updating src for unusual cross-origin or detached cases.
      }
    }
    setIframeSrc(target);
  }, [host, preview.url]);

  const navigate = React.useCallback((raw: string) => {
    const next = normalizePreviewPath(raw, preview.url);
    setPath(next);
    navigateFrame(buildPreviewUrl(preview.url, next));
  }, [navigateFrame, preview.url]);

  const navigateAndWait = React.useCallback(async (
    raw: string,
    predicate: (document: Document) => boolean,
    timeoutMs = 120_000,
  ) => {
    const next = normalizePreviewPath(raw, preview.url);
    setPath(next);
    navigateFrame(buildPreviewUrl(preview.url, next));
    await waitForFrameDocument(iframeRef, predicate, timeoutMs);
  }, [navigateFrame, preview.url]);

  const reloadPreview = React.useCallback(() => {
    beginPreviewNavigation(host, path);
    setLoading(true);
    const frame = iframeRef.current;
    if (frame?.contentWindow) {
      try {
        frame.contentWindow.location.reload();
        return;
      } catch {
        // Fall through to a best-effort navigation to the synced path.
      }
    }
    navigateFrame(buildPreviewUrl(preview.url, path));
  }, [host, navigateFrame, path, preview.url]);

  const syncFromFrame = React.useCallback(() => {
    const frame = iframeRef.current;
    if (!frame) return;
    try {
      const href = frame.contentWindow?.location.href;
      if (!href) return;
      const next = relativePathFromHref(preview.url, href);
      if (!next) return;
      setPath(next);
    } catch {
      // Cross-origin navigations are not expected for the service bridge,
      // but ignore them so the preview itself keeps working.
    }
  }, [preview.url]);

  const dockControls = React.useMemo(() => (
    <WebPreviewDockControls
      baseUrl={preview.url}
      path={path}
      ready={ready}
      pendingRequests={pendingRequests}
      loading={loading}
      message={preview.message}
      onNavigate={navigate}
      onReload={reloadPreview}
    />
  ), [loading, navigate, path, pendingRequests, preview.message, preview.url, ready, reloadPreview]);

  React.useEffect(() => {
    if (!onDockControlsChange) return;
    onDockControlsChange(dockControls);
    return () => onDockControlsChange(null);
  }, [dockControls, onDockControlsChange]);

  React.useImperativeHandle(ref, () => ({
    navigate,
    async loginToWordPress(options) {
      if (!ready) throw new Error("Web preview is not ready");
      const loginPath = options.loginPath ?? "/wp-login.php";
      const adminPath = options.adminPath ?? "/wp-admin/";

      await navigateAndWait(
        loginPath,
        (doc) => isWordPressLoginVisible(doc) || isWordPressAdminVisible(doc),
      );
      let doc = frameDocument(iframeRef);
      if (!doc) throw new Error("WordPress preview is unavailable");
      if (!isWordPressAdminVisible(doc)) {
        const userInput = doc.querySelector<HTMLInputElement>("#user_login");
        const passwordInput = doc.querySelector<HTMLInputElement>("#user_pass");
        const submit = doc.querySelector<HTMLElement>("#wp-submit");
        if (!userInput || !passwordInput || !submit) {
          throw new Error("WordPress login form is not available");
        }
        setInputValue(userInput, options.username);
        setInputValue(passwordInput, options.password);
        submit.click();
        await waitForFrameDocument(iframeRef, isWordPressAdminVisible);
      }

      doc = frameDocument(iframeRef);
      if (!doc || !isWordPressAdminVisible(doc)) {
        await navigateAndWait(adminPath, isWordPressAdminVisible);
      }
    },
  }), [navigate, navigateAndWait, ready]);

  return (
    <div className="kdisplay-surface">
      {ready ? (
        <iframe
          ref={iframeRef}
          className="kweb-frame"
          src={iframeSrc}
          title={preview.label}
          onLoad={() => {
            syncFromFrame();
            const frame = iframeRef.current;
            try {
              const href = frame?.contentWindow?.location.href;
              const loadedPath = href && relativePathFromHref(preview.url, href);
              if (loadedPath && frame?.contentDocument?.readyState === "complete") {
                setLoading(false);
                const state = previewDocumentLoaded(host, loadedPath);
                // Two animation frames allow the newly loaded document a paint
                // opportunity. This is not application-specific hydration readiness.
                if (state) window.requestAnimationFrame(() => window.requestAnimationFrame(() => previewRendered(host, state)));
              }
            } catch { /* An inaccessible document cannot prove rendered readiness. */ }
            if (autoFocus) iframeRef.current?.focus();
          }}
        />
      ) : (
        <div
          className={`kdisplay-status${
            preview.status === "error" || preview.status === "offline"
              ? " is-error"
              : ""
          }${preview.status === "reconnecting" ? " is-reconnecting" : ""}`}
          role="status"
          data-testid={
            preview.status === "offline"
              ? "web-preview-offline"
              : preview.status === "reconnecting"
                ? "web-preview-reconnecting"
                : undefined
          }
        >
          {preview.message ?? "Starting service"}
        </div>
      )}
    </div>
  );
});

WebPreviewPane.displayName = "WebPreviewPane";

const WebPreviewDockControls: React.FC<{
  baseUrl: string;
  path: string;
  ready: boolean;
  pendingRequests: number;
  loading: boolean;
  message?: string;
  onNavigate: (path: string) => void;
  onReload: () => void;
}> = ({ baseUrl, path, ready, pendingRequests, loading, message, onNavigate, onReload }) => {
  const [draftPath, setDraftPath] = React.useState(path);
  const loadingTitle = loading
    ? `Waiting for the preview document (${pendingRequests} pending requests)`
    : undefined;

  React.useEffect(() => {
    setDraftPath(path);
  }, [path]);

  return (
    <form
      className="kweb-urlbar"
      title={ready ? undefined : message ?? "Starting service"}
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) onNavigate(draftPath);
      }}
    >
      <button
        type="button"
        className="kdock-view-iconbtn kweb-reload"
        onClick={onReload}
        disabled={!ready}
        title="Reload preview"
        aria-label="Reload preview"
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M13 6.5A5 5 0 1 0 11.4 11" />
          <path d="M13 3.5v3h-3" />
        </svg>
      </button>
      <input
        className="kweb-urlbar-input"
        value={draftPath}
        onChange={(event) => setDraftPath(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
          event.preventDefault();
          if (ready) onNavigate(event.currentTarget.value);
        }}
        onBlur={() => setDraftPath((value) => normalizePreviewPath(value, baseUrl))}
        disabled={!ready}
        spellCheck={false}
        enterKeyHint="go"
        aria-label="Preview URL path"
      />
      <span
        className={`kweb-loading${loading ? " is-active" : ""}`}
        role={loading ? "status" : undefined}
        aria-hidden={loading ? undefined : true}
        aria-label={loading ? "Loading preview" : undefined}
        title={loadingTitle}
      >
        <span className="kweb-loading-spinner" aria-hidden="true" />
        <span className="kweb-loading-text">{loading ? "Loading..." : null}</span>
      </span>
    </form>
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

function frameDocument(ref: React.RefObject<HTMLIFrameElement | null>): Document | null {
  try {
    return ref.current?.contentDocument ?? ref.current?.contentWindow?.document ?? null;
  } catch {
    return null;
  }
}

async function waitForFrameDocument(
  ref: React.RefObject<HTMLIFrameElement | null>,
  predicate: (document: Document) => boolean,
  timeoutMs = 120_000,
): Promise<void> {
  const started = performance.now();
  let lastError = "";
  while (performance.now() - started < timeoutMs) {
    const doc = frameDocument(ref);
    if (doc) {
      try {
        if (predicate(doc)) return;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    await sleep(100);
  }
  throw new Error(lastError || "Timed out waiting for the web preview");
}

function isWordPressLoginVisible(document: Document): boolean {
  return document.querySelector("#loginform #user_login") !== null &&
    document.querySelector("#loginform #user_pass") !== null;
}

function isWordPressAdminVisible(document: Document): boolean {
  return document.querySelector("#wpadminbar, #adminmenu") !== null ||
    document.body?.classList.contains("wp-admin") === true;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  input.focus();
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
