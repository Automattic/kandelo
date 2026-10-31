import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { KandeloImageFs } from "../lib/kandelo-image-fs";
import { ensureDirRecursive, writeVfsFile } from "./vfs-image-helpers";
import { resolveVfsArtifact, saveShellDerivedVfsImage } from "./package-shell-vfs-build";
import { copyImageTree, installServiceActivities } from "./service-activities";
import { writeTrackedDemoConfig } from "./tracked-demo-config";
import { installImageSessions } from "./image-session-files";
import { parseComputerServices } from "../../../web-libs/kandelo-session/src/computer-services";
import { renderWordPressConfig, wordpressConfigTemplate } from "../../../apps/browser-demos/lib/init/wordpress-runtime-config";

function load(packageName: string, file: string): KandeloImageFs {
  const fs = KandeloImageFs.create();
  fs.loadImage(new Uint8Array(readFileSync(resolveVfsArtifact(`programs/${file}`, packageName))));
  return fs;
}

function rewrite(fs: KandeloImageFs, path: string, replacements: readonly (readonly [string, string])[]): void {
  let text = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFile(path));
  for (const [before, after] of replacements) {
    if (!text.includes(before)) throw new Error(`${path} is missing expected composition input ${before}`);
    text = text.replaceAll(before, after);
  }
  writeVfsFile(fs, path, text);
}

function cloneFile(fs: KandeloImageFs, from: string, to: string): void {
  fs.writeFile(to, fs.readFile(from), fs.stat(from).mode & 0o7777);
}

function serviceDeclarations(packageName: string) {
  return parseComputerServices(readFileSync(resolve(`packages/registry/${packageName}/services.json`), "utf8"))
    .map(service => ({ ...service, target: service.id }));
}

export async function buildWebStackImage(output: string): Promise<void> {
  const fs = load("nginx-php-vfs", "nginx-php-vfs.vfs.zst");
  cloneFile(fs, "/etc/nginx/nginx.conf", "/etc/nginx/php.conf");
  cloneFile(fs, "/etc/dinit.d/nginx", "/etc/dinit.d/web-php");
  rewrite(fs, "/etc/dinit.d/web-php", [["/etc/nginx/nginx.conf", "/etc/nginx/php.conf"]]);
  {
    const source = load("nginx-vfs", "nginx-vfs.vfs.zst");
    copyImageTree(source, fs, "/var/www/html", "/var/www/static");
    copyImageTree(source, fs, "/etc/nginx/nginx.conf", "/etc/nginx/static.conf");
    rewrite(fs, "/etc/nginx/static.conf", [["/var/www/html", "/var/www/static"]]);
    writeVfsFile(fs, "/etc/dinit.d/web-static", "type = process\ncommand = /usr/sbin/nginx -c /etc/nginx/static.conf\nlogfile = /var/log/nginx-static.log\nrestart = false\n");
  }
  {
    const source = load("nginx-python-vfs", "nginx-python-vfs.vfs.zst");
    for (const path of ["/usr/bin/python3", "/usr/lib/python3.13", "/usr/share/licenses/cpython", "/var/www/notes", "/var/lib/notes", "/etc/dinit.d/notes-app", "/etc/dinit.d/env-python"]) copyImageTree(source, fs, path);
    copyImageTree(source, fs, "/etc/nginx/nginx.conf", "/etc/nginx/python.conf");
    copyImageTree(source, fs, "/etc/dinit.d/nginx", "/etc/dinit.d/web-python");
    rewrite(fs, "/etc/dinit.d/web-python", [["/etc/nginx/nginx.conf", "/etc/nginx/python.conf"]]);
  }
  {
    const source = load("ruby-todo-vfs", "ruby-todo-vfs.vfs.zst");
    copyImageTree(source, fs, "/usr");
    copyImageTree(source, fs, "/var/lib/todo");
    writeVfsFile(fs, "/etc/dinit.d/web-ruby", "type = process\ncommand = /usr/bin/ruby /var/lib/todo/server.rb\nworking-dir = /var/lib/todo\nrun-as = maker\nenv-file = /etc/dinit.d/env\nlogfile = /var/log/ruby-todo.log\nrestart = false\n");
    fs.chown("/var/lib/todo", 1000, 1000);
  }
  {
    const source = load("redis-vfs", "redis-vfs.vfs.zst");
    for (const path of ["/var/www/redis-board", "/usr/lib/php/phar.so", "/usr/share/licenses/phpcacheadmin", "/usr/local/bin/redis-server", "/usr/local/bin/redis-cli", "/etc/dinit.d/redis"]) copyImageTree(source, fs, path);
    copyImageTree(source, fs, "/etc/dinit.d/redis-board", "/etc/dinit.d/web-redis");
    rewrite(fs, "/etc/dinit.d/web-redis", [["/usr/local/bin/php", "/usr/bin/php"]]);
    rewrite(fs, "/etc/dinit.d/redis", [['--save "" --appendonly no', '--save "" --appendonly yes'], ["--dir /data", "--dir /var/lib/redis"]]);
    ensureDirRecursive(fs, "/var/lib/redis");
  }
  fs.unlink("/etc/dinit.d/nginx");
  fs.unlink("/usr/share/kandelo/sessions/nginx-php-vfs.json");
  installImageSessions(fs, "web-stack-vfs");
  installServiceActivities(fs, serviceDeclarations("web-stack-vfs"), new Uint8Array(readFileSync(resolveVfsArtifact("programs/service-activity-control.wasm", "service-activity-tools"))));
  writeTrackedDemoConfig(fs, "packages/registry/web-stack-vfs/demo.json");
  await saveShellDerivedVfsImage(fs, output);
}

