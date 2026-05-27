export type WordPressDatabaseKind = "sqlite" | "mariadb";

export const WORDPRESS_CONFIG_INIT_SCRIPT = `# wp-config.php is rendered into the VFS by the browser host before dinit starts.
: "\${WP_APP_PATH:=/app}"
: "\${WP_PROTO:=http}"
echo "wp-config-init: APP_PATH=$WP_APP_PATH PROTO=$WP_PROTO"
`;

export const WORDPRESS_URL_MU_PLUGIN = `<?php
if ( defined( 'WP_HOME' ) ) {
    add_filter( 'pre_option_home', static function () { return WP_HOME; } );
    add_filter( 'option_home', static function () { return WP_HOME; } );
}
if ( defined( 'WP_SITEURL' ) ) {
    add_filter( 'pre_option_siteurl', static function () { return WP_SITEURL; } );
    add_filter( 'option_siteurl', static function () { return WP_SITEURL; } );
}
`;

function dbConfig(kind: WordPressDatabaseKind): string {
  if (kind === "mariadb") {
    return [
      "define('DB_NAME', 'wordpress');",
      "define('DB_USER', 'root');",
      "define('DB_PASSWORD', '');",
      "define('DB_HOST', '127.0.0.1:3306');",
    ].join("\n");
  }

  return [
    "define('DB_NAME', 'wordpress');",
    "define('DB_USER', '');",
    "define('DB_PASSWORD', '');",
    "define('DB_HOST', '');",
    "",
    "define('DB_DIR', __DIR__ . '/wp-content/database/');",
    "define('DB_FILE', 'wordpress.db');",
  ].join("\n");
}

function authSeed(kind: WordPressDatabaseKind): string {
  return kind === "mariadb" ? "wasm-posix-kernel-lamp" : "wasm-posix-kernel-dev";
}

export function wordpressConfigTemplate(kind: WordPressDatabaseKind): string {
  const seed = authSeed(kind);
  return `<?php
${dbConfig(kind)}
define('DB_CHARSET', 'utf8');
define('DB_COLLATE', '');

define('AUTH_KEY',         '${seed}');
define('SECURE_AUTH_KEY',  '${seed}');
define('LOGGED_IN_KEY',    '${seed}');
define('NONCE_KEY',        '${seed}');
define('AUTH_SALT',        '${seed}');
define('SECURE_AUTH_SALT', '${seed}');
define('LOGGED_IN_SALT',   '${seed}');
define('NONCE_SALT',       '${seed}');

$table_prefix = 'wp_';

define('WP_DEBUG', true);
define('WP_DEBUG_LOG', true);
define('WP_DEBUG_DISPLAY', false);
@ini_set('display_errors', '0');

$kandelo_proto = '@@PROTO@@';
$kandelo_app_path = rtrim('@@APP_PATH@@', '/');
$kandelo_host = $_SERVER['HTTP_X_FORWARDED_HOST'] ?? $_SERVER['HTTP_HOST'] ?? 'localhost';
$_SERVER['HTTP_HOST'] = $kandelo_host;

if ($kandelo_proto === 'https') {
    $_SERVER['HTTPS'] = 'on';
    $_SERVER['REQUEST_SCHEME'] = 'https';
    $_SERVER['SERVER_PORT'] = '443';
    define('FORCE_SSL_ADMIN', true);
}

$kandelo_site_url = $kandelo_proto . '://' . $kandelo_host . $kandelo_app_path;
define('WP_HOME', $kandelo_site_url);
define('WP_SITEURL', $kandelo_site_url);

define('WP_HTTP_BLOCK_EXTERNAL', true);
define('DISABLE_WP_CRON', true);

if ( ! defined( 'ABSPATH' ) ) {
    define( 'ABSPATH', __DIR__ . '/' );
}

require_once ABSPATH . 'wp-settings.php';
`;
}

export function renderWordPressConfig(
  kind: WordPressDatabaseKind,
  appPath: string,
  proto: string,
): string {
  return wordpressConfigTemplate(kind)
    .replaceAll("@@APP_PATH@@", phpSingleQuotedContent(appPath))
    .replaceAll("@@PROTO@@", phpSingleQuotedContent(proto));
}

function phpSingleQuotedContent(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
