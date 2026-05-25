/**
 * Build a WordPress development VFS image for the Kandelo gallery.
 *
 * The image contains:
 *   - a build-time shallow clone of WordPress/wordpress-develop at
 *     /work/wordpress-develop
 *   - nginx + PHP-FPM serving /work/wordpress-develop/src
 *   - MariaDB with wordpress and wordpress_tests databases
 *   - PHP CLI, phpunit, Node, npm, and npx available from the shell
 *
 * Produces: apps/browser-demos/public/wordpress-dev.vfs.zst
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import { resolveBinary, findRepoRoot } from "../../../host/src/binary-resolver";
import {
  writeVfsFile,
  writeVfsBinary,
  ensureDirRecursive,
  walkAndWrite,
  saveImage,
  symlink,
} from "./vfs-image-helpers";
import { addDinitInit, type DinitService } from "./dinit-image-helpers";
import { ensureSourceExtract } from "./source-extract-helper";
import { populateShellEnvironment } from "./shell-vfs-build";
import {
  webPresentation,
  writeKandeloDemoConfig,
} from "./kandelo-demo-config";

const REPO_ROOT = findRepoRoot();
const BROWSER_DIR = join(REPO_ROOT, "apps", "browser-demos");
const NPM_DIST = join(REPO_ROOT, "packages", "registry", "npm", "dist");
const OUT_FILE = join(BROWSER_DIR, "public", "wordpress-dev.vfs.zst");

const WORDPRESS_DEVELOP_REPO = "https://github.com/WordPress/wordpress-develop.git";
const WORDPRESS_DEVELOP_BRANCH = "trunk";
const WORDPRESS_DEV_INITIAL_FS_BYTES = 512 * 1024 * 1024;
const WORDPRESS_DEV_MAX_FS_BYTES = 3 * 1024 * 1024 * 1024;
const PHPUNIT_VERSION = "9.6.22";
const PHPUNIT_URL = `https://phar.phpunit.de/phpunit-${PHPUNIT_VERSION}.phar`;
const PHPUNIT_SHA256 = "9618d52015c9b06b4979a8e481ca9567be6be20e711e98926c61378a400e1f2e";
const PHPUNIT_POLYFILLS_REPO = "https://github.com/Yoast/PHPUnit-Polyfills.git";
const PHPUNIT_POLYFILLS_TAG = "1.1.5";
const GRUNT_RUNNER_PATH = "/usr/local/lib/kandelo/grunt-cli-runner.js";

const WP_DEV_DIR = ensureWordPressDevelopClone();
ensureWordPressNpmDependencies(WP_DEV_DIR);
ensureWordPressBuiltAssets(WP_DEV_DIR);
const PHPUNIT_PHAR = ensureDownloadedFile({
  url: PHPUNIT_URL,
  sha256: PHPUNIT_SHA256,
  cacheKey: `phpunit-${PHPUNIT_VERSION}`,
});
const PHPUNIT_POLYFILLS_DIR = ensureGitClone({
  repo: PHPUNIT_POLYFILLS_REPO,
  ref: PHPUNIT_POLYFILLS_TAG,
  cacheKey: `phpunit-polyfills-${PHPUNIT_POLYFILLS_TAG}`,
});
const MARIADB_SOURCE = ensureSourceExtract("mariadb", REPO_ROOT);

const NGINX_PATH = resolveBinary("programs/nginx.wasm");
const PHP_PATH = resolveBinary("programs/php/php.wasm");
const PHP_FPM_PATH = resolveBinary("programs/php/php-fpm.wasm");
const NODE_PATH = resolveBinary("programs/node.wasm");
const MARIADB_PATH = resolveBinary("programs/mariadb/mariadbd.wasm");
const OPCACHE_SO_PATH = resolveBinary("programs/php/opcache.so");
const SYSTEM_TABLES_PATH = join(MARIADB_SOURCE, "scripts/mysql_system_tables.sql");
const SYSTEM_DATA_PATH = join(MARIADB_SOURCE, "scripts/mysql_system_tables_data.sql");

interface DownloadedFileOptions {
  url: string;
  sha256: string;
  cacheKey: string;
}

interface GitCloneOptions {
  repo: string;
  ref: string;
  cacheKey: string;
}

function cacheRoot(): string {
  return process.env.XDG_CACHE_HOME
    ? join(process.env.XDG_CACHE_HOME, "wasm-posix-kernel")
    : join(homedir(), ".cache", "wasm-posix-kernel");
}

function sha256OfFile(path: string): string {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

function ensureDownloadedFile(opts: DownloadedFileOptions): string {
  const dir = join(cacheRoot(), "vfs-build-sources", "_downloads");
  mkdirSync(dir, { recursive: true });
  const ext = opts.url.split("/").pop() ?? opts.cacheKey;
  const path = join(dir, ext);

  if (existsSync(path) && sha256OfFile(path) === opts.sha256) {
    return path;
  }

  console.log(`==> Downloading ${opts.url}`);
  const partial = `${path}.partial`;
  rmSync(partial, { force: true });
  execFileSync("curl", ["-fsSL", "-o", partial, opts.url], { stdio: "inherit" });
  const got = sha256OfFile(partial);
  if (got !== opts.sha256) {
    rmSync(partial, { force: true });
    throw new Error(`sha256 mismatch for ${opts.url}: expected ${opts.sha256}, got ${got}`);
  }
  renameSync(partial, path);
  return path;
}

function ensureGitClone(opts: GitCloneOptions): string {
  const dir = join(cacheRoot(), "vfs-build-sources", opts.cacheKey);
  if (!existsSync(join(dir, ".git"))) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dirname(dir), { recursive: true });
    console.log(`==> Shallow cloning ${opts.repo}#${opts.ref}`);
    execFileSync("git", [
      "clone",
      "--depth=1",
      "--branch",
      opts.ref,
      opts.repo,
      dir,
    ], { stdio: "inherit" });
  } else {
    console.log(`==> Updating shallow clone ${dir}`);
    execFileSync("git", ["-C", dir, "fetch", "--depth=1", "origin", opts.ref], { stdio: "inherit" });
    execFileSync("git", ["-C", dir, "checkout", "--detach", "FETCH_HEAD"], { stdio: "inherit" });
    execFileSync("git", ["-C", dir, "clean", "-ffdx"], { stdio: "inherit" });
  }
  return dir;
}

function ensureWordPressDevelopClone(): string {
  return ensureGitClone({
    repo: WORDPRESS_DEVELOP_REPO,
    ref: WORDPRESS_DEVELOP_BRANCH,
    cacheKey: "wordpress-develop-trunk",
  });
}

function ensureWordPressNpmDependencies(dir: string): void {
  if (existsSync(join(dir, "node_modules", ".package-lock.json"))) {
    return;
  }

  console.log("==> Installing WordPress npm dependencies for the VFS image");
  execFileSync("npm", [
    "ci",
    "--ignore-scripts",
    "--omit=optional",
    "--no-audit",
    "--no-fund",
  ], {
    cwd: dir,
    stdio: "inherit",
    env: {
      ...process.env,
      npm_config_progress: "false",
      npm_config_fund: "false",
      npm_config_audit: "false",
      npm_config_omit: "optional",
    },
  });
}

function ensureWordPressBuiltAssets(dir: string): void {
  const jqueryPath = join(dir, "src", "wp-includes", "js", "jquery", "jquery.js");
  const buildDir = join(dir, "src", "wp-includes", "build");
  if (existsSync(jqueryPath) && existsSync(buildDir)) {
    return;
  }

  console.log("==> Building WordPress development assets for the VFS image");
  execFileSync("npm", ["run", "build:dev"], {
    cwd: dir,
    stdio: "inherit",
    env: {
      ...process.env,
      npm_config_progress: "false",
      npm_config_fund: "false",
      npm_config_audit: "false",
    },
  });
}

function ensureNpmDist(): void {
  if (existsSync(join(NPM_DIST, "bin", "npm-cli.js"))) return;
  execFileSync("bash", [join(REPO_ROOT, "packages", "registry", "npm", "fetch-npm.sh")], {
    stdio: "inherit",
  });
}

function populateMariadbDataDirs(fs: MemoryFileSystem): void {
  for (const dir of ["/data", "/data/mysql", "/data/tmp"]) {
    ensureDirRecursive(fs, dir);
  }
}

function populateMariadb(fs: MemoryFileSystem): void {
  writeVfsBinary(fs, "/usr/sbin/mariadbd", new Uint8Array(readFileSync(MARIADB_PATH)));
  ensureDirRecursive(fs, "/etc/mariadb");
  const systemTablesSql = readFileSync(SYSTEM_TABLES_PATH, "utf-8");
  const systemDataSql = readFileSync(SYSTEM_DATA_PATH, "utf-8");
  const bootstrapSql = [
    "use mysql;",
    systemTablesSql,
    systemDataSql,
    "CREATE DATABASE IF NOT EXISTS wordpress_tests;",
    "CREATE DATABASE IF NOT EXISTS wordpress;",
    "",
  ].join("\n");
  writeVfsFile(fs, "/etc/mariadb/bootstrap.sql", bootstrapSql);
  writeVfsFile(
    fs,
    "/etc/mariadb/init.sql",
    "CREATE DATABASE IF NOT EXISTS wordpress;\nCREATE DATABASE IF NOT EXISTS wordpress_tests;\n",
  );
}

function populateNginxConfig(fs: MemoryFileSystem): void {
  for (const dir of [
    "/etc/nginx",
    "/var/log/nginx",
    "/tmp/nginx_client_temp",
    "/tmp/nginx_fastcgi_temp",
  ]) ensureDirRecursive(fs, dir);
  writeVfsBinary(fs, "/usr/sbin/nginx", new Uint8Array(readFileSync(NGINX_PATH)));

  const fastcgiParams = `fastcgi_pass 127.0.0.1:9000;
            fastcgi_param SCRIPT_FILENAME /var/www/fpm-router.php;
            fastcgi_param DOCUMENT_ROOT $document_root;
            fastcgi_param DOCUMENT_URI $document_uri;
            fastcgi_param QUERY_STRING $query_string;
            fastcgi_param REQUEST_METHOD $request_method;
            fastcgi_param CONTENT_TYPE $content_type;
            fastcgi_param CONTENT_LENGTH $content_length;
            fastcgi_param REQUEST_URI $request_uri;
            fastcgi_param SERVER_PROTOCOL $server_protocol;
            fastcgi_param SERVER_PORT $server_port;
            fastcgi_param SERVER_NAME $server_name;
            fastcgi_param HTTP_HOST $http_host;
            fastcgi_param REDIRECT_STATUS 200;`;

  const nginxConf = `user root;
daemon off;
master_process off;
worker_processes 1;
error_log stderr info;
pid /tmp/nginx.pid;

events {
    worker_connections 64;
    use poll;
}

http {
    client_body_temp_path /tmp/nginx_client_temp;
    fastcgi_temp_path     /tmp/nginx_fastcgi_temp;

    types {
        text/html  html htm;
        text/css   css;
        text/javascript js;
        application/json json;
        image/png  png;
        image/svg+xml svg;
    }
    default_type application/octet-stream;

    fastcgi_read_timeout 600;
    fastcgi_send_timeout 600;

    server {
        listen 8080;
        server_name localhost;
        root /work/wordpress-develop/src;
        index index.php index.html;

        location /wp-includes/css/ { }
        location /wp-includes/js/ { }
        location /wp-includes/fonts/ { }
        location /wp-includes/images/ { }
        location /wp-admin/css/ { }
        location /wp-admin/js/ { }
        location /wp-admin/images/ { }
        location /wp-content/ {
            try_files $uri @fpm;
        }
        location @fpm {
            ${fastcgiParams}
        }
        location / {
            ${fastcgiParams}
        }
    }
}
`;
  writeVfsFile(fs, "/etc/nginx/nginx.conf", nginxConf);
}

function populatePhp(fs: MemoryFileSystem): void {
  writeVfsBinary(fs, "/usr/bin/php", new Uint8Array(readFileSync(PHP_PATH)));
  writeVfsBinary(fs, "/usr/sbin/php-fpm", new Uint8Array(readFileSync(PHP_FPM_PATH)));
  ensureDirRecursive(fs, "/usr/lib/php/extensions");
  writeVfsBinary(fs, "/usr/lib/php/extensions/opcache.so", new Uint8Array(readFileSync(OPCACHE_SO_PATH)));

  const phpIni = `; opcache disabled in the development image until forked-child dlopen replay is fixed.
;zend_extension=/usr/lib/php/extensions/opcache.so

[opcache]
opcache.enable=0
opcache.enable_cli=0
`;
  writeVfsFile(fs, "/etc/php.ini", phpIni);

  const phpFpmConf = `[global]
daemonize = no
error_log = /dev/stderr
log_level = notice

[www]
user = nobody
group = nobody
listen = 127.0.0.1:9000
pm = static
pm.max_children = 2
clear_env = no
slowlog = /dev/null
request_slowlog_trace_depth = 0
`;
  writeVfsFile(fs, "/etc/php-fpm.conf", phpFpmConf);

  const fpmRouter = `<?php
$uri = urldecode(parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH));
$docRoot = $_SERVER['DOCUMENT_ROOT'];
$file = $docRoot . $uri;

$staticTypes = [
    'css' => 'text/css', 'js' => 'text/javascript', 'json' => 'application/json',
    'png' => 'image/png', 'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg',
    'gif' => 'image/gif', 'svg' => 'image/svg+xml', 'ico' => 'image/x-icon',
    'woff' => 'font/woff', 'woff2' => 'font/woff2', 'ttf' => 'font/ttf',
    'map' => 'application/json', 'xml' => 'application/xml', 'txt' => 'text/plain',
];

if (is_dir($file)) {
    $idx = rtrim($file, '/') . '/index.php';
    if (is_file($idx)) {
        $file = $idx;
        $uri = rtrim($uri, '/') . '/index.php';
    }
}

if ($uri !== '/' && is_file($file)) {
    $ext = strtolower(pathinfo($file, PATHINFO_EXTENSION));
    if (isset($staticTypes[$ext])) {
        header('Content-Type: ' . $staticTypes[$ext]);
        header('Content-Length: ' . filesize($file));
        readfile($file);
        exit;
    }
    if ($ext === 'php') {
        chdir(dirname($file));
        include $file;
        exit;
    }
}

chdir($docRoot);
include $docRoot . '/index.php';
`;
  ensureDirRecursive(fs, "/var/www");
  writeVfsFile(fs, "/var/www/fpm-router.php", fpmRouter);
}

function populateNodeAndNpm(fs: MemoryFileSystem): void {
  ensureNpmDist();
  writeVfsBinary(fs, "/usr/bin/node", new Uint8Array(readFileSync(NODE_PATH)));
  ensureDirRecursive(fs, "/usr/local/lib");
  const count = walkAndWrite(fs, NPM_DIST, "/usr/local/lib/npm", {
    exclude: (rel) => rel === "man" || rel.startsWith("man/")
      || rel === "docs" || rel.startsWith("docs/"),
  });
  console.log(`  npm dist: ${count} files`);

  const npmWrapper = `#!/usr/bin/node
process.env.npm_config_cache ||= "/tmp/.npm-cache";
process.env.npm_config_fund ||= "false";
process.env.npm_config_audit ||= "false";
process.env.npm_config_progress ||= "false";
process.env.npm_config_registry ||= "http://proxy.local/";
process.env.npm_config_include ||= "dev";
process.env.npm_config_maxsockets ||= "1";
process.env.npm_config_omit ||= "optional";
if ((process.argv[2] === "run" || process.argv[2] === "run-script") && (process.argv[3] === "build" || process.argv[3] === "build:dev")) {
  const fs = require("fs");
  let version = "unknown";
  try {
    version = JSON.parse(fs.readFileSync("/work/wordpress-develop/package.json", "utf8")).version || version;
  } catch {}
  const script = process.argv[3];
  const runnerArgs = script === "build:dev" ? ["build", "--dev"] : ["build"];
  console.log("");
  console.log("> WordPress@" + version + " " + script);
  console.log("> node ${GRUNT_RUNNER_PATH} " + runnerArgs.join(" "));
  console.log("");
  process.argv = [process.argv[0], "${GRUNT_RUNNER_PATH}", ...runnerArgs];
  require("${GRUNT_RUNNER_PATH}");
} else {
require("/usr/local/lib/npm/lib/cli.js")(process);
}
`;
  const npxWrapper = `#!/usr/bin/node
process.env.npm_config_cache ||= "/tmp/.npm-cache";
process.env.npm_config_fund ||= "false";
process.env.npm_config_audit ||= "false";
process.env.npm_config_progress ||= "false";
process.env.npm_config_registry ||= "http://proxy.local/";
process.env.npm_config_include ||= "dev";
process.env.npm_config_maxsockets ||= "1";
process.env.npm_config_omit ||= "optional";
process.argv[1] = "/usr/local/lib/npm/bin/npm-cli.js";
process.argv.splice(2, 0, "exec");
require("/usr/local/lib/npm/lib/cli.js")(process);
`;
  writeVfsFile(fs, "/usr/local/bin/npm", npmWrapper, 0o755);
  writeVfsFile(fs, "/usr/local/bin/npx", npxWrapper, 0o755);
}

function populatePhpUnit(fs: MemoryFileSystem): void {
  ensureDirRecursive(fs, "/usr/local/lib/phpunit");
  ensureDirRecursive(fs, "/usr/local/lib/phpunit-polyfills");
  writeVfsBinary(fs, "/usr/local/lib/phpunit/phpunit.phar", new Uint8Array(readFileSync(PHPUNIT_PHAR)), 0o644);
  const polyfillCount = walkAndWrite(fs, PHPUNIT_POLYFILLS_DIR, "/usr/local/lib/phpunit-polyfills", {
    exclude: (rel) => rel === ".git" || rel.startsWith(".git/"),
  });
  console.log(`  phpunit polyfills: ${polyfillCount} files`);

  const wrapper = `#!/usr/bin/php
<?php
$args = array_slice($argv, 1);
$config = '/work/wordpress-develop/phpunit-kandelo.xml';
$isolatedConfig = '/work/wordpress-develop/phpunit-kandelo-isolated.xml';
$isolatedManifest = '/work/wordpress-develop/kandelo-process-isolated-tests.json';

function has_option(array $args, array $names): bool {
    foreach ($args as $i => $arg) {
        foreach ($names as $name) {
            if ($arg === $name || str_starts_with($arg, $name . '=')) {
                return true;
            }
        }
    }
    return false;
}

function phpunit_command(
    array $extra,
    array $args,
    ?string $configOverride = null,
    array $env = [],
    array $phpIni = []
): string {
    global $config;
    $selectedConfig = $configOverride ?? $config;
    $effectivePhpIni = ['output_buffering' => '0'];
    foreach ($phpIni as $name => $value) {
        $effectivePhpIni[$name] = $value;
    }
    $cmd = ['/usr/bin/php'];
    foreach ($effectivePhpIni as $name => $value) {
        $cmd[] = '-d';
        $cmd[] = $name . '=' . $value;
    }
    $cmd[] = '/usr/local/lib/phpunit/phpunit.phar';
    if (!has_option($args, ['-c', '--configuration'])) {
        $cmd[] = '-c';
        $cmd[] = $selectedConfig;
    }
    $cmd = array_merge($cmd, $args, $extra);
    if ($env) {
        $envPrefix = ['/usr/bin/env'];
        foreach ($env as $name => $value) {
            $envPrefix[] = $name . '=' . $value;
        }
        $cmd = array_merge($envPrefix, $cmd);
    }
    return implode(' ', array_map('escapeshellarg', $cmd));
}

function run_phpunit(
    array $extra,
    array $args,
    ?string $configOverride = null,
    array $env = [],
    array $phpIni = []
): int {
    passthru(phpunit_command($extra, $args, $configOverride, $env, $phpIni), $status);
    return (int) $status;
}

function capture_phpunit(
    array $extra,
    array $args,
    int &$status,
    ?string $configOverride = null,
    array $env = [],
    array $phpIni = []
): string {
    $output = [];
    exec(phpunit_command($extra, $args, $configOverride, $env, $phpIni) . ' 2>&1', $output, $status);
    return implode("\\n", $output) . "\\n";
}

function phpunit_status_is_non_error(string $output): bool {
    if (preg_match('/^(FAILURES!|ERRORS!)/m', $output)) {
        return false;
    }
    if (str_contains($output, 'No tests executed!')) {
        return true;
    }
    if (
        !preg_match('/^OK(?:, but incomplete, skipped, or risky tests!)?/m', $output)
        && !preg_match('/^WARNINGS!/m', $output)
    ) {
        return false;
    }
    return !preg_match('/Risky:\\s*[1-9][0-9]*/', $output);
}

