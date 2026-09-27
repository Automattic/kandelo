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
      "define('DB_HOST', 'localhost');",
      "define('KANDELO_MYSQLI_PERSISTENT', true);",
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

/**
 * The machine's WordPress keys and salts (`AUTH_KEY` ... `NONCE_SALT`), which
 * sign login cookies and nonces. They are not in the image: the image is
 * byte-reproducible, so anything it carries is known to everyone who can
 * build or download it, and every machine booted from it would share them.
 * The image's `wordpress-secrets` first-boot service writes this file from
 * the machine's own entropy before PHP-FPM starts, and keeps it on later
 * boots of the same machine (`images/vfs/scripts/wordpress-first-boot.ts`).
 * Until then it is a placeholder that stops WordPress with an explanation,
 * never a silent fallback.
 */
export const WORDPRESS_SECRETS_PATH = "/etc/kandelo/wordpress-secrets.php";

/** The eight constants `WORDPRESS_SECRETS_PATH` defines. */
export const WORDPRESS_SECRET_NAMES = [
  "AUTH_KEY",
  "SECURE_AUTH_KEY",
  "LOGGED_IN_KEY",
  "NONCE_KEY",
  "AUTH_SALT",
  "SECURE_AUTH_SALT",
  "LOGGED_IN_SALT",
  "NONCE_SALT",
] as const;

/**
 * An mu-plugin that turns off WordPress's periodic "Administration email
 * verification" screen for the demo images.
 *
 * The images are installed by a deterministic build whose clock reads
 * SOURCE_DATE_EPOCH (1980-01-01 in the dev shell), so the install records an
 * `admin_email_lifespan` decades in the past and WordPress interrupts every
 * login to ask whether `admin@example.com` is still correct. That address is
 * a placeholder nobody receives mail at, so the check has no meaning here,
 * and the demo's own "Log in as admin" action would stop at the question.
 * A site someone runs for real would keep the check.
 */
export const WORDPRESS_DEMO_ADMIN_EMAIL_MU_PLUGIN_PATH =
  "/var/www/html/wp-content/mu-plugins/kandelo-admin-email.php";
export const WORDPRESS_DEMO_ADMIN_EMAIL_MU_PLUGIN = `<?php
// Kandelo demo images: the admin email is a placeholder and the install date
// is the build's fixed epoch, so WordPress's admin email re-verification
// prompt carries no meaning. See wordpress-runtime-config.ts.
add_filter( 'admin_email_check_interval', '__return_zero' );
`;

export function wordpressConfigTemplate(kind: WordPressDatabaseKind): string {
  return `<?php
${dbConfig(kind)}
define('DB_CHARSET', 'utf8');
define('DB_COLLATE', '');

// Keys and salts are per machine, generated on its first boot. The image
// build's installer defines public placeholders itself before loading this
// file, which is the only case in which they are already defined.
if ( ! defined( 'AUTH_KEY' ) ) {
    require '${WORDPRESS_SECRETS_PATH}';
}

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

if ( defined( 'WP_INSTALLING' ) && WP_INSTALLING && ! function_exists( 'wp_new_blog_notification' ) ) {
    function wp_new_blog_notification( $blog_title, $blog_url, $user_id, $password ) {
        return true;
    }
}

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

const MYSQLI_REAL_CONNECT_HOST_ARG = "mysqli_real_connect( $this->dbh, $host, $this->dbuser";
const MYSQLI_PERSISTENT_HOST_EXPR =
  "( defined( 'KANDELO_MYSQLI_PERSISTENT' ) && KANDELO_MYSQLI_PERSISTENT && 0 !== strpos( $host, 'p:' ) ) ? 'p:' . $host : $host";

export function patchWordPressMysqliPersistentSource(source: string): string {
  if (source.includes(MYSQLI_PERSISTENT_HOST_EXPR)) {
    return source;
  }
  return source.replaceAll(
    MYSQLI_REAL_CONNECT_HOST_ARG,
    `mysqli_real_connect( $this->dbh, ${MYSQLI_PERSISTENT_HOST_EXPR}, $this->dbuser`,
  );
}
