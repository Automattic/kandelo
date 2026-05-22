import type { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  KANDELO_DEMO_CONFIG_PATH,
  type DemoActionConfig,
  type DemoActionGroupConfig,
  type DemoAssetConfig,
  type DemoGuideConfig,
  type DemoPresentationConfig,
  type KandeloDemoConfig,
} from "../../../web-libs/kandelo-session/src/demo-config";
import {
  ensureDirRecursive,
  writeVfsFile,
} from "./vfs-image-helpers";

export function terminalPresentation(): DemoPresentationConfig {
  return {
    bootPrimary: "syslog",
    runningPrimary: ["terminal", "syslog"],
    terminalAccess: "primary",
    internalsAccess: "drawer",
  };
}

export function webPresentation(): DemoPresentationConfig {
  return {
    bootPrimary: "syslog",
    runningPrimary: ["web", "terminal", "syslog"],
    terminalAccess: "drawer",
    internalsAccess: "drawer",
  };
}

export function framebufferPresentation(autoCommand?: string): DemoPresentationConfig {
  return {
    bootPrimary: "syslog",
    runningPrimary: ["framebuffer", "terminal", "syslog"],
    terminalAccess: "drawer",
    internalsAccess: "drawer",
    ...(autoCommand ? { autoCommand } : {}),
  };
}

export function externalAsset(config: DemoAssetConfig): DemoAssetConfig {
  return config;
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
  fs: MemoryFileSystem,
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