function run_isolated_phpunit(array $extra, array $args, ?string $configOverride = null): int {
    $status = 0;
    $output = capture_phpunit(
        $extra,
        $args,
        $status,
        $configOverride,
        ['WP_TESTS_SKIP_INSTALL' => '1'],
        ['output_buffering' => '1048576']
    );
    if ($status !== 0 && str_contains($output, 'No tests executed!') && phpunit_status_is_non_error($output)) {
        return 0;
    }
    fwrite(STDOUT, $output);
    if ($status !== 0 && phpunit_status_is_non_error($output)) {
        return 0;
    }
    return (int) $status;
}

function filter_for_listed_test(string $testName): string {
    if (preg_match('/^([^"]+)"(.+)"$/', $testName, $matches)) {
        return '/^' . preg_quote($matches[1], '/') . '(?:\\s|").*' . preg_quote($matches[2], '/') . '(?:"|$)/';
    }
    return '/^' . preg_quote($testName, '/') . '$/';
}

function requires_non_isolated_probe(array $args): bool {
    $selectorOptions = [
        '--filter',
        '--group',
        '--exclude-group',
        '--testsuite',
        '--testdox-group',
        '--testdox-exclude-group',
    ];
    $optionsWithValues = [
        '-c',
        '--configuration',
        '--bootstrap',
        '--cache-result-file',
        '--coverage-clover',
        '--coverage-cobertura',
        '--coverage-crap4j',
        '--coverage-html',
        '--coverage-php',
        '--coverage-text',
        '--coverage-xml',
        '--log-junit',
        '--log-teamcity',
        '--log-testdox-html',
        '--log-testdox-text',
        '--printer',
        '--testdox-html',
        '--testdox-text',
    ];

    for ($i = 0; $i < count($args); $i++) {
        $arg = $args[$i];
        foreach ($selectorOptions as $option) {
            if ($arg === $option || str_starts_with($arg, $option . '=')) {
                return true;
            }
        }
        if ($arg === '--') {
            return $i + 1 < count($args);
        }
        foreach ($optionsWithValues as $option) {
            if ($arg === $option) {
                $i++;
                continue 2;
            }
            if (str_starts_with($arg, $option . '=')) {
                continue 2;
            }
        }
        if ($arg !== '' && $arg[0] !== '-') {
            return true;
        }
    }

    return false;
}

