import type {
  DemoActionConfig,
  DemoActionGroupConfig,
  DemoAssetConfig,
  DemoGuideConfig,
} from "./demo-config";
import { genericDemoPresentation } from "./demo-config";
import type { DemoPresentation } from "./kernel-host";

export const DOOM_COMMAND = "/usr/local/bin/fbdoom -iwad /doom1.wad";
export const DOOM_WAD_URL = "https://distro.ibiblio.org/slitaz/sources/packages/d/doom1.wad";
export const DOOM_WAD_SHA256 = "1d7d43be501e67d927e415e0b8f3e29c3bf33075e859721816f652a526cac771";
export const LOVE_COMMAND = "/usr/local/bin/love /usr/local/share/love/examples";
export const BYTEPATH_COMMAND = "/usr/local/bin/love /usr/local/share/love/examples/bytepath";

const shellScript = `echo "Hello from a Kandelo guided script"
uname -a
echo "---"
printf "cwd: "; pwd
printf "files in /tmp before: "; ls /tmp | wc -l
echo "written by the demo guide" > /tmp/kandelo-guide.txt
cat /tmp/kandelo-guide.txt`;

const nodeScript = `node -e "console.log('node:', process.version)"
node -e "console.log(JSON.stringify(process.versions, null, 2))"
npm --version`;

const nginxScript = `curl -i http://127.0.0.1:8080/ | head -40
echo "--- nginx processes ---"
lsof | grep nginx | head -40 || true`;

const nginxPhpScript = `curl -i http://127.0.0.1:8080/ | head -60
echo "--- service processes ---"
lsof | grep -E 'nginx|php-fpm' | head -60 || true`;

export function builtinDemoGuide(profileId: string): DemoGuideConfig | null {
  switch (profileId) {
    case "shell":
      return shellGuide();
    case "node":
      return nodeGuide();
    case "nginx":
      return nginxGuide();
    case "nginx-php":
      return nginxPhpGuide();
    case "love":
      return loveGuide();
    case "bytepath":
      return bytepathGuide();
    default:
      return null;
  }
}

export function builtinDemoPresentation(profileId: string): DemoPresentation | null {
  switch (profileId) {
    case "shell":
    case "node":
      return genericDemoPresentation("terminal");
    case "nginx":
    case "nginx-php":
    case "wordpress":
    case "wordpress-sqlite":
    case "wordpress-mariadb":
    case "lamp":
      return genericDemoPresentation("web");
    case "doom":
      return {
        ...genericDemoPresentation("framebuffer"),
        autoCommand: DOOM_COMMAND,
      };
    case "love":
      return {
        ...genericDemoPresentation("framebuffer"),
        autoCommand: LOVE_COMMAND,
      };
    case "bytepath":
      return {
        ...genericDemoPresentation("framebuffer"),
        autoCommand: BYTEPATH_COMMAND,
      };
    default:
      return null;
  }
}

export function builtinDemoAssets(profileId: string): DemoAssetConfig[] {
  if (profileId !== "doom") return [];
  return [
    {
      path: "/doom1.wad",
      url: DOOM_WAD_URL,
      sha256: DOOM_WAD_SHA256,
      mode: 0o644,
      devCorsProxy: true,
    },
  ];
}

export function shellGuide(): DemoGuideConfig {
  return scriptGuide(
    "Shell demo",
    "Snippets and scripts are delivered through the same PTY-backed shell the user sees.",
    [
      actionGroup("Snippets", [
        action("hello", "Hello", "Print a short line from bash.", "terminal.run", `echo "hello from Kandelo"`),
        action("pipe", "Pipe", "Run a small pipe through coreutils.", "terminal.run", `printf "alpha\\nbeta\\ngamma\\n" | grep a | wc -l`),
        action("files", "Files", "Write and read a temporary file.", "terminal.run", `echo test > /tmp/f.txt && cat /tmp/f.txt`),
      ]),
      actionGroup("Raw input", [
        action("type-ls", "Type ls", "Send keystrokes into the current terminal.", "terminal.write", "ls /usr/bin | head\n"),
      ]),
    ],
    {
      title: "Batch script",
      language: "sh",
      initialText: shellScript,
    },
    {
      title: "Companion HTML",
      srcDoc: companionHtml("Shell companion", [
        ["hello", "Hello"],
        ["files", "Files"],
        ["type-ls", "Type input"],
      ]),
    },
  );
}

