import type { VfsImageFilesystem } from "../../../host/src/vfs/vfs-image-filesystem";
import {
  KANDELO_DEMO_CONFIG_PATH,
  genericDemoPresentation,
  type DemoActionConfig,
  type DemoActionGroupConfig,
  type DemoGuideConfig,
  type DemoPresentationConfig,
  type KandeloDemoConfig,
} from "../../../web-libs/kandelo-session/src/demo-config";
import {
  ensureDirRecursive,
  writeVfsFile,
} from "./vfs-image-helpers";

/**
 * The terminal presentation, from the one place that defines presentations.
 *
 * `genericDemoPresentation("terminal")` in the session library returns this
 * object field for field. It was written out again here, and a policy written
 * twice is a policy that can disagree with itself -- which the web one below
 * does. Calling the library keeps the builders' surface (the name every
 * `build-*-vfs-image.ts` imports) while leaving one definition of what a
 * terminal demo looks like.
 */
export function terminalPresentation(): DemoPresentationConfig {
  return genericDemoPresentation("terminal");
}

/**
 * The web presentation, from the one place that defines presentations.
 *
 * This used to write the object out again, ordering the running surfaces
 * `["web", "syslog", "terminal"]` while `genericDemoPresentation("web")` put
 * terminal second. The maintainer settled it 2026-09-17: the image builders'
 * order is right and the library's was wrong, so the library now carries this
 * order and there is one definition of it.
 *
 * The divergence mattered, and `demo-guides.ts` is why. Its
 * `builtinDemoPresentation` maps nginx, nginx-php, wordpress,
 * wordpress-sqlite, wordpress-mariadb and lamp to the library's web case --
 * the SAME six demos these builders write `/etc/kandelo/demo.json` for. So a
 * viewer saw one surface order when the image supplied the presentation and a
 * different one when the built-in fallback did.
 */
export function webPresentation(): DemoPresentationConfig {
  return genericDemoPresentation("web");
}

export function action(
  id: string,
  label: string,
  description: string,
  kind: DemoActionConfig["kind"],
  payload: string,
): DemoActionConfig {
  return { id, label, description, kind, payload };
}

export function actionGroup(
  title: string,
  actions: DemoActionConfig[],
): DemoActionGroupConfig {
  return { title, actions };
}

export function scriptGuide(
  title: string,
  summary: string,
  groups: DemoActionGroupConfig[],
  script: { title: string; language: string; initialText: string },
  companion?: DemoGuideConfig["companion"],
): DemoGuideConfig {
  return {
    title,
    summary,
    groups,
    script,
    ...(companion ? { companion } : {}),
  };
}

export function companionHtml(
  title: string,
  actions: Array<[id: string, label: string]>,
): string {
  const buttons = actions.map(([id, label]) =>
    `<button type="button" data-action="${escapeAttr(id)}">${escapeHtml(label)}</button>`,
  ).join("");
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0;
      padding: 12px;
      background: #191512;
      color: #f3d6b3;
      font: 12px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 12px;
      font-weight: 650;
      letter-spacing: 0;
      color: #fff2df;
    }
    p {
      margin: 0 0 10px;
      color: #b99d7d;
      line-height: 1.4;
    }
    .row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    button {
      border: 1px solid rgba(255, 169, 86, 0.28);
      background: rgba(255, 169, 86, 0.12);
      color: #ffe0b9;
      border-radius: 6px;
      padding: 7px 9px;
      font: inherit;
      cursor: pointer;
    }
    button:hover { background: rgba(255, 169, 86, 0.2); }
    #status {
      min-height: 16px;
      margin-top: 10px;
      color: #d2b08b;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11px;
    }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <p>This frame has no kernel access. It can only request parent-approved action ids.</p>
  <div class="row">${buttons}</div>
  <div id="status"></div>
  <script>
    const status = document.getElementById("status");
    document.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      const actionId = button.getAttribute("data-action");
      parent.postMessage({ type: "kandelo.demoAction", actionId }, "*");
      status.textContent = "sent " + actionId;
    });
  </script>
</body>
</html>`;
}

export function writeKandeloDemoConfig(
  fs: VfsImageFilesystem,
  config: KandeloDemoConfig,
): void {
  ensureDirRecursive(fs, "/etc/kandelo");
  writeVfsFile(
    fs,
    KANDELO_DEMO_CONFIG_PATH,
    `${JSON.stringify(config, null, 2)}\n`,
    0o644,
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]!));
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/`/g, "&#96;");
}