function load_isolated_manifest(string $path): array {
    if (!is_file($path)) {
        return [];
    }
    $entries = json_decode((string) file_get_contents($path), true);
    return is_array($entries) ? $entries : [];
}

function method_for_listed_test(string $testName): string {
    if (preg_match('/::([A-Za-z0-9_]+)/', $testName, $matches)) {
        return $matches[1];
    }
    return '';
}

function listed_test_matches_entry(string $testName, array $entry): bool {
    if (!isset($entry['methods']) || $entry['methods'] === null) {
        return true;
    }
    if (!is_array($entry['methods'])) {
        return false;
    }
    return in_array(method_for_listed_test($testName), $entry['methods'], true);
}

$directOptions = ['--help', '-h', '--version', '--list-groups', '--list-suites', '--list-tests', '--list-tests-xml'];
if (getenv('KANDELO_PHPUNIT_DIRECT') === '1' || has_option($args, $directOptions)) {
    exit(run_phpunit([], $args));
}

$hasNonIsolatedTests = true;
if (requires_non_isolated_probe($args)) {
    $nonIsolatedListStatus = 0;
    $nonIsolatedListOutput = capture_phpunit(['--list-tests'], $args, $nonIsolatedListStatus);
    $hasNonIsolatedTests = $nonIsolatedListStatus === 0 && preg_match('/^\\s*-\\s+.+$/m', $nonIsolatedListOutput);
}
$mainStatus = $hasNonIsolatedTests ? run_phpunit([], $args) : 0;
if ($mainStatus !== 0) {
    exit($mainStatus);
}
if (requires_non_isolated_probe($args)) {
    exit($mainStatus);
}

