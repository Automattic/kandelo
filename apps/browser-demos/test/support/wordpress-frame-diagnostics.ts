/**
 * Read the real same-origin documents through the outer page when a child's
 * automation execution context is unavailable. Diagnostic only: assertions
 * continue to use the ordinary frame locators and user interactions.
 * Keep this function self-contained so Playwright can serialize it.
 */
export function describeWordPressFrameTree(): unknown[] {
  const snapshots: unknown[] = [];
  const visit = (current: Window, path: number[]) => {
    if (path.length > 3 || snapshots.length >= 12) return;
    try {
      const document = current.document;
      let editorState: unknown;
      try {
        const runtime = current as unknown as {
          wp?: { data?: { select(store: string): {
            isSavingPost?(): boolean;
            isAutosavingPost?(): boolean;
            isEditedPostDirty?(): boolean;
          } | undefined } };
        };
        const editor = runtime.wp?.data?.select("core/editor");
        editorState = {
          saving: editor?.isSavingPost?.(),
          autosaving: editor?.isAutosavingPost?.(),
          dirty: editor?.isEditedPostDirty?.(),
        };
      } catch (error) {
        editorState = { error: String(error) };
      }
      snapshots.push({
        path, url: current.location.href, name: current.name,
        documentUrl: document.URL, baseURI: document.baseURI,
        readyState: document.readyState,
        navigationType: current.performance.navigation?.type,
        htmlPresent: !!document.documentElement,
        frameConnected: current.frameElement?.isConnected,
        welcomePresent: !!document.querySelector('[role="dialog"][aria-label="Welcome to the editor"]'),
        editorState,
        editables: Array.from(document.querySelectorAll('[contenteditable="true"]')).slice(0, 4)
          .map(element => {
            const ancestors: unknown[] = [];
            for (let parent: Element | null = element; parent && ancestors.length < 12; parent = parent.parentElement) {
              ancestors.push({ tag: parent.tagName, hidden: parent.getAttribute("aria-hidden"), inert: parent.hasAttribute("inert") });
            }
            const style = current.getComputedStyle(element);
            return { html: element.outerHTML.slice(0, 2048), connected: element.isConnected,
              display: style.display, visibility: style.visibility, ancestors };
          }),
      });
      for (const [index, iframe] of Array.from(document.querySelectorAll("iframe")).entries()) {
        if (iframe.contentWindow) visit(iframe.contentWindow, [...path, index]);
      }
    } catch (error) {
      snapshots.push({ path, error: String(error) });
    }
  };
  visit(window, []);
  return snapshots;
}
