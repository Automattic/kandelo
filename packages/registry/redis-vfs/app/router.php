<?php
// A real guest HTTP service talking RESP to the guest Redis server. No PHP
// Redis extension or browser-side persistence is needed for the board.
declare(strict_types=1);

function redisReply($socket): mixed {
    $line = fgets($socket, 1024);
    if ($line === false || !str_ends_with($line, "\r\n")) {
        throw new RuntimeException('Redis connection closed or timed out');
    }
    $value = substr($line, 1, -2);
    switch ($line[0]) {
        case '+': return $value;
        case '-': throw new RuntimeException('Redis: ' . $value);
        case ':': return (int) $value;
        case '$':
            $length = (int) $value;
            if ($length === -1) return null;
            if ($length < 0 || $length > 65536) throw new RuntimeException('Invalid Redis bulk reply');
            $data = '';
            while (strlen($data) < $length + 2) {
                $part = fread($socket, $length + 2 - strlen($data));
                if ($part === false || $part === '') throw new RuntimeException('Incomplete Redis reply');
                $data .= $part;
            }
            if (substr($data, -2) !== "\r\n") throw new RuntimeException('Invalid Redis bulk terminator');
            return substr($data, 0, -2);
        case '*':
            $length = (int) $value;
            if ($length === -1) return null;
            if ($length < 0 || $length > 512) throw new RuntimeException('Invalid Redis array reply');
            $items = [];
            for ($i = 0; $i < $length; $i++) $items[] = redisReply($socket);
            return $items;
        default: throw new RuntimeException('Invalid Redis reply');
    }
}

function redisCommand($socket, array $args): mixed {
    $request = '*' . count($args) . "\r\n";
    foreach ($args as $arg) {
        $arg = (string) $arg;
        $request .= '$' . strlen($arg) . "\r\n" . $arg . "\r\n";
    }
    for ($offset = 0; $offset < strlen($request); $offset += $written) {
        $written = fwrite($socket, substr($request, $offset));
        if ($written === false || $written === 0) throw new RuntimeException('Cannot write to Redis');
    }
    return redisReply($socket);
}

function jsonResponse(int $status, array $body): never {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($body, JSON_THROW_ON_ERROR | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$method = $_SERVER['REQUEST_METHOD'];
// Let PHP's normal built-in server execute upstream's entry point and serve
// its public assets. Configuration, templates and Phar sources stay private.
if ($path === '/admin/' || $path === '/admin/index.php') return false;
if (is_string($path) && preg_match('~^/admin/assets/[a-zA-Z0-9_./-]+\.(css|js|json|svg|png|woff2?|ico)$~D', $path)) {
    $file = realpath(__DIR__ . $path);
    if ($file !== false && str_starts_with($file, __DIR__ . '/admin/assets/') && is_file($file)) return false;
}
if ($path === '/' || $path === '/index.html') {
    if ($method !== 'GET' && $method !== 'HEAD') jsonResponse(405, ['error' => 'Use GET']);
    header('Content-Type: text/html; charset=utf-8');
    header('Cache-Control: no-store');
    if ($method === 'GET') readfile(__DIR__ . '/index.html');
    exit;
}
if ($path !== '/api' && $path !== '/health') jsonResponse(404, ['error' => 'Not found']);
if ($method !== 'GET' && ($method !== 'POST' || $path !== '/api')) {
    jsonResponse(405, ['error' => 'Use GET or POST']);
}

try {
    $socket = @stream_socket_client('tcp://127.0.0.1:6379', $errno, $error, 3);
    if ($socket === false) throw new RuntimeException('Redis is unavailable');
    stream_set_timeout($socket, 3);
    if ($path === '/health') {
        redisCommand($socket, ['PING']);
        jsonResponse(200, ['ready' => true]);
    }
    // Initialization and each mutation are atomic even if another client
    // connects directly to Redis while the HTTP service is handling a request.
    redisCommand($socket, ['EVAL', <<<'LUA'
if redis.call('SET', KEYS[1], '1', 'NX') then
  redis.call('SET', KEYS[2], '3')
  redis.call('HSET', KEYS[3], '1', 'Play a round of Quake', '2', 'Build a tiny website', '3', 'Start a Freeciv empire')
  redis.call('ZADD', KEYS[4], 0, '1', 0, '2', 0, '3')
end
return 1
LUA, 4, 'board:initialized', 'board:sequence', 'board:ideas', 'board:votes']);

    if ($method === 'POST') {
        if (strtolower(trim(explode(';', $_SERVER['CONTENT_TYPE'] ?? '')[0])) !== 'application/json') {
            jsonResponse(415, ['error' => 'Send JSON']);
        }
        $body = file_get_contents('php://input', false, null, 0, 1025);
        if (strlen($body) > 1024) jsonResponse(413, ['error' => 'Request is too large']);
        try { $input = json_decode($body, true, 8, JSON_THROW_ON_ERROR); }
        catch (JsonException $error) { jsonResponse(400, ['error' => 'Invalid JSON']); }
        if (!is_array($input)) jsonResponse(400, ['error' => 'Expected an object']);
        if (($input['action'] ?? '') === 'add') {
            $title = is_string($input['title'] ?? null) ? trim($input['title']) : '';
            if ($title === '' || strlen($title) > 160 || preg_match('/[\x00-\x1f\x7f]/', $title)) {
                jsonResponse(400, ['error' => 'Use a short, nonempty idea (up to 160 bytes)']);
            }
            $id = redisCommand($socket, ['EVAL', <<<'LUA'
if redis.call('HLEN', KEYS[1]) >= 50 then return false end
local id = tostring(redis.call('INCR', KEYS[2]))
redis.call('HSET', KEYS[1], id, ARGV[1])
redis.call('ZADD', KEYS[3], 0, id)
return id
LUA, 3, 'board:ideas', 'board:sequence', 'board:votes', $title]);
            if ($id === null) jsonResponse(409, ['error' => 'This board has reached its 50-idea limit']);
        } elseif (($input['action'] ?? '') === 'vote') {
            $id = $input['id'] ?? '';
            if (!is_string($id) || !preg_match('/^[1-9][0-9]{0,9}$/D', $id)) {
                jsonResponse(400, ['error' => 'Invalid idea']);
            }
            $score = redisCommand($socket, ['EVAL', <<<'LUA'
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 0 then return false end
return redis.call('ZINCRBY', KEYS[2], 1, ARGV[1])
LUA, 2, 'board:ideas', 'board:votes', $id]);
            if ($score === null) jsonResponse(404, ['error' => 'That idea no longer exists']);
        } else jsonResponse(400, ['error' => 'Unknown action']);
    }
    $rows = redisCommand($socket, ['EVAL', <<<'LUA'
local ranked = redis.call('ZREVRANGE', KEYS[1], 0, 49, 'WITHSCORES')
local result = {}
for i = 1, #ranked, 2 do
  table.insert(result, {ranked[i], redis.call('HGET', KEYS[2], ranked[i]), ranked[i + 1]})
end
return result
LUA, 2, 'board:votes', 'board:ideas']);
    $ideas = array_map(fn($row) => ['id' => $row[0], 'title' => $row[1], 'votes' => (int) $row[2]], $rows);
    fclose($socket);
    jsonResponse(200, ['ideas' => $ideas]);
} catch (Throwable $error) {
    error_log((string) $error);
    jsonResponse(503, ['error' => 'The board could not reach Redis. Try again shortly.']);
}