$isolatedTests = [];
foreach (load_isolated_manifest($isolatedManifest) as $entry) {
    if (!is_array($entry) || !isset($entry['file']) || !is_string($entry['file'])) {
        continue;
    }
    $listStatus = 0;
    $listOutput = capture_phpunit(['--list-tests', $entry['file']], $args, $listStatus, $isolatedConfig);
    if ($listStatus !== 0) {
        continue;
    }
    foreach (explode("\\n", $listOutput) as $line) {
        if (preg_match('/^\\s*-\\s+(.+)$/', $line, $matches) && listed_test_matches_entry($matches[1], $entry)) {
            $isolatedTests[] = [$entry['file'], $matches[1]];
        }
    }
}

$isolatedStatus = 0;
foreach ($isolatedTests as [$file, $testName]) {
    fwrite(STDOUT, "\\n[process-isolated] " . $testName . "\\n");
    $status = run_isolated_phpunit([$file, '--filter', filter_for_listed_test($testName)], $args, $isolatedConfig);
    if ($status !== 0 && $isolatedStatus === 0) {
        $isolatedStatus = $status;
    }
}
exit($isolatedStatus);
`;
  writeVfsFile(fs, "/usr/local/bin/phpunit", wrapper, 0o755);
}

function populateWordPressDevelop(fs: MemoryFileSystem): void {
  ensureDirRecursive(fs, "/work");
  fs.chmod("/work", 0o777);
  console.log("Writing WordPress develop shallow clone...");
  ensureGutenbergArtifact();
  const count = walkAndWrite(fs, WP_DEV_DIR, "/work/wordpress-develop", {
    exclude: (rel) => rel === "vendor" || rel.startsWith("vendor/"),
  });
  console.log(`  wordpress-develop: ${count} files`);
  symlink(fs, "/work/wordpress-develop", "/workspace");
  ensureDirRecursive(fs, "/work/wordpress-develop/src/wp-content/mu-plugins");
  ensureDirRecursive(fs, "/work/wordpress-develop/tests/phpunit/build/logs");
  fs.chmod("/work/wordpress-develop/tests/phpunit/build/logs", 0o777);

  const packageJsonPath = join(WP_DEV_DIR, "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    scripts?: Record<string, string>;
  };
  if (packageJson.scripts) {
    for (const [name, script] of Object.entries(packageJson.scripts)) {
      packageJson.scripts[name] = script.replace(
        /^grunt\b/,
        `node ${GRUNT_RUNNER_PATH}`,
      );
    }
    for (const name of ["build", "build:dev"]) {
      const script = packageJson.scripts[name];
      if (!script?.startsWith(`node ${GRUNT_RUNNER_PATH} `)) continue;
      const safeName = name.replace(/[^a-z0-9_-]/gi, "-");
      const logPath = `/tmp/wordpress-${safeName}.log`;
      packageJson.scripts[name] = `${script} >${logPath} 2>&1; status=$?; tail -n 80 ${logPath}; exit $status`;
    }
  }
  const packageHash = createHash("md5")
    .update(Buffer.from(JSON.stringify({
      dependencies: packageJson.dependencies || {},
      devDependencies: packageJson.devDependencies || {},
    })))
    .digest("hex");
  writeVfsFile(
    fs,
    "/work/wordpress-develop/package.json",
    JSON.stringify(packageJson, null, 2) + "\n",
    0o644,
  );
  writeVfsFile(fs, "/work/wordpress-develop/packagehash.txt", packageHash, 0o644);
  patchPhpMailerTestBootstrap(fs);
  patchSiteHealthPageCacheThresholdTest(fs);
  markPhpUnitProcessIsolationTests(fs);
}

function patchPhpMailerTestBootstrap(fs: MemoryFileSystem): void {
  const rel = "tests/phpunit/includes/bootstrap.php";
  const path = `/work/wordpress-develop/${rel}`;
  const source = readFileSync(join(WP_DEV_DIR, rel), "utf8");
  const needle = "$phpmailer = new MockPHPMailer( true );";
  const replacement = `$phpmailer = new MockPHPMailer( true );
$phpmailer::$validator = static function ( $email ) {
\treturn (bool) is_email( $email );
};`;
  if (!source.includes(needle) || source.includes("$phpmailer::$validator = static function")) {
    return;
  }
  writeVfsFile(fs, path, source.replace(needle, replacement), 0o644);
  console.log("  patched PHPUnit MockPHPMailer validator");
}

function patchSiteHealthPageCacheThresholdTest(fs: MemoryFileSystem): void {
  const rel = "tests/phpunit/tests/admin/wpSiteHealth.php";
  const path = `/work/wordpress-develop/${rel}`;
  let source = readFileSync(join(WP_DEV_DIR, rel), "utf8");
  if (source.includes("$threshold_filter = static function () use ( $threshold )")) {
    return;
  }

  const filterNeedle = `\t\tif ( $delay_the_response ) {
\t\t\tadd_filter(
\t\t\t\t'site_status_good_response_time_threshold',
\t\t\t\tstatic function () use ( $threshold ) {
\t\t\t\t\treturn $threshold;
\t\t\t\t}
\t\t\t);
\t\t}
`;
  const filterReplacement = `\t\t$threshold_filter = static function () use ( $threshold ) {
\t\t\treturn $threshold;
\t\t};

\t\tif ( $delay_the_response ) {
\t\t\tadd_filter(
\t\t\t\t'site_status_good_response_time_threshold',
\t\t\t\t$threshold_filter
\t\t\t);
\t\t}
`;
  const cleanupNeedle = `\t\t$actual = $this->instance->get_test_page_cache();
