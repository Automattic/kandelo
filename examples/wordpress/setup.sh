#!/usr/bin/env bash
#
# Download WordPress + SQLite Database Integration plugin.
# Idempotent — skips downloads if files already exist.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WP_VERSION="${WP_VERSION:-6.7.2}"
SQLITE_PLUGIN_VERSION="${SQLITE_PLUGIN_VERSION:-2.1.16}"

WP_DIR="$SCRIPT_DIR/wordpress"
SQLITE_DIR="$SCRIPT_DIR/sqlite-database-integration"

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

# Download SQLite Database Integration plugin
if [ ! -f "$SQLITE_DIR/load.php" ]; then
    echo "==> Downloading SQLite Database Integration $SQLITE_PLUGIN_VERSION..."
    ZIP="/tmp/sqlite-database-integration.zip"
    curl -fsSL "https://downloads.wordpress.org/plugin/sqlite-database-integration.${SQLITE_PLUGIN_VERSION}.zip" -o "$ZIP"
    unzip -qo "$ZIP" -d "$SCRIPT_DIR"
    rm "$ZIP"
    echo "==> SQLite plugin extracted to $SQLITE_DIR"
else
    echo "==> SQLite plugin already present at $SQLITE_DIR"
fi

# Install the SQLite db.php drop-in
DB_PHP="$WP_DIR/wp-content/db.php"
if [ ! -f "$DB_PHP" ]; then
    echo "==> Installing db.php drop-in..."
    # db.copy is the template; its fallback path looks for the plugin at
    # wp-content/plugins/sqlite-database-integration/
    cp "$SQLITE_DIR/db.copy" "$DB_PHP"
    echo "==> db.php installed"
else
    echo "==> db.php already installed"
fi

# Install plugin into wp-content/plugins/ so the db.php fallback path finds it
PLUGIN_DST="$WP_DIR/wp-content/plugins/sqlite-database-integration"
if [ ! -d "$PLUGIN_DST" ]; then
    echo "==> Symlinking SQLite plugin into wp-content/plugins/..."
    ln -s "$SQLITE_DIR" "$PLUGIN_DST"
fi

# Create wp-config.php if it doesn't exist
WP_CONFIG="$WP_DIR/wp-config.php"
if [ ! -f "$WP_CONFIG" ]; then
    echo "==> Creating wp-config.php..."
    cat > "$WP_CONFIG" << 'WPCONFIG'
<?php
define('DB_NAME', 'wordpress');
define('DB_USER', '');
define('DB_PASSWORD', '');
define('DB_HOST', '');
define('DB_CHARSET', 'utf8');
define('DB_COLLATE', '');

// SQLite database path
define('DB_DIR', __DIR__ . '/wp-content/database/');
define('DB_FILE', 'wordpress.db');

// Auth keys — not security-sensitive for local dev
define('AUTH_KEY',         'wasm-posix-kernel-dev');
define('SECURE_AUTH_KEY',  'wasm-posix-kernel-dev');
define('LOGGED_IN_KEY',    'wasm-posix-kernel-dev');
define('NONCE_KEY',        'wasm-posix-kernel-dev');
define('AUTH_SALT',        'wasm-posix-kernel-dev');
define('SECURE_AUTH_SALT', 'wasm-posix-kernel-dev');
define('LOGGED_IN_SALT',   'wasm-posix-kernel-dev');
define('NONCE_SALT',       'wasm-posix-kernel-dev');

$table_prefix = 'wp_';

define('WP_DEBUG', true);
define('WP_DEBUG_LOG', true);
define('WP_DEBUG_DISPLAY', true);

// Disable external HTTP requests (no network needed for install)
define('WP_HTTP_BLOCK_EXTERNAL', true);

// Disable cron (no background processes)
define('DISABLE_WP_CRON', true);

if ( ! defined( 'ABSPATH' ) ) {
    define( 'ABSPATH', __DIR__ . '/' );
}

require_once ABSPATH . 'wp-settings.php';
WPCONFIG
    echo "==> wp-config.php created"
else
    echo "==> wp-config.php already exists"
fi

# Create database directory
mkdir -p "$WP_DIR/wp-content/database"

echo "==> WordPress setup complete!"