export function nodeGuide(): DemoGuideConfig {
  return scriptGuide(
    "Node.js demo",
    "Buttons can launch commands or feed a currently running REPL without leaving Kandelo.",
    [
      actionGroup("Commands", [
        action("node-version", "Version", "Print the Node-compatible runtime version.", "terminal.run", "node --version"),
        action("process-versions", "Versions", "Inspect process.versions from Node.", "terminal.run", `node -e "console.log(JSON.stringify(process.versions, null, 2))"`),
        action("npm-version", "npm", "Print the bundled npm version.", "terminal.run", "npm --version"),
      ]),
      actionGroup("REPL", [
        action("enter-repl", "Open REPL", "Start an interactive Node REPL in the terminal.", "terminal.run", "node"),
        action("repl-expression", "Send expr", "Send an expression to the current terminal.", "terminal.write", "process.version\n"),
      ]),
    ],
    {
      title: "Node script",
      language: "sh",
      initialText: nodeScript,
    },
    {
      title: "Companion HTML",
      srcDoc: companionHtml("Node companion", [
        ["node-version", "Version"],
        ["process-versions", "process.versions"],
        ["repl-expression", "REPL input"],
      ]),
    },
  );
}

export function nginxGuide(): DemoGuideConfig {
  return scriptGuide(
    "nginx demo",
    "Service demos keep the web preview primary, while actions inspect the same running service from a shell.",
    [
      actionGroup("Service", [
        action("curl-home", "Fetch page", "Fetch the served page from inside the machine.", "terminal.run", "curl -i http://127.0.0.1:8080/ | head -40"),
        action("nginx-procs", "Workers", "Show nginx processes.", "terminal.run", "lsof | grep nginx | head -40 || true"),
        action("nginx-conf", "Config", "Print the top of nginx.conf.", "terminal.run", "sed -n '1,80p' /etc/nginx/nginx.conf"),
      ]),
    ],
    {
      title: "Service check",
      language: "sh",
      initialText: nginxScript,
    },
    {
      title: "Companion HTML",
      srcDoc: companionHtml("nginx companion", [
        ["curl-home", "Fetch"],
        ["nginx-procs", "Workers"],
        ["nginx-conf", "Config"],
      ]),
    },
  );
}

export function nginxPhpGuide(): DemoGuideConfig {
  return scriptGuide(
    "nginx + PHP demo",
    "Run service checks and PHP commands against the live FastCGI stack.",
    [
      actionGroup("Service", [
        action("curl-php", "Fetch PHP", "Fetch the PHP-backed page through nginx.", "terminal.run", "curl -i http://127.0.0.1:8080/ | head -60"),
        action("php-version", "PHP", "Print the PHP-FPM version.", "terminal.run", "/usr/sbin/php-fpm -v"),
        action("php-procs", "Workers", "Show nginx and PHP-FPM processes.", "terminal.run", "lsof | grep -E 'nginx|php-fpm' | head -60 || true"),
      ]),
    ],
    {
      title: "Service check",
      language: "sh",
      initialText: nginxPhpScript,
    },
  );
}

export function loveGuide(): DemoGuideConfig {
  return scriptGuide(
    "LOVE game gallery",
    "The native runtime opens /dev/fb0 and runs bundled Lua game demos.",
    [
      actionGroup("Runtime", [
        action("run-love", "Run", "Start the LOVE game gallery.", "terminal.run", LOVE_COMMAND),
        action("run-bytepath", "BYTEPATH", "Start the bundled BYTEPATH port.", "terminal.run", BYTEPATH_COMMAND),
        action("list-examples", "Games", "List the staged game demo files.", "terminal.run", "find /usr/local/share/love/examples -maxdepth 2 -type f | sort"),
        action("show-runtime", "Binary", "Show the native runtime path.", "terminal.run", "ls -lh /usr/local/bin/love"),
      ]),
    ],
    {
      title: "Launch command",
      language: "sh",
      initialText: LOVE_COMMAND,
    },
  );
}

export function bytepathGuide(): DemoGuideConfig {
  return scriptGuide(
    "BYTEPATH",
    "BYTEPATH runs as a standard Lua 5.1 LOVE app on the native framebuffer runtime.",
    [
      actionGroup("Runtime", [
        action("run-bytepath", "Run", "Start BYTEPATH.", "terminal.run", BYTEPATH_COMMAND),
        action("run-gallery", "Gallery", "Start the smaller LOVE game gallery.", "terminal.run", LOVE_COMMAND),
        action("show-bytepath", "Files", "List the staged BYTEPATH files.", "terminal.run", "find /usr/local/share/love/examples/bytepath -maxdepth 2 -type f | sort | head -80"),
      ]),
    ],
    {
      title: "Launch command",
      language: "sh",
      initialText: BYTEPATH_COMMAND,
    },
  );
}

function action(
  id: string,
  label: string,
  description: string,
  kind: DemoActionConfig["kind"],
  payload: string,
): DemoActionConfig {
  return { id, label, description, kind, payload };
}

function actionGroup(
  title: string,
  actions: DemoActionConfig[],
): DemoActionGroupConfig {
  return { title, actions };
}

function scriptGuide(
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

function companionHtml(
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