`;
  const cleanupReplacement = `\t\t$actual = $this->instance->get_test_page_cache();

\t\tif ( $delay_the_response ) {
\t\t\tremove_filter( 'site_status_good_response_time_threshold', $threshold_filter );
\t\t}
`;

  if (!source.includes(filterNeedle) || !source.includes(cleanupNeedle)) {
    console.warn("  warning: wpSiteHealth page-cache threshold patch did not match");
    return;
  }

  source = source
    .replace(filterNeedle, filterReplacement)
    .replace(cleanupNeedle, cleanupReplacement);
  writeVfsFile(fs, path, source, 0o644);
  console.log("  patched PHPUnit wpSiteHealth page-cache threshold cleanup");
}

function markPhpUnitProcessIsolationTests(fs: MemoryFileSystem): void {
  let grepOutput = "";
  try {
    grepOutput = execFileSync(
      "git",
      [
        "-C",
        WP_DEV_DIR,
        "grep",
        "-l",
        "-E",
        "@runTestsInSeparateProcesses|@runInSeparateProcess|@runClassInSeparateProcess",
        "--",
        "tests/phpunit/tests",
      ],
      { encoding: "utf8" },
    );
  } catch {
    return;
  }

  const files = grepOutput.split(/\r?\n/).filter(Boolean);
  const manifest: Array<{ file: string; methods: string[] | null }> = [];
  for (const rel of files) {
    const sourcePath = join(WP_DEV_DIR, rel);
    const source = readFileSync(sourcePath, "utf8");
    manifest.push({ file: rel, methods: isolatedMethodsForSource(source) });
    const lines = source.split(/\r?\n/);
    const patched: string[] = [];
    let taggedCurrentDocblock = false;

    for (const line of lines) {
      if (/^\s*\/\*\*/.test(line)) {
        taggedCurrentDocblock = false;
      }
      if (/^\s+\*\s+@group\s+kandelo-process-isolated\s*$/.test(line)) {
        taggedCurrentDocblock = true;
      }
      if (/^\s+\*\s+@(runTestsInSeparateProcesses|runInSeparateProcess|runClassInSeparateProcess)\s*$/.test(line)) {
        if (!taggedCurrentDocblock) {
          const indent = line.match(/^(\s+\*)/)?.[1] ?? "\t *";
          patched.push(`${indent} @group kandelo-process-isolated`);
          taggedCurrentDocblock = true;
        }
        continue;
      }
      if (/^\s+\*\s+@preserveGlobalState disabled\s*$/.test(line)) {
        continue;
      }
      patched.push(line);
    }

    writeVfsFile(fs, `/work/wordpress-develop/${rel}`, patched.join("\n"), 0o644);
  }
  writeVfsFile(
    fs,
    "/work/wordpress-develop/kandelo-process-isolated-tests.json",
    `${JSON.stringify(manifest, null, 2)}\n`,
    0o644,
  );
  console.log(`  phpunit process-isolated tests marked: ${files.length} files`);
}

function isolatedMethodsForSource(source: string): string[] | null {
  if (/@runTestsInSeparateProcesses\b|@runClassInSeparateProcess\b/.test(source)) {
    return null;
  }

  const methods: string[] = [];
  let pendingDocblock = "";
  let inDocblock = false;
  for (const line of source.split(/\r?\n/)) {
    if (/^\s*\/\*\*/.test(line)) {
      pendingDocblock = `${line}\n`;
      inDocblock = true;
      continue;
    }
    if (inDocblock) {
      pendingDocblock += `${line}\n`;
      if (/\*\//.test(line)) {
        inDocblock = false;
      }
      continue;
    }

    const match = line.match(/\bfunction\s+(test_[A-Za-z0-9_]+)\s*\(/);
    if (match) {
      if (/@runInSeparateProcess\b/.test(pendingDocblock)) {
        methods.push(match[1]);
      }
      pendingDocblock = "";
    } else if (line.trim() !== "" && !/^\s*(?:public|protected|private|static|final|abstract)\b/.test(line)) {
      pendingDocblock = "";
    }
  }
  return methods;
}

function ensureGutenbergArtifact(): void {
  const packageJson = JSON.parse(readFileSync(join(WP_DEV_DIR, "package.json"), "utf8")) as {
    gutenberg?: { sha?: string };
  };
  const sha = packageJson.gutenberg?.sha;
  if (!sha) {
    throw new Error("WordPress package.json does not define gutenberg.sha");
  }

  const hashPath = join(WP_DEV_DIR, "gutenberg", ".gutenberg-hash");
  if (existsSync(hashPath) && readFileSync(hashPath, "utf8").trim() === sha) {
    console.log(`  gutenberg artifact: ${sha}`);
    return;
  }

  console.log(`  downloading Gutenberg artifact ${sha}`);
  execFileSync(process.execPath, ["tools/gutenberg/download.js"], {
    cwd: WP_DEV_DIR,
    stdio: "inherit",
  });
}

const MARIADB_BOOTSTRAP_SCRIPT = `# mariadbd --bootstrap does not exit at stdin EOF in this wasm port.
/usr/sbin/mariadbd --no-defaults --user=mysql --datadir=/data --tmpdir=/data/tmp \\
    --default-storage-engine=Aria --skip-grant-tables \\
    --key-buffer-size=1048576 --table-open-cache=10 --sort-buffer-size=262144 \\
    --bootstrap --skip-networking --log-warnings=0 \\
    --log-error=/data/bootstrap.log < /etc/mariadb/bootstrap.sql &
PID=$!
i=0
while [ $i -lt 60 ]; do
    if [ -d /data/wordpress ]; then
        sleep 1
        break
    fi
    sleep 1
    i=$((i + 1))
done
kill -TERM $PID 2>/dev/null
sleep 1
kill -KILL $PID 2>/dev/null
exit 0
`;

const WP_CONFIG_INIT_SCRIPT = `: "\${WP_APP_PATH:=/app}"
: "\${WP_PROTO:=http}"
sed -e "s|@@APP_PATH@@|$WP_APP_PATH|g" \\
    -e "s|@@PROTO@@|$WP_PROTO|g" \\
    /etc/wp-config-template.php > /work/wordpress-develop/src/wp-config.php
echo "wp-config-init: APP_PATH=$WP_APP_PATH PROTO=$WP_PROTO"
`;

const WP_CONFIG_TEMPLATE_PHP = `<?php
define('DB_NAME', 'wordpress');
define('DB_USER', 'root');
define('DB_PASSWORD', '');
define('DB_HOST', '127.0.0.1:3306');
define('DB_CHARSET', 'utf8');
define('DB_COLLATE', '');

define('AUTH_KEY',         'wasm-posix-kernel-wordpress-dev');
define('SECURE_AUTH_KEY',  'wasm-posix-kernel-wordpress-dev');
define('LOGGED_IN_KEY',    'wasm-posix-kernel-wordpress-dev');
define('NONCE_KEY',        'wasm-posix-kernel-wordpress-dev');
define('AUTH_SALT',        'wasm-posix-kernel-wordpress-dev');
define('SECURE_AUTH_SALT', 'wasm-posix-kernel-wordpress-dev');
define('LOGGED_IN_SALT',   'wasm-posix-kernel-wordpress-dev');
define('NONCE_SALT',       'wasm-posix-kernel-wordpress-dev');

$table_prefix = 'wp_';

define('WP_DEBUG', true);
define('WP_DEBUG_LOG', true);
define('WP_DEBUG_DISPLAY', false);
@ini_set('display_errors', '0');

