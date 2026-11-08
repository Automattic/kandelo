/** Exercise an ordinary plugin-style atomic PHP configuration update. */
export const PHP_MUTABLE_CONFIG_PROBE = `<?php
header('Content-Type: application/json');
$directory = sys_get_temp_dir() . '/kandelo-opcache-config-probe';
$module = $directory . '/settings.php';
$phase = $_GET['phase'] ?? '';
$invalidated = null;
if ($phase === 'prime') {
    if (!is_dir($directory) && !mkdir($directory, 0700)) {
        throw new RuntimeException('Cannot create probe directory');
    }
    if (file_put_contents($module, '<?php return "before";') === false || !touch($module, time() - 30)) {
        throw new RuntimeException('Cannot write initial configuration');
    }
    $value = include $module;
} elseif ($phase === 'replace' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    $temporary = tempnam($directory, 'config-');
    if ($temporary === false || file_put_contents($temporary, '<?php return "after";') === false
        || !touch($temporary, time()) || !rename($temporary, $module)) {
        throw new RuntimeException('Cannot replace configuration');
    }
    // A file-cache-only runtime must observe the edit even if this API
    // cannot invalidate an in-memory accelerator entry.
    $invalidated = opcache_invalidate($module, true);
    $value = 'written';
} elseif ($phase === 'read') {
    $value = include $module;
} else {
    http_response_code(400);
    throw new RuntimeException('Unknown probe operation');
}
echo json_encode([
    'value' => $value,
    'fileCacheOnly' => ini_get('opcache.file_cache_only') === '1',
    'validateTimestamps' => ini_get('opcache.validate_timestamps') === '1',
    'cacheFilePresent' => count(glob(ini_get('opcache.file_cache') . '/*' . $module . '.bin')) > 0,
    'invalidated' => $invalidated,
], JSON_THROW_ON_ERROR);
`;
