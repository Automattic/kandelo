<?php
// Native Spacefast PHP Function: sf_auth() is verified by the platform before
// tenant code runs. Never accept a caller's userId, guestId, or forwarding IP.
declare(strict_types=1);

header('Cache-Control: no-store');
header('Cross-Origin-Resource-Policy: cross-origin');
header('Vary: Origin, Referer');
$approved = __KANDELO_APPROVED_ORIGINS__;
$host = $_SERVER['HTTP_HOST'] ?? '';
$scheme = ($_SERVER['HTTPS'] ?? '') === 'on' ? 'https' : 'http';
$selfOrigin = $scheme . '://' . $host;
$approved ??= [$selfOrigin];
$origin = $_SERVER['HTTP_ORIGIN'] ?? null;
$referer = $_SERVER['HTTP_REFERER'] ?? null;
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
function proxy_origin(?string $value): ?string {
    if ($value === null) return null;
    $url = parse_url($value);
    if (!is_array($url) || !in_array($url['scheme'] ?? '', ['http', 'https'], true)
        || !isset($url['host']) || isset($url['user']) || isset($url['pass']) || isset($url['fragment'])) return null;
    $port = isset($url['port']) && !(($url['scheme'] === 'https' && $url['port'] === 443)
        || ($url['scheme'] === 'http' && $url['port'] === 80)) ? ':' . $url['port'] : '';
    return $url['scheme'] . '://' . strtolower($url['host']) . $port;
}
if ($origin !== null && in_array($origin, $approved, true)) {
    header('Access-Control-Allow-Origin: ' . $origin);
    header('Access-Control-Allow-Methods: GET, OPTIONS');
}
$refererOrigin = proxy_origin($referer);
$admitted = $origin === null || in_array($origin, $approved, true);
$admitted = $admitted && ($method === 'OPTIONS'
    ? $origin !== null && ($referer === null || $refererOrigin === $origin)
    : $refererOrigin !== null && in_array($refererOrigin, $approved, true)
        && ($origin === null || $origin === $refererOrigin));
if (!$admitted) sf_json(['error' => 'Forbidden: unapproved Referer origin'], 403);
if ($method === 'OPTIONS') { http_response_code(204); return; }
if ($method !== 'GET') { header('Allow: GET, OPTIONS'); sf_json(['error' => 'Method Not Allowed'], 405); }

try {
    $auth = sf_auth();
    $id = $auth['userId'] ?? null;
    $guest = ($auth['isGuest'] ?? false) === true;
    if (!is_string($id) || strlen($id) > 256 || ($guest
        ? preg_match('/^guest:anon_[a-f0-9]{32}$/D', $id) !== 1
        : !($auth['isAuthenticated'] ?? false) || $id === '' || str_starts_with($id, 'guest:'))) {
        throw new RuntimeException('Verified identity unavailable');
    }
    $db = sf_db();
    $db->execute('CREATE TABLE IF NOT EXISTS kandelo_cors_proxy_session_key_v1 (id INT PRIMARY KEY, secret CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL)');
    $db->execute('INSERT IGNORE INTO kandelo_cors_proxy_session_key_v1 (id, secret) VALUES (1, ?)', [bin2hex(random_bytes(32))]);
    $secret = $db->query('SELECT secret FROM kandelo_cors_proxy_session_key_v1 WHERE id = 1')[0]['secret'] ?? null;
    if (!is_string($secret) || preg_match('/^[a-f0-9]{64}$/D', $secret) !== 1) throw new RuntimeException('Session key unavailable');
    // Fixed-size pseudonym keeps raw Spacefast identities out of the browser
    // protocol and the budget table. Reissuing a token preserves its budget.
    $subject = substr(hash_hmac('sha256', 'identity:' . $id, hex2bin($secret)), 0, 32);
    $expires = time() + 30 * 86400;
    $unsigned = 'v1.' . $subject . '.' . $expires;
    $signature = hash_hmac('sha256', "kandelo-cors-proxy\n" . $selfOrigin . "\n" . $unsigned, hex2bin($secret));
    sf_json(['token' => $unsigned . '.' . $signature, 'expiresAt' => $expires]);
} catch (Throwable $error) {
    // Never disclose SQL, platform auth records, or signing material.
    sf_json(['error' => 'Proxy session unavailable'], 503);
}