if (isset($_SERVER['HTTP_HOST'])) {
    if ('@@PROTO@@' === 'https') { $_SERVER['HTTPS'] = 'on'; }
    define('WP_HOME', '@@PROTO@@://' . $_SERVER['HTTP_HOST'] . '@@APP_PATH@@');
    define('WP_SITEURL', '@@PROTO@@://' . $_SERVER['HTTP_HOST'] . '@@APP_PATH@@');
}

define('WP_HTTP_BLOCK_EXTERNAL', true);
define('DISABLE_WP_CRON', true);

if ( ! defined( 'ABSPATH' ) ) {
    define( 'ABSPATH', __DIR__ . '/' );
}

require_once ABSPATH . 'wp-settings.php';
`;

const WP_TESTS_CONFIG_PHP = `<?php
define( 'DB_NAME', 'wordpress_tests' );
define( 'DB_USER', 'root' );
define( 'DB_PASSWORD', '' );
define( 'DB_HOST', '127.0.0.1:3306' );
define( 'DB_CHARSET', 'utf8' );
define( 'DB_COLLATE', '' );

define( 'ABSPATH', '/work/wordpress-develop/src/' );
define( 'WP_TESTS_DOMAIN', 'example.org' );
define( 'WP_TESTS_EMAIL', 'admin@example.org' );
define( 'WP_TESTS_TITLE', 'Test Blog' );
define( 'WP_TESTS_PHPUNIT_POLYFILLS_PATH', '/usr/local/lib/phpunit-polyfills' );
define( 'WP_TESTS_FORCE_KNOWN_BUGS', false );
define( 'WP_PHP_BINARY', '/usr/bin/php' );
define( 'WP_DEBUG', true );

$table_prefix = 'wptests_';
`;

function populateDevHelpers(fs: MemoryFileSystem): void {
  const kandeloPhpunitXml = readFileSync(join(WP_DEV_DIR, "phpunit.xml.dist"), "utf8")
    .replace(
      /\n\t\t\t<group>html-api-html5lib-tests<\/group>/,
      "\n\t\t\t<group>html-api-html5lib-tests</group>\n\t\t\t<group>kandelo-process-isolated</group>",
    )
    .replace(
      /\n\t\t<const name="WP_RUN_CORE_TESTS" value="1" \/>/,
      '\n\t\t<const name="WP_RUN_CORE_TESTS" value="1" />\n\t\t<ini name="error_reporting" value="-1" />',
    );
  const isolatedPhpunitXml = kandeloPhpunitXml.replace(
    /\n\t\t\t<group>kandelo-process-isolated<\/group>/,
    "",
  );
  const muPlugin = `<?php
if ( ! defined( 'WP_TESTS_DOMAIN' ) ) {
    add_filter('pre_wp_mail', '__return_false');
    add_filter('pre_http_request', function($pre, $args, $url) {
        return new WP_Error('http_disabled', 'HTTP requests disabled in Wasm');
    }, 10, 3);
}
`;
  writeVfsFile(fs, "/work/wordpress-develop/src/wp-content/mu-plugins/wasm-dev.php", muPlugin);
  writeVfsFile(fs, "/work/wordpress-develop/wp-tests-config.php", WP_TESTS_CONFIG_PHP);
  writeVfsFile(fs, "/work/wordpress-develop/phpunit-kandelo.xml", kandeloPhpunitXml);
  writeVfsFile(fs, "/work/wordpress-develop/phpunit-kandelo-isolated.xml", isolatedPhpunitXml);
  ensureDirRecursive(fs, "/usr/local/lib/kandelo");
  writeVfsFile(fs, "/usr/local/lib/kandelo/webpack-global-this-shim.js", "module.exports = globalThis;\n", 0o644);
  writeVfsFile(fs, GRUNT_RUNNER_PATH, `const path = require("path");
const fs = require("fs");
const childProcess = require("child_process");
const events = require("events");
const nodeUtil = require("util");
const bufferModule = require("buffer");
const moduleLoader = require("module");
const projectRoot = "/work/wordpress-develop";
process.chdir(projectRoot);

const printFatal = (label, error) => {
  const detail = error && (error.stack || error.message || String(error));
  console.error(label + ": " + detail);
};
process.on("unhandledRejection", (error) => printFatal("Unhandled rejection", error));
process.on("uncaughtException", (error) => {
  printFatal("Uncaught exception", error);
  process.exit(1);
});

const writeInstalledGlobalThisShim = () => {
  const shim = "module.exports = globalThis;\\n";
  for (const rel of [
    "features/global-this.js",
    "full/global-this.js",
    "actual/global-this.js",
    "stable/global-this.js",
    "modules/es.global-this.js",
    "modules/esnext.global-this.js",
  ]) {
    const target = path.join(projectRoot, "node_modules/core-js-pure", rel);
    if (fs.existsSync(path.dirname(target))) {
      fs.writeFileSync(target, shim);
    }
  }
};
writeInstalledGlobalThisShim();

const NativeBuffer = bufferModule.Buffer;
if (typeof global.BigInt !== "function") {
  global.BigInt = (value) => Number(String(value).replace(/_/g, ""));
}
if (typeof global.WebAssembly === "undefined") {
  global.WebAssembly = {
    Module: function Module(bytes) {
      this.bytes = bytes;
    },
    Instance: function Instance() {
      return {
        exports: {
          memory: { buffer: new ArrayBuffer(65536) },
          init() {},
          update() {},
          final() {},
        },
      };
    },
    Memory: function Memory(options = {}) {
      this.buffer = new ArrayBuffer((options.initial || 1) * 65536);
    },
    Global: function Global(_descriptor, value) {
      this.value = value;
    },
    compile: async (bytes) => new global.WebAssembly.Module(bytes),
    compileStreaming: async () => new global.WebAssembly.Module(new Uint8Array()),
    instantiate: async (module) => ({ instance: new global.WebAssembly.Instance(module) }),
    instantiateStreaming: async () => ({ instance: new global.WebAssembly.Instance({}) }),
    validate: () => false,
  };
}
class KandeloHash {
  constructor() {
    this.a = 0x811c9dc5;
    this.b = 0x01000193;
  }

  update(data) {
    if (data == null) {
      return this;
    }
    const bytes = Buffer.isBuffer(data) ? data : NativeBuffer.from(String(data));
    for (let i = 0; i < bytes.length; i++) {
      this.a ^= bytes[i];
      this.a = Math.imul(this.a, 0x01000193) >>> 0;
      this.b = (Math.imul(this.b ^ bytes[i], 0x85ebca6b) + 0xc2b2ae35) >>> 0;
    }
    return this;
  }

