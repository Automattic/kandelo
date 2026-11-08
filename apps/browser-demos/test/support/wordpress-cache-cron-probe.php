<?php
// Test-owned observation endpoint; never installed in a product image.
require __DIR__ . '/wp-load.php';
if (!current_user_can('manage_options')) {
    status_header(403);
    exit;
}
header('Content-Type: application/json');
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    wp_clear_scheduled_hook('wp_cache_gc');
    $scheduled = wp_schedule_single_event(time() - 1, 'wp_cache_gc', array(), true);
    if (is_wp_error($scheduled) || !$scheduled) {
        throw new RuntimeException('Could not schedule the stock cache GC hook.');
    }
}
$files = array();
$root = WP_CONTENT_DIR . '/cache/supercache';
if (is_dir($root)) {
    $iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS));
    foreach ($iterator as $file) {
        if ($file->isFile() && $file->getFilename() === 'index.html') {
            $files[] = array('path' => $file->getPathname(), 'mtime' => $file->getMTime());
        }
    }
}
echo json_encode(array('now' => time(), 'lastGc' => (int) get_option('wpsupercache_gc_time', 0),
    'nextGc' => wp_next_scheduled('wp_cache_gc'), 'files' => $files), JSON_THROW_ON_ERROR);
