import type { DemoGuideConfig } from "../../../web-libs/kandelo-session/src/demo-config";
import {
  action,
  actionGroup,
  companionHtml,
  scriptGuide,
} from "./kandelo-demo-config";

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