  digest(encoding) {
    const hex = this.a.toString(16).padStart(8, "0") + this.b.toString(16).padStart(8, "0");
    if (!encoding || encoding === "hex") {
      return hex;
    }
    return NativeBuffer.from(hex, "hex").toString(encoding);
  }
}
const originalModuleLoadForWebpackHash = moduleLoader._load;
moduleLoader._load = function(request, parent, isMain) {
  let resolved;
  try {
    resolved = moduleLoader._resolveFilename(request, parent, isMain);
  } catch {
    return originalModuleLoadForWebpackHash.apply(this, arguments);
  }
  if (/[/\\\\]webpack[/\\\\]lib[/\\\\]util[/\\\\]hash[/\\\\](md4|xxhash64)\\.js$/.test(resolved)) {
    return () => new KandeloHash();
  }
  return originalModuleLoadForWebpackHash.apply(this, arguments);
};
try {
  NativeBuffer("kandelo-buffer-probe");
} catch {
  function CompatBuffer(value, encodingOrOffset, length) {
    if (typeof value === "number") {
      return NativeBuffer.alloc(value);
    }
    return NativeBuffer.from(value, encodingOrOffset, length);
  }
  Object.setPrototypeOf(CompatBuffer, NativeBuffer);
  CompatBuffer.prototype = NativeBuffer.prototype;
  for (const key of Reflect.ownKeys(NativeBuffer)) {
    if (key === "length" || key === "name" || key === "prototype") {
      continue;
    }
    Object.defineProperty(CompatBuffer, key, Object.getOwnPropertyDescriptor(NativeBuffer, key));
  }
  if (typeof NativeBuffer.from === "function") {
    CompatBuffer.from = NativeBuffer.from.bind(NativeBuffer);
  }
  if (typeof NativeBuffer.alloc === "function") {
    CompatBuffer.alloc = NativeBuffer.alloc.bind(NativeBuffer);
  }
  if (typeof NativeBuffer.allocUnsafe === "function") {
    CompatBuffer.allocUnsafe = NativeBuffer.allocUnsafe.bind(NativeBuffer);
  }
  if (typeof NativeBuffer.allocUnsafeSlow === "function") {
    CompatBuffer.allocUnsafeSlow = NativeBuffer.allocUnsafeSlow.bind(NativeBuffer);
  }
  if (typeof NativeBuffer.isBuffer === "function") {
    CompatBuffer.isBuffer = NativeBuffer.isBuffer.bind(NativeBuffer);
  }
  global.Buffer = CompatBuffer;
  bufferModule.Buffer = CompatBuffer;
}

if (typeof fs.futimesSync !== "function") {
  fs.futimesSync = () => {};
}
if (typeof fs.utimesSync !== "function") {
  fs.utimesSync = () => {};
}
if (typeof fs.lutimesSync !== "function") {
  fs.lutimesSync = () => {};
}

if (typeof events.EventEmitter === "function") {
  try {
    events.EventEmitter.call({});
  } catch {
    const NativeEventEmitter = events.EventEmitter;
    function CompatEventEmitter() {}
    Object.setPrototypeOf(CompatEventEmitter, NativeEventEmitter);
    CompatEventEmitter.prototype = NativeEventEmitter.prototype;
    events.EventEmitter = CompatEventEmitter;
  }
}

if (typeof nodeUtil.isError !== "function") {
  nodeUtil.isError = (value) => value instanceof Error;
}
nodeUtil.inherits = (ctor, superCtor) => {
  ctor.super_ = superCtor;
  ctor.prototype = Object.create(superCtor.prototype, {
    constructor: {
      value: ctor,
      enumerable: false,
      writable: true,
      configurable: true,
    },
  });
};
if (typeof nodeUtil._extend !== "function") {
  nodeUtil._extend = (target, source) => Object.assign(target, source);
}
if (typeof nodeUtil.isArray !== "function") {
  nodeUtil.isArray = Array.isArray;
}
if (typeof nodeUtil.isBoolean !== "function") {
  nodeUtil.isBoolean = (value) => typeof value === "boolean";
}
if (typeof nodeUtil.isBuffer !== "function") {
  nodeUtil.isBuffer = Buffer.isBuffer.bind(Buffer);
}
if (typeof nodeUtil.isRegExp !== "function") {
  nodeUtil.isRegExp = (value) => value instanceof RegExp;
}
if (typeof nodeUtil.isDate !== "function") {
  nodeUtil.isDate = (value) => value instanceof Date;
}
if (typeof nodeUtil.isFunction !== "function") {
  nodeUtil.isFunction = (value) => typeof value === "function";
}
if (typeof nodeUtil.isNull !== "function") {
  nodeUtil.isNull = (value) => value === null;
}
if (typeof nodeUtil.isNullOrUndefined !== "function") {
  nodeUtil.isNullOrUndefined = (value) => value == null;
}
if (typeof nodeUtil.isNumber !== "function") {
  nodeUtil.isNumber = (value) => typeof value === "number";
}
if (typeof nodeUtil.isObject !== "function") {
  nodeUtil.isObject = (value) => value !== null && typeof value === "object";
}
if (typeof nodeUtil.isPrimitive !== "function") {
  nodeUtil.isPrimitive = (value) => value === null || (typeof value !== "object" && typeof value !== "function");
}
if (typeof nodeUtil.isString !== "function") {
  nodeUtil.isString = (value) => typeof value === "string";
}
if (typeof nodeUtil.isUndefined !== "function") {
  nodeUtil.isUndefined = (value) => value === undefined;
}
if (typeof Buffer.isBuffer !== "function") {
  Buffer.isBuffer = (value) => value instanceof Buffer;
}
try {
  const saferBuffer = require(path.join(projectRoot, "node_modules/safer-buffer"));
  saferBuffer.Buffer.from = Buffer.from.bind(Buffer);
  saferBuffer.Buffer.alloc = Buffer.alloc.bind(Buffer);
  saferBuffer.Buffer.isBuffer = Buffer.isBuffer.bind(Buffer);
} catch {}

const rawArgs = process.argv.slice(2);
const tasks = [];
const options = {};

for (const arg of rawArgs) {
  if (!arg.startsWith("-")) {
    tasks.push(arg);
    continue;
  }
  if (arg.startsWith("--no-")) {
    options[arg.slice(5)] = false;
    continue;
  }
  const eq = arg.indexOf("=");
  if (arg.startsWith("--") && eq !== -1) {
    options[arg.slice(2, eq)] = arg.slice(eq + 1);
    continue;
  }
  if (arg.startsWith("--")) {
    options[arg.slice(2)] = true;
  }
}

