<?php
/**
 * Router script for PHP's built-in server.
 * Maps URL paths to WordPress files, serving static assets directly
 * and routing everything else through WordPress's index.php.
 */
$uri = urldecode(parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH));

// Serve static files directly if they exist
if ($uri !== '/' && file_exists(__DIR__ . '/wordpress' . $uri)) {
    return false;
}

// Route all other requests through WordPress
chdir(__DIR__ . '/wordpress');
require __DIR__ . '/wordpress/index.php';
