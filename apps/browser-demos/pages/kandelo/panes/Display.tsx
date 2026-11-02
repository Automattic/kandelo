import { beginPreviewNavigation, getPreviewProgress, previewDocumentLoaded, previewRendered } from "./preview-progress";
import { subscribePreviewNavigation } from "./preview-navigation";
import { PREVIEW_FRAME_ALLOW, PREVIEW_FRAME_SANDBOX } from "../../../lib/preview/protocol";
import type { PreviewNavigation } from "../../../lib/preview/preview-bridge";
import { buildPreviewUrl, normalizePreviewPath, relativePathFromHref } from "./preview-url";
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
  active?: boolean;
  /**
   * Which demo surface the parent decided to mount. The mount is one of
   * "framebuffer" | "web" | "kms" -- Display routes to the matching pane.
   * Defaults to legacy behavior (web if a preview exists, otherwise
   * framebuffer) for callers that don't yet pass a surface.
   */
  surface?: PrimarySurface;
  onDockControlsChange?: (controls: React.ReactNode | null) => void;
  onKmsOwnerChange?: (pid: number | null) => void;
}

export const Display = React.forwardRef<DisplayHandle, DisplayProps>(({ active, surface, onDockControlsChange, onKmsOwnerChange, ...props }, ref) => {
  const preview = useWebPreview();

  if (surface === "kms") return <Modeset {...props} active={active} onDockControlsChange={onDockControlsChange} onOwnerChange={onKmsOwnerChange} />;
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
  const [path, setPath] = React.useState(preview.initialPath ?? "/");
  const [iframeSrc, setIframeSrc] = React.useState(() => buildPreviewUrl(preview.url, preview.initialPath ?? "/"));
  const ready = preview.status === "running";
  const pendingRequests = preview.pendingRequests ?? 0;
  const iframeRef = React.useRef<HTMLIFrameElement | null>(null);
  // The guest frame is on the preview origin, so its location and document
  // are unreadable here. Track its URL from the src this pane sets and from
  // every document navigation the machine's bridge serves.
  const frameUrlRef = React.useRef(iframeSrc);
  // A browsing-context name, so a form in this page can POST into the frame.
  const frameName = `kandelo-preview${React.useId().replace(/[^A-Za-z0-9_-]/g, "")}`;

  React.useEffect(() => {
    beginPreviewNavigation(host, preview.initialPath ?? "/");
    setLoading(true);
    setPath(preview.initialPath ?? "/");
    const src = buildPreviewUrl(preview.url, preview.initialPath ?? "/");
    frameUrlRef.current = src;
    setIframeSrc(src);
  }, [host, preview.url]);

  // Navigation requests name the machine, not this frame: a nested guest
  // frame or another tab viewing the same machine reports them too. The
  // frame's own document is the first non-redirect navigation served since
  // its previous load (a document is requested before its subresources and
  // nested frames), so that is what its next load event adopts.
  const navigationsSinceLoad = React.useRef<PreviewNavigation[]>([]);
  React.useEffect(() => subscribePreviewNavigation(host, (navigation) => {
    const pending = navigationsSinceLoad.current;
    if (pending.length < 32) pending.push(navigation);
  }), [host]);

  React.useEffect(() => {
    if (!autoFocus || !ready) return;
    const handle = window.requestAnimationFrame(() => {
      iframeRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(handle);
  }, [autoFocus, iframeSrc, ready]);

  // Keep the iframe's browsing context alive: navigations re-target the
  // existing frame. Assigning `src` navigates even to the same URL (a reload).
  const navigateFrame = React.useCallback((target: string) => {
    const progress = beginPreviewNavigation(host, relativePathFromHref(preview.url, target) ?? "/");
    setLoading(true);
    const frame = iframeRef.current;
    const current = frameUrlRef.current;
    frameUrlRef.current = target;
    navigationsSinceLoad.current = [];
    if (!frame) {
      setIframeSrc(target);
      return;
    }
    if (target === current && target.includes("#")) {
      // Assigning the same URL with a fragment only scrolls; reload the
      // document itself.
      frame.src = target.split("#")[0]!;
      return;
    }
    frame.src = target;
    if (target !== current && target.includes("#") && current.split("#")[0] === target.split("#")[0]) {
      // Fragment-only navigation reuses the document and has no load event.
      progress.http = { state: "not_requested", status: null };
      progress.documentLoaded = true;
      setLoading(false);
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => previewRendered(host, progress)));
    }
  }, [host, preview.url]);

  const [navigationError, setNavigationError] = React.useState<string | null>(null);
  const navigate = React.useCallback((raw: string) => {
    setNavigationError(null);
    if (/^https?:\/\//i.test(raw) && relativePathFromHref(preview.url, raw) === null) {
      try {
        const url = new URL(raw);
        if (url.protocol !== "http:" || url.username || url.password || !host.openWebPreview) throw new Error("Use an HTTP address on this computer or its Kandelo network");
        void host.openWebPreview({ hostname: url.hostname, port: Number(url.port || 80), path: url.pathname + url.search + url.hash })
          .catch(error => setNavigationError(String(error instanceof Error ? error.message : error)));
      } catch (error) { setNavigationError(String(error instanceof Error ? error.message : error)); }
      return;
    }
    const next = normalizePreviewPath(raw, preview.url);
    setPath(next);
    navigateFrame(buildPreviewUrl(preview.url, next));
  }, [host, navigateFrame, preview.url]);

  const reloadPreview = React.useCallback(() => {
    navigateFrame(frameUrlRef.current);
  }, [navigateFrame]);

  /** The next served navigation that `match` accepts, or a timeout. */
  const nextNavigation = React.useCallback((
    match: (navigation: PreviewNavigation) => boolean,
    timeoutMs = 120_000,
  ): Promise<PreviewNavigation> => new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      unsubscribe();
      reject(new Error("Timed out waiting for the web preview"));
    }, timeoutMs);
    const unsubscribe = subscribePreviewNavigation(host, (navigation) => {
      if (!match(navigation)) return;
      window.clearTimeout(timer);
      unsubscribe();
      resolve(navigation);
    });
  }), [host]);

  const dockControls = React.useMemo(() => (
    <WebPreviewDockControls
      baseUrl={preview.url}
      path={path}
      ready={ready}
      pendingRequests={pendingRequests}
      loading={ready && loading}
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
      const loginPath = normalizePreviewPath(options.loginPath ?? "/wp-login.php", preview.url);
      const adminPath = normalizePreviewPath(options.adminPath ?? "/wp-admin/", preview.url);

      // Load the login page first: WordPress sets its test cookie there, and
      // the machine's cookie jar must hold it before the form is posted.
      const loginPage = nextNavigation((n) => samePath(n.path, loginPath));
      navigate(loginPath);
      const loaded = await loginPage;
      if (loaded.status === null || loaded.status >= 500) {
        throw new Error(`WordPress login page failed (HTTP ${loaded.status ?? "error"})`);
      }

      // The frame is cross-origin, so the page cannot fill its form. It posts
      // the same fields into the frame by name, as a browser form would.
      const outcome = nextNavigation((n) =>
        (samePath(n.path, adminPath) && n.method === "GET") ||
        (samePath(n.path, loginPath) && n.method === "POST")
      );
      setLoading(true);
      beginPreviewNavigation(host, adminPath);
      // The post starts a new frame navigation, possibly before the login
      // page's own load event; the next load belongs to it.
      navigationsSinceLoad.current = [];
      const form = document.createElement("form");
      form.method = "post";
      form.action = buildPreviewUrl(preview.url, loginPath);
      form.target = frameName;
      form.hidden = true;
      for (const [name, value] of Object.entries({
        log: options.username,
        pwd: options.password,
        "wp-submit": "Log In",
        redirect_to: buildPreviewUrl(preview.url, adminPath),
        testcookie: "1",
      })) {
        const input = document.createElement("input");
        input.type = "hidden";
        input.name = name;
        input.value = value;
        form.append(input);
      }
      document.body.append(form);
      try {
        form.submit();
      } finally {
        form.remove();
      }
      const result = await outcome;
      // A POST answered in place (200) is WordPress re-rendering the login
      // form with an error; success redirects to the admin path.
      if (!samePath(result.path, adminPath) || result.status === null || result.status >= 400) {
        throw new Error(`WordPress did not accept the login (HTTP ${result.status ?? "error"})`);
      }
    },
  }), [frameName, host, navigate, nextNavigation, preview.url, ready]);

  return (
    <div className="kdisplay-surface">
      {navigationError && <div role="alert">{navigationError}</div>}
      {ready ? (
        <iframe
          ref={iframeRef}
          className="kweb-frame"
          name={frameName}
          src={iframeSrc}
          title={preview.label}
          sandbox={PREVIEW_FRAME_SANDBOX}
          allow={PREVIEW_FRAME_ALLOW}
          /* The preview worker lets a navigation whose referrer is a Kandelo
             page re-target this frame to another machine (this pane opening
             a new destination); guest pages cannot. */
          referrerPolicy="origin"
          onLoad={() => {
            setLoading(false);
            const served = navigationsSinceLoad.current.find((navigation) =>
              navigation.status !== null && (navigation.status < 300 || navigation.status >= 400));
            navigationsSinceLoad.current = [];
            if (served) {
              // The bridge sees no fragment; keep the one this pane asked for.
              const asked = relativePathFromHref(preview.url, frameUrlRef.current);
              const next = asked && asked.split("#")[0] === served.path ? asked : served.path;
              setPath(next);
              frameUrlRef.current = buildPreviewUrl(preview.url, next);
            }
            const loadedPath = relativePathFromHref(preview.url, frameUrlRef.current);
            const progress = getPreviewProgress(host);
            if (loadedPath && progress) {
              // The bridge reports paths without the fragment the URL bar asked for.
              const requested = progress.requestedPath.split("#")[0] === loadedPath.split("#")[0]
                ? progress.requestedPath
                : loadedPath;
              const state = previewDocumentLoaded(host, requested);
              // Two animation frames allow the newly loaded document a paint
              // opportunity. This is not application-specific hydration readiness.
              if (state) window.requestAnimationFrame(() => window.requestAnimationFrame(() => previewRendered(host, state)));
            }
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
                : preview.status === "error"
                  ? "web-preview-error"
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
        onBlur={() => setDraftPath((value) => /^https?:\/\//i.test(value) ? value : normalizePreviewPath(value, baseUrl))}
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

function samePath(a: string, b: string): boolean {
  return a.split(/[?#]/)[0] === b.split(/[?#]/)[0];
}