const grunt = require(path.join(projectRoot, "node_modules/grunt"));
require(path.join(projectRoot, "Gruntfile.js"))(grunt);
grunt.fail.errorcount = 0;
const patchWebpackConfig = (config) => {
  if (Array.isArray(config)) {
    config.forEach(patchWebpackConfig);
    return;
  }
  if (!config || typeof config !== "object") {
    return;
  }
  config.cache = false;
  config.optimization = {
    ...(config.optimization || {}),
    minimize: false,
    minimizer: [],
  };
  config.output = {
    ...(config.output || {}),
    hashFunction: KandeloHash,
  };
  if (config.output && typeof config.output.path === "string" && /[/\\\\]codemirror$/.test(config.output.path)) {
    config.plugins = [];
  }
  config.resolve = {
    ...(config.resolve || {}),
    alias: {
      ...((config.resolve && config.resolve.alias) || {}),
      "core-js-pure/features/global-this": "/usr/local/lib/kandelo/webpack-global-this-shim.js",
      "core-js-pure/features/global-this$": "/usr/local/lib/kandelo/webpack-global-this-shim.js",
      "core-js-pure/features/global-this.js$": "/usr/local/lib/kandelo/webpack-global-this-shim.js",
    },
  };
};
for (const target of ["prod", "dev", "watch", "codemirror"]) {
  const config = grunt.config.getRaw(["webpack", target]);
  patchWebpackConfig(config);
  grunt.config.set(["webpack", target], config);
}
grunt.registerTask("webpack", "Run webpack directly in the Kandelo Node runtime.", function(target) {
  const done = this.async();
  const webpack = require(path.join(projectRoot, "node_modules/webpack"));
  const targets = target ? [target] : Object.keys(grunt.config.get("webpack") || {}).filter((key) => key !== "options");
  let index = 0;
  const runNext = () => {
    if (index >= targets.length) {
      done();
      return;
    }
    const currentTarget = targets[index++];
    if (currentTarget === "codemirror") {
      console.warn("Skipping webpack:codemirror in the Kandelo Node runtime.");
      runNext();
      return;
    }
    const config = grunt.config.getRaw(["webpack", currentTarget]);
    patchWebpackConfig(config);
    const compiler = webpack(config);
    compiler.run((error, stats) => {
      const finish = (closeError) => {
        if (error || closeError) {
          const failure = error || closeError;
          console.error(failure && (failure.stack || failure.message || String(failure)));
          done(failure);
          return;
        }
        if (stats && stats.hasErrors()) {
          console.error(stats.toString({
            all: false,
            errors: true,
            errorDetails: true,
            moduleTrace: true,
            warnings: true,
            colors: false,
          }));
          done(new Error("webpack:" + currentTarget + " failed"));
          return;
        }
        if (stats && stats.hasWarnings()) {
          console.warn(stats.toString({
            all: false,
            warnings: true,
            colors: false,
          }));
        }
        runNext();
      };
      if (compiler.close) {
        compiler.close(finish);
      } else {
        finish();
      }
    });
  };
  runNext();
});
const originalSpawn = grunt.util.spawn.bind(grunt.util);
grunt.util.spawn = (opts, done) => {
  if (opts && opts.opts && opts.opts.stdio === "inherit") {
    let cmd = opts.cmd;
    let args = opts.args || [];
    if (opts.grunt) {
      cmd = process.execPath;
      args = process.execArgv.concat(process.argv[1], args);
    }
    const result = childProcess.spawnSync(cmd, args, opts.opts);
    const code = result.status == null ? (result.error ? 1 : 0) : result.status;
    const stdout = result.stdout ? String(result.stdout).trim() : "";
    const stderr = result.stderr ? String(result.stderr).trim() : "";
    const spawnResult = {
      stdout,
      stderr,
      code,
      toString() {
        return code === 0 ? stdout : stderr || stdout;
      },
    };
    if (done) {
      done(code === 0 ? null : (result.error || new Error(spawnResult.toString())), spawnResult, code);
    }
    return {
      kill() {},
      on() { return this; },
    };
  }
  return originalSpawn(opts, done);
};
grunt.tasks(tasks, { ...options, gruntfile: false }, () => {
  process.exit(grunt.fail.errorcount > 0 ? 1 : 0);
});
`, 0o644);
  writeVfsFile(fs, "/etc/wp-config-template.php", WP_CONFIG_TEMPLATE_PHP);
  writeVfsFile(fs, "/etc/wp-config-init.sh", WP_CONFIG_INIT_SCRIPT, 0o755);
  writeVfsFile(fs, "/etc/mariadb/bootstrap.sh", MARIADB_BOOTSTRAP_SCRIPT, 0o755);

  const help = `WordPress development demo

Repository: /work/wordpress-develop
Web root:   /work/wordpress-develop/src
Databases:  wordpress, wordpress_tests on 127.0.0.1:3306

Useful commands:
  git status
  phpunit tests/phpunit/tests/formatting/wpAutop.php
  npm install
  npm run build:dev

npm is configured to use http://proxy.local/, which the browser runtime
maps to the npm registry through the same-origin proxy.
`;
  writeVfsFile(fs, "/work/README-kandelo-wordpress-dev.txt", help);
  writeVfsFile(fs, "/usr/local/bin/wp-dev-help", `#!/bin/sh
cat /work/README-kandelo-wordpress-dev.txt
`, 0o755);

  const profile = [
    "alias ls='ls --color=auto'",
    "alias grep='grep --color=auto'",
    "alias wp-dev-help='cat /work/README-kandelo-wordpress-dev.txt'",
    "alias npm='/usr/bin/node /usr/local/bin/npm'",
    "alias npx='/usr/bin/node /usr/local/bin/npx'",
    "alias phpunit='/usr/local/bin/phpunit'",
    "export USER=user",
    "export npm_config_cache=/tmp/.npm-cache",
    "export npm_config_fund=false",
    "export npm_config_audit=false",
    "export npm_config_progress=false",
    "export npm_config_registry=http://proxy.local/",
    "export npm_config_include=dev",
    "export npm_config_maxsockets=1",
    "export npm_config_omit=optional",
    "cd /work/wordpress-develop 2>/dev/null || true",
    "cat /work/README-kandelo-wordpress-dev.txt",
    "",
  ].join("\n");
  writeVfsFile(fs, "/etc/profile", profile);
}

function buildServices(): DinitService[] {
  // MariaDB's default thread-per-connection handling is required here:
  // WordPress tests keep the global wpdb connection open while opening
  // additional mysqli/wpdb connections.
  return [
    {
      name: "mariadb-bootstrap",
      type: "scripted",
      command: "/bin/sh /etc/mariadb/bootstrap.sh",
      logfile: "/var/log/mariadb-bootstrap.log",
      restart: false,
    },
    {
      name: "mariadb",
      type: "process",
      command: "/usr/sbin/mariadbd --no-defaults --user=mysql " +
        "--datadir=/data --tmpdir=/data/tmp --default-storage-engine=Aria " +
        "--skip-grant-tables --key-buffer-size=1048576 --table-open-cache=10 " +
        "--sort-buffer-size=262144 --skip-networking=0 --port=3306 " +
        "--bind-address=0.0.0.0 --socket= --max-connections=10 " +
        "--log-error=/data/error.log " +
        "--init-file=/etc/mariadb/init.sql",
      dependsOn: ["mariadb-bootstrap"],
      logfile: "/var/log/mariadb.log",
      restart: false,
    },
    {
      name: "wp-config-init",
      type: "scripted",
      command: "/bin/sh /etc/wp-config-init.sh",
      logfile: "/var/log/wp-config-init.log",
      restart: false,
    },
    {
      name: "php-fpm",
      type: "process",
      command: "/usr/sbin/php-fpm -y /etc/php-fpm.conf -c /etc/php.ini --nodaemonize",
      dependsOn: ["mariadb", "wp-config-init"],
      logfile: "/var/log/php-fpm.log",
      restart: false,
    },
    {
      name: "nginx",
      type: "process",
      command: "/usr/sbin/nginx -c /etc/nginx/nginx.conf",
      dependsOn: ["php-fpm"],
      logfile: "/var/log/nginx.log",
      restart: false,
    },
  ];
}

async function main() {
  for (const path of [MARIADB_PATH, NGINX_PATH, PHP_PATH, PHP_FPM_PATH, NODE_PATH]) {
    try { lstatSync(path); } catch { throw new Error(`required binary not found: ${path}`); }
  }

  const sab = new SharedArrayBuffer(WORDPRESS_DEV_INITIAL_FS_BYTES, { maxByteLength: WORDPRESS_DEV_MAX_FS_BYTES });
  const fs = MemoryFileSystem.create(sab, WORDPRESS_DEV_MAX_FS_BYTES);

  console.log("Populating shell environment...");
  populateShellEnvironment(fs, { eagerBinaries: true });
  populateMariadbDataDirs(fs);

  console.log("Writing service binaries and configs...");
  populateMariadb(fs);
  populateNginxConfig(fs);
  populatePhp(fs);
  populateNodeAndNpm(fs);
  populatePhpUnit(fs);

  populateWordPressDevelop(fs);
  populateDevHelpers(fs);

  addDinitInit(fs, buildServices());
  writeKandeloDemoConfig(fs, {
    version: 1,
    profiles: {
      "wordpress-development": { presentation: webPresentation() },
      "wordpress-dev": { presentation: webPresentation() },
    },
  });

  const rev = execFileSync("git", ["-C", WP_DEV_DIR, "rev-parse", "--short=12", "HEAD"], {
    encoding: "utf-8",
  }).trim();
  console.log(`WordPress develop revision: ${rev}`);

  await saveImage(fs, OUT_FILE);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