export async function buildWordPressFamilyImage(output: string): Promise<void> {
  const fs = load("lamp", "lamp.vfs.zst");
  const sqlite = load("wordpress", "wordpress.vfs.zst");
  copyImageTree(sqlite, fs, "/var/www/html/wp-content/plugins/sqlite-database-integration");
  ensureDirRecursive(fs, "/etc/wordpress");
  copyImageTree(sqlite, fs, "/var/www/html/wp-content/db.php", "/etc/wordpress/sqlite-db.php");
  rewrite(fs, "/etc/wordpress/sqlite-db.php", [["{SQLITE_IMPLEMENTATION_FOLDER_PATH}", "/var/www/html/wp-content/plugins/sqlite-database-integration"]]);
  for (const backend of ["sqlite", "mariadb"]) {
    const content = `/var/lib/wordpress-sites/${backend}/wp-content`;
    ensureDirRecursive(fs, content);
    fs.chown(content, 65534, 65534);
    for (const directory of ["plugins", "themes", "mu-plugins"]) fs.symlink(`/var/www/html/wp-content/${directory}`, `${content}/${directory}`);
    ensureDirRecursive(fs, `${content}/uploads`);
    fs.chown(`${content}/uploads`, 65534, 65534);
    fs.chmod(`${content}/uploads`, 0o775);
  }
  copyImageTree(sqlite, fs, "/var/www/html/wp-content/database", "/var/lib/wordpress-sites/sqlite/wp-content/database");
  fs.symlink("/etc/wordpress/sqlite-db.php", "/var/lib/wordpress-sites/sqlite/wp-content/db.php");
  writeVfsFile(fs, "/etc/kandelo/wordpress-backends", "sqlite\nmariadb\n");
  writeVfsFile(fs, "/etc/wp-config-template.php", wordpressConfigTemplate("selectable"));
  writeVfsFile(fs, "/var/www/html/wp-config.php", renderWordPressConfig("selectable", "/app", "http"));
  writeVfsFile(fs, "/usr/local/bin/kandelo-wordpress-select", `#!/bin/sh
set -eu
backend=\${1:-}
case "$backend" in sqlite|mariadb) ;; *) echo 'Unknown WordPress database backend' >&2; exit 2 ;; esac
if [ -f /etc/kandelo/wordpress-backend ]; then
  echo 'This computer uses the single-site layout; it cannot switch database backends without an explicit migration.' >&2
  exit 1
fi
[ -d "/var/lib/wordpress-sites/$backend/wp-content" ]
[ -f "/etc/nginx/wordpress-$backend.conf" ]
`, 0o755);
  rewrite(fs, "/var/www/fpm-router.php", [[
    "$uri = urldecode(parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH));",
    `$uri = $_SERVER['DOCUMENT_URI'] ?? '';
if ($uri === '' || $uri[0] !== '/' || strpos($uri, chr(0)) !== false || strpos($uri, chr(92)) !== false || preg_match('#(?:^|/)\\.{1,2}(?:/|$)#', $uri)) {
    http_response_code(400);
    exit;
}`,
  ], [
    "$file = $docRoot . $uri;",
    `$file = $docRoot . $uri;
if (strpos($uri, '/wp-content/') === 0) {
    $backend = $_SERVER['KANDELO_WORDPRESS_BACKEND'] ?? '';
    if (!in_array($backend, array('sqlite', 'mariadb'), true)) {
        throw new RuntimeException('Unknown WordPress site backend.');
    }
    if ($uri === '/wp-content/db.php' || $uri === '/wp-content/database' || strpos($uri, '/wp-content/database/') === 0) {
        http_response_code(404);
        exit;
    }
    $file = '/var/lib/wordpress-sites/' . $backend . $uri;
    if ($uri === '/wp-content/uploads' || strpos($uri, '/wp-content/uploads/') === 0) {
        $uploads = '/var/lib/wordpress-sites/' . $backend . '/wp-content/uploads/';
        $resolved = realpath($file);
        if (!$resolved || strpos($resolved, $uploads) !== 0 || !is_file($resolved) || preg_match('/\\.(php[0-9]*|phtml|phar)(?:$|\\/)/i', $resolved)) {
            http_response_code(404);
            exit;
        }
        $types = array('png' => 'image/png', 'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'gif' => 'image/gif', 'webp' => 'image/webp', 'avif' => 'image/avif', 'svg' => 'image/svg+xml', 'pdf' => 'application/pdf', 'zip' => 'application/zip', 'mp4' => 'video/mp4', 'mp3' => 'audio/mpeg', 'txt' => 'text/plain');
        header('Content-Type: ' . ($types[strtolower(pathinfo($resolved, PATHINFO_EXTENSION))] ?? 'application/octet-stream'));
        header('X-Content-Type-Options: nosniff');
        header('Content-Length: ' . filesize($resolved));
        readfile($resolved);
        exit;
    }
}`,
  ]]);
  cloneFile(fs, "/var/www/fpm-router.php", "/var/www/wordpress-family-router.php");
  fs.unlink("/var/www/fpm-router.php");
  const baseNginx = new TextDecoder().decode(fs.readFile("/etc/nginx/nginx.conf"));
  const fpm = baseNginx.match(/location @fpm \{([\s\S]*?)\n        \}/);
  if (!fpm || !baseNginx.includes("location /wp-content/ {\n            try_files $uri @fpm;\n        }")) throw new Error("WordPress content routing template is missing");
  for (const backend of ["sqlite", "mariadb"]) {
    const config = baseNginx.replace("location /wp-content/ {\n            try_files $uri @fpm;\n        }", `location /wp-content/ {${fpm[1]}
        }`).replaceAll("/var/www/fpm-router.php", "/var/www/wordpress-family-router.php").replaceAll("fastcgi_param REQUEST_URI $request_uri;", `fastcgi_param REQUEST_URI $request_uri;\n            fastcgi_param KANDELO_WORDPRESS_BACKEND ${backend};`);
    writeVfsFile(fs, `/etc/nginx/wordpress-${backend}.conf`, config);
  }
  const blacklist = new TextDecoder().decode(fs.readFile("/etc/php-opcache-blacklist.txt"));
  writeVfsFile(fs, "/etc/php-opcache-blacklist.txt", `${blacklist}\n/var/www/html/wp-config.php\n/var/www/wordpress-family-router.php\n`);
  rewrite(fs, "/etc/dinit.d/php-fpm", [["depends-on = mariadb-ready\n", ""]]);
  const nginx = new TextDecoder().decode(fs.readFile("/etc/dinit.d/nginx"));
  for (const backend of ["sqlite", "mariadb"]) {
    writeVfsFile(fs, `/etc/dinit.d/wordpress-${backend}`, nginx.replaceAll("/etc/nginx/nginx.conf", `/etc/nginx/wordpress-${backend}.conf`) + (backend === "mariadb" ? "depends-on = mariadb-ready\n" : ""));
  }
  fs.unlink("/etc/dinit.d/nginx");
  fs.unlink("/usr/share/kandelo/sessions/lamp.json");
  installImageSessions(fs, "wordpress-family-vfs");
  installServiceActivities(fs, serviceDeclarations("wordpress-family-vfs"), new Uint8Array(readFileSync(resolveVfsArtifact("programs/service-activity-control.wasm", "service-activity-tools"))), 'backend=${target#wordpress-}; /usr/local/bin/kandelo-wordpress-select "$backend"');
  writeTrackedDemoConfig(fs, "packages/registry/wordpress-family-vfs/demo.json");
  await saveShellDerivedVfsImage(fs, output);
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invoked) {
  const family = process.argv[2];
  const output = process.argv[3];
  if (!output || !["web-stack", "wordpress-family"].includes(family)) throw new Error("Usage: build-image-families.ts web-stack|wordpress-family output");
  await (family === "web-stack" ? buildWebStackImage(output) : buildWordPressFamilyImage(output));
}
