#!/usr/bin/env bash
#
# Download WordPress and configure it for MySQL (MariaDB).
# Idempotent — skips downloads if files already exist.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WP_VERSION="${WP_VERSION:-6.7.2}"

WP_DIR="$SCRIPT_DIR/wordpress"

# Download WordPress
if [ ! -f "$WP_DIR/wp-settings.php" ]; then
    echo "==> Downloading WordPress $WP_VERSION..."
    TARBALL="/tmp/wordpress-${WP_VERSION}.tar.gz"
    curl -fsSL "https://wordpress.org/wordpress-${WP_VERSION}.tar.gz" -o "$TARBALL"
    tar xzf "$TARBALL" -C "$SCRIPT_DIR"
    rm "$TARBALL"
    echo "==> WordPress extracted to $WP_DIR"
else
    echo "==> WordPress already present at $WP_DIR"
fi

# Create wp-config.php for MySQL/MariaDB
WP_CONFIG="$WP_DIR/wp-config.php"
if [ ! -f "$WP_CONFIG" ]; then
    echo "==> Creating wp-config.php (MySQL mode)..."
    cat > "$WP_CONFIG" << 'WPCONFIG'
<?php
define('DB_NAME', 'wordpress');
define('DB_USER', 'root');
define('DB_PASSWORD', '');
define('DB_HOST', '127.0.0.1:3306');
define('DB_CHARSET', 'utf8');
define('DB_COLLATE', '');

// Auth keys — not security-sensitive for local dev
define('AUTH_KEY',         'wasm-posix-kernel-lamp');
define('SECURE_AUTH_KEY',  'wasm-posix-kernel-lamp');
define('LOGGED_IN_KEY',    'wasm-posix-kernel-lamp');
define('NONCE_KEY',        'wasm-posix-kernel-lamp');
define('AUTH_SALT',        'wasm-posix-kernel-lamp');
define('SECURE_AUTH_SALT', 'wasm-posix-kernel-lamp');
define('LOGGED_IN_SALT',   'wasm-posix-kernel-lamp');
define('NONCE_SALT',       'wasm-posix-kernel-lamp');

$table_prefix = 'wp_';

define('WP_DEBUG', true);
define('WP_DEBUG_LOG', true);
define('WP_DEBUG_DISPLAY', true);

// Dynamic site URL from request Host header
if (isset($_SERVER['HTTP_HOST'])) {
    define('WP_HOME', 'http://' . $_SERVER['HTTP_HOST']);
    define('WP_SITEURL', 'http://' . $_SERVER['HTTP_HOST']);
}

// Disable external HTTP requests and cron
define('WP_HTTP_BLOCK_EXTERNAL', true);
define('DISABLE_WP_CRON', true);

if ( ! defined( 'ABSPATH' ) ) {
    define( 'ABSPATH', __DIR__ . '/' );
}

require_once ABSPATH . 'wp-settings.php';
WPCONFIG
    echo "==> wp-config.php created (MySQL mode)"
else
    echo "==> wp-config.php already exists"
fi

echo "==> LAMP WordPress setup complete!"
echo "    Start with: npx tsx examples/lamp/serve.ts"
