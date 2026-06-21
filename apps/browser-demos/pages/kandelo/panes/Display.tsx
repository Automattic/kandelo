import * as React from "react";
import { useWebPreview } from "../kernel-host/react";
import { PaneHead } from "./PaneHead";
import { Framebuffer, type FramebufferProps } from "./Framebuffer";
import { Modeset } from "./Modeset";
import type { PrimarySurface } from "../../../../../web-libs/kandelo-session/src/kernel-host";

const ICON = (
  <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.4">
    <rect x="1.5" y="2" width="10" height="7.5" rx="1" />
    <path d="M4 11h5M6.5 9.5v1.5" />
  </svg>
);

export interface WordPressLoginOptions {
  username: string;
  password: string;
  loginPath?: string;
  adminPath?: string;
}

export interface DisplayHandle {
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
}

export const Display = React.forwardRef<DisplayHandle, DisplayProps>(({ surface, ...props }, ref) => {
  const preview = useWebPreview();
  if (surface === "kms") return <Modeset {...props} />;
  if (surface === "framebuffer") return <Framebuffer {...props} />;
  if (surface === "web" && preview) return <WebPreviewPane ref={ref} preview={preview} {...props} />;
  if (!preview) return <Framebuffer {...props} />;
  return <WebPreviewPane ref={ref} preview={preview} {...props} />;
});

Display.displayName = "Display";

const WebPreviewPane = React.forwardRef<DisplayHandle, FramebufferProps & {
  preview: NonNullable<ReturnType<typeof useWebPreview>>;
}>(({ preview, dragProps, onCollapse, onMaximize, isMax, autoFocus = false }, ref) => {
  const [path, setPath] = React.useState("/");
  const [draftPath, setDraftPath] = React.useState("/");
  const [iframeSrc, setIframeSrc] = React.useState(() => buildPreviewUrl(preview.url, "/"));
  const ready = preview.status === "running";
  const pendingRequests = preview.pendingRequests ?? 0;
  const hasPendingRequests = ready && pendingRequests > 0;
  const iframeRef = React.useRef<HTMLIFrameElement | null>(null);

  React.useEffect(() => {
    setPath("/");
    setDraftPath("/");
    setIframeSrc(buildPreviewUrl(preview.url, "/"));
  }, [preview.url]);

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
    const frame = iframeRef.current;
    if (frame?.contentWindow) {
      try {
        frame.contentWindow.location.assign(target);
        return;
      } catch {
        // Fall back to updating src for unusual cross-origin or detached cases.
      }
    }
    setIframeSrc(target);
  }, []);

  const navigate = React.useCallback((raw: string) => {
    const next = normalizePreviewPath(raw, preview.url);
    setPath(next);
    setDraftPath(next);
    navigateFrame(buildPreviewUrl(preview.url, next));
  }, [navigateFrame, preview.url]);

  const navigateAndWait = React.useCallback(async (
    raw: string,
    predicate: (document: Document) => boolean,
    timeoutMs = 120_000,
  ) => {
    const next = normalizePreviewPath(raw, preview.url);
    setPath(next);
    setDraftPath(next);
    navigateFrame(buildPreviewUrl(preview.url, next));
    await waitForFrameDocument(iframeRef, predicate, timeoutMs);
  }, [navigateFrame, preview.url]);

  const reloadPreview = React.useCallback(() => {
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
  }, [navigateFrame, path, preview.url]);

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

  React.useImperativeHandle(ref, () => ({
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
  }), [navigateAndWait, ready]);

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
            onClick={reloadPreview}
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
              <RequestIndicator
                active={hasPendingRequests}
                pendingRequests={pendingRequests}
              />
            </form>
            <iframe
              ref={iframeRef}
              src={iframeSrc}
              title={preview.label}
              onLoad={() => {
                syncFromFrame();
                if (autoFocus) iframeRef.current?.focus();
              }}
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
});

WebPreviewPane.displayName = "WebPreviewPane";

const RequestIndicator: React.FC<{
  active: boolean;
  pendingRequests: number;
}> = ({ active, pendingRequests }) => (
  <span
    className={`kweb-request-indicator${active ? " active" : ""}`}
    role={active ? "status" : undefined}
    aria-hidden={!active}
    aria-label={active
      ? `${pendingRequests} pending preview ${pendingRequests === 1 ? "request" : "requests"}`
      : undefined}
    title={active
      ? `${pendingRequests} pending ${pendingRequests === 1 ? "request" : "requests"}`
      : undefined}
  >
    <span className="kweb-request-spinner" />
  </span>
);

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

function frameDocument(ref: React.RefObject<HTMLIFrameElement>): Document | null {
  try {
    return ref.current?.contentDocument ?? ref.current?.contentWindow?.document ?? null;
  } catch {
    return null;
  }
}

async function waitForFrameDocument(
  ref: React.RefObject<HTMLIFrameElement>,
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
