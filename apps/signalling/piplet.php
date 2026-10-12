<?php

/**
 * The Kandelo signalling piplet.
 *
 * One self-modifying PHP file, in the spirit of WordPress/piplets: the
 * sessions live as JSON after `__halt_compiler()`, so there is no database,
 * package install, build step, or second file. Anything that serves PHP —
 * `php -S`, php-fpm behind a shared host, or PHP inside Kandelo itself —
 * is a complete deployment. Needs 64-bit PHP 8.3 or newer, and the server
 * user must be able to write the file's directory: a save writes a
 * temporary snapshot beside the file and atomically renames it into place.
 * The file rewrites itself on every session, so deploy a copy, not the
 * repository file:
 *
 *   cp piplet.php /srv/signalling/piplet.php
 *   php -S 0.0.0.0:8787 /srv/signalling/piplet.php
 *
 * It replaces the humans in the manually signalled WebRTC flow and nothing
 * more. One computer hosts a session under a chosen name and leaves its
 * invite code; the other asks for that name, takes the invite, and leaves
 * its answer code; the host polls the name until the answer appears. The
 * two codes are the same two `kandelo1:` strings the copy-paste flow
 * carries, and every byte of the machine still crosses the peer link —
 * this file only ever holds the two session descriptions. It does not
 * replace STUN: the peer link still learns each computer's public address
 * from its configured STUN servers, and two NATs that refuse a direct
 * route still fail at the ICE boundary.
 *
 * A session name is lowercase words separated by dashes — any number of
 * words, letters only, 64 characters at most, `^[a-z]+(-[a-z]+)*$`.
 * Clients must enforce the same rule before sending. The name is also the only
 * secret: whoever knows it can read the codes (which contain the peers'
 * addresses) or answer first — gaining a WebRTC link to a stranger, never
 * the machine's data, while the host sees a failed connection. Pick an
 * unguessable name for a session that crosses the open internet, and
 * serve this file over HTTPS so the codes do not travel in the clear.
 *
 * API, all JSON, all CORS-open:
 *
 *   GET  ?session=NAME              the session, or 404
 *   POST ?session=NAME&role=offer   host a session (replaces any previous)
 *   POST ?session=NAME&role=answer  answer a hosted session, once
 *
 * A code starts with `kandelo1:` and fits in 64 KiB. Sessions expire
 * after ten minutes; signalling either finished long before that or never
 * will.
 *
 * Rooms match any number of computers to one hosting computer, the centre
 * of a star network. The host keeps the room alive by checking in; each
 * joiner leaves its own invite under a join token and waits for the host's
 * answer. A room token travels in the link people share, so it opens the
 * room to joiners only: everything the host does also needs the host key,
 * which never leaves the hosting computer and is stored here only hashed.
 * Room tokens, join tokens and host keys are 20 to 64 lowercase letters;
 * generate them randomly.
 *
 *   GET  ?room=ROOM                         the room's name, or 404
 *   POST ?room=ROOM&role=host               create or keep the room; body
 *                                           {"name": ...}; returns joins
 *                                           still waiting for an answer
 *   POST ?room=ROOM&role=join&join=JOIN     leave a joiner's invite
 *   GET  ?room=ROOM&join=JOIN               the host's answer or refusal
 *   POST ?room=ROOM&role=answer&join=JOIN   answer one joiner
 *   POST ?room=ROOM&role=refuse&join=JOIN   refuse one joiner; body reason
 *   POST ?room=ROOM&role=close              end the room
 *
 * Host requests carry the host key in an `X-Kandelo-Host-Key` header. A
 * room ends 60 seconds after its host stops checking in, an unanswered join
 * after two minutes. A room holds at most 8 waiting joins, the server at
 * most 256 rooms and 8 MiB of codes; beyond that it answers 503. Test with
 * `composer install && composer test`.
 */

const MATCH_SESSION_TTL_SECONDS = 600;
const MATCH_MAX_CODE_BYTES = 65536;
const MATCH_MAX_SESSIONS = 256;
const MATCH_NAME_PATTERN = '/^(?=.{1,64}$)[a-z]+(?:-[a-z]+)*$/D';
const MATCH_CODE_PREFIX = 'kandelo1:';
const MATCH_LOCK_DEADLINE_SECONDS = 2.0;
const MATCH_TOKEN_PATTERN = '/^[a-z]{20,64}$/D';
const MATCH_ROOM_TTL_SECONDS = 60;
const MATCH_JOIN_TTL_SECONDS = 120;
const MATCH_MAX_ROOMS = 256;
const MATCH_MAX_WAITING_JOINS = 8;
const MATCH_MAX_STORE_BYTES = 8 * 1024 * 1024;
const MATCH_MAX_ROOM_NAME_CHARS = 64;
const MATCH_MAX_REFUSAL_BYTES = 256;

final class MatchHttpError extends Exception
{
    public function __construct(public readonly int $status, string $message)
    {
        parent::__construct($message);
    }
}

function match_headers(): void
{
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, X-Kandelo-Host-Key');
    header('Cross-Origin-Resource-Policy: cross-origin');
}

function match_json(array $payload, int $status = 200): never
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_SLASHES), "\n";
    exit;
}

function match_expired(array $session, int $now): bool
{
    return $session['created'] + MATCH_SESSION_TTL_SECONDS <= $now;
}

function match_room_expired(array $room, int $now): bool
{
    return $room['touched'] + MATCH_ROOM_TTL_SECONDS <= $now;
}

function match_read_store(): array
{
    $file = file_get_contents(__FILE__);
    if ($file === false) {
        throw new MatchHttpError(500, 'the session store cannot be read');
    }
    $data = json_decode(substr($file, __COMPILER_HALT_OFFSET__), true);
    if (!is_array($data) || !is_array($data['sessions'] ?? null)
        || !is_array($data['rooms'] ?? [])) {
        throw new MatchHttpError(500, 'the session store is corrupt');
    }
    return ['sessions' => $data['sessions'], 'rooms' => $data['rooms'] ?? []];
}

function match_read_sessions(): array
{
    return match_read_store()['sessions'];
}

/** Drop expired rooms and each room's expired joins. */
function match_prune_rooms(array $rooms, int $now): array
{
    $live = [];
    foreach ($rooms as $id => $room) {
        if (match_room_expired($room, $now)) {
            continue;
        }
        $room['joins'] = array_filter(
            $room['joins'],
            fn (array $join) => $join['created'] + MATCH_JOIN_TTL_SECONDS > $now,
        );
        $live[$id] = $room;
    }
    return $live;
}

function match_open_locked()
{
    $deadline = microtime(true) + MATCH_LOCK_DEADLINE_SECONDS;
    while (true) {
        $handle = fopen(__FILE__, 'r');
        if ($handle === false) {
            throw new MatchHttpError(500, 'the session store cannot be opened');
        }
        while (!flock($handle, LOCK_EX | LOCK_NB)) {
            if (microtime(true) > $deadline) {
                fclose($handle);
                header('Retry-After: 1');
                throw new MatchHttpError(503, 'the session store is busy');
            }
            usleep(20000);
        }
        $open = fstat($handle);
        $path = stat(__FILE__);
        if ($open !== false && $path !== false && $open['ino'] === $path['ino']) {
            return $handle;
        }
        flock($handle, LOCK_UN);
        fclose($handle);
    }
}

function match_mutate(callable $mutate): void
{
    $handle = match_open_locked();
    try {
        $store = match_read_store();
        $mutate($store);
        $now = time();
        $sessions = array_filter(
            $store['sessions'],
            fn (array $session) => !match_expired($session, $now),
        );
        $rooms = match_prune_rooms($store['rooms'], $now);
        $prefix = fread($handle, __COMPILER_HALT_OFFSET__);
        if ($prefix === false || strlen($prefix) !== __COMPILER_HALT_OFFSET__) {
            throw new MatchHttpError(500, 'the session store cannot be read');
        }
        $trailer = "\n" . json_encode(
            ['sessions' => (object) $sessions, 'rooms' => (object) $rooms],
            JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR,
        ) . "\n";
        if (strlen($trailer) > MATCH_MAX_STORE_BYTES) {
            throw new MatchHttpError(503, 'the signalling server is full');
        }
        $temporary = __DIR__ . '/.piplet-tmp-' . bin2hex(random_bytes(8)) . '.php';
        $out = fopen($temporary, 'x');
        if ($out === false) {
            throw new MatchHttpError(500, 'the session store cannot be written');
        }
        $content = $prefix . $trailer;
        $written = fwrite($out, $content) === strlen($content)
            && fflush($out)
            && fsync($out)
            && chmod($temporary, fileperms(__FILE__) & 0777)
            && rename($temporary, __FILE__);
        fclose($out);
        if (!$written) {
            @unlink($temporary);
            throw new MatchHttpError(500, 'the session store cannot be written');
        }
    } finally {
        flock($handle, LOCK_UN);
        fclose($handle);
    }
}

function match_code(): string
{
    $code = file_get_contents('php://input', false, null, 0, MATCH_MAX_CODE_BYTES + 1);
    if ($code === false || $code === '' || strlen($code) > MATCH_MAX_CODE_BYTES) {
        throw new MatchHttpError(413, 'a connect code must be 1 to 65536 bytes');
    }
    $code = trim($code);
    if (!str_starts_with($code, MATCH_CODE_PREFIX)) {
        throw new MatchHttpError(422, 'this is not a Kandelo connect code');
    }
    return $code;
}

function match_token(string $parameter, string $what): string
{
    $token = $_GET[$parameter] ?? '';
    if (!is_string($token) || preg_match(MATCH_TOKEN_PATTERN, $token) !== 1) {
        throw new MatchHttpError(422, "a $what is 20 to 64 lowercase letters");
    }
    return $token;
}

function match_host_key_hash(): string
{
    $key = $_SERVER['HTTP_X_KANDELO_HOST_KEY'] ?? '';
    if (!is_string($key) || preg_match(MATCH_TOKEN_PATTERN, $key) !== 1) {
        throw new MatchHttpError(401, 'the host key is 20 to 64 lowercase letters');
    }
    return hash('sha256', $key);
}

/** The room's display name: printable text, 1 to 64 characters. */
function match_room_name(): string
{
    $body = file_get_contents('php://input', false, null, 0, 4097);
    $payload = is_string($body) ? json_decode($body, true) : null;
    $name = is_array($payload) ? ($payload['name'] ?? null) : null;
    if (!is_string($name)) {
        throw new MatchHttpError(422, 'a room needs a name');
    }
    $name = trim(preg_replace('/[\x00-\x1F\x7F]/u', '', $name) ?? '');
    if ($name === '' || mb_strlen($name) > MATCH_MAX_ROOM_NAME_CHARS) {
        throw new MatchHttpError(422, 'a room name is 1 to 64 printable characters');
    }
    return $name;
}

/** The room a host request addresses, after proving the host key. */
function &match_hosted_room(array &$rooms, string $room, string $keyHash): array
{
    if (!isset($rooms[$room]) || match_room_expired($rooms[$room], time())) {
        throw new MatchHttpError(404, 'no such room');
    }
    if (!hash_equals($rooms[$room]['key'], $keyHash)) {
        throw new MatchHttpError(403, 'this is not the room\'s host');
    }
    return $rooms[$room];
}

function match_run_room(string $method, string $room): never
{
    $role = $_GET['role'] ?? '';
    if ($method === 'GET') {
        $rooms = match_prune_rooms(match_read_store()['rooms'], time());
        if (!isset($rooms[$room])) {
            throw new MatchHttpError(404, 'no such room');
        }
        if (!isset($_GET['join'])) {
            match_json(['room' => $room, 'name' => $rooms[$room]['name']]);
        }
        $join = match_token('join', 'join token');
        $entry = $rooms[$room]['joins'][$join] ?? null;
        if ($entry === null) {
            throw new MatchHttpError(404, 'no such join');
        }
        match_json(['answer' => $entry['answer'], 'refused' => $entry['refused']]);
    }
    if ($method !== 'POST') {
        header('Allow: GET, POST, OPTIONS');
        throw new MatchHttpError(405, 'use GET, POST, or OPTIONS');
    }
    if ($role === 'join') {
        $join = match_token('join', 'join token');
        $code = match_code();
        match_mutate(function (array &$store) use ($room, $join, $code): void {
            $rooms = match_prune_rooms($store['rooms'], time());
            if (!isset($rooms[$room])) {
                throw new MatchHttpError(404, 'no such room');
            }
            if (isset($rooms[$room]['joins'][$join])) {
                throw new MatchHttpError(409, 'this join is already waiting');
            }
            $waiting = array_filter($rooms[$room]['joins'], fn (array $entry) => $entry['answer'] === null && $entry['refused'] === null);
            if (count($waiting) >= MATCH_MAX_WAITING_JOINS) {
                header('Retry-After: 2');
                throw new MatchHttpError(503, 'too many computers are joining this room at once');
            }
            $rooms[$room]['joins'][$join] = ['offer' => $code, 'answer' => null, 'refused' => null, 'created' => time()];
            $store['rooms'] = $rooms;
        });
        match_json(['ok' => true], 201);
    }
    $keyHash = match_host_key_hash();
    if ($role === 'host') {
        $name = match_room_name();
        $waiting = [];
        match_mutate(function (array &$store) use ($room, $keyHash, $name, &$waiting): void {
            $rooms = match_prune_rooms($store['rooms'], time());
            if (!isset($rooms[$room])) {
                if (count($rooms) >= MATCH_MAX_ROOMS) {
                    throw new MatchHttpError(503, 'the signalling server is full');
                }
                $rooms[$room] = ['name' => $name, 'key' => $keyHash, 'touched' => time(), 'joins' => []];
            }
            $hosted = &match_hosted_room($rooms, $room, $keyHash);
            $hosted['name'] = $name;
            $hosted['touched'] = time();
            foreach ($hosted['joins'] as $join => $entry) {
                if ($entry['answer'] === null && $entry['refused'] === null) {
                    $waiting[] = ['join' => $join, 'offer' => $entry['offer']];
                }
            }
            unset($hosted);
            $store['rooms'] = $rooms;
        });
        match_json(['room' => $room, 'name' => $name, 'joins' => $waiting]);
    }
    if ($role === 'answer' || $role === 'refuse') {
        $join = match_token('join', 'join token');
        if ($role === 'answer') {
            $code = match_code();
        } else {
            $reason = file_get_contents('php://input', false, null, 0, MATCH_MAX_REFUSAL_BYTES + 1);
            $code = trim(preg_replace('/[\x00-\x1F\x7F]/u', '', is_string($reason) ? $reason : '') ?? '');
            if ($code === '' || strlen($code) > MATCH_MAX_REFUSAL_BYTES) {
                throw new MatchHttpError(422, 'a refusal is 1 to 256 bytes of text');
            }
        }
        match_mutate(function (array &$store) use ($room, $keyHash, $join, $role, $code): void {
            $rooms = match_prune_rooms($store['rooms'], time());
            $hosted = &match_hosted_room($rooms, $room, $keyHash);
            $entry = $hosted['joins'][$join] ?? null;
            if ($entry === null) {
                throw new MatchHttpError(404, 'no such join');
            }
            if ($entry['answer'] !== null || $entry['refused'] !== null) {
                throw new MatchHttpError(409, 'this join is already answered');
            }
            $hosted['joins'][$join][$role === 'answer' ? 'answer' : 'refused'] = $code;
            $hosted['touched'] = time();
            unset($hosted);
            $store['rooms'] = $rooms;
        });
        match_json(['ok' => true]);
    }
    if ($role === 'close') {
        match_mutate(function (array &$store) use ($room, $keyHash): void {
            $rooms = match_prune_rooms($store['rooms'], time());
            match_hosted_room($rooms, $room, $keyHash);
            unset($rooms[$room]);
            $store['rooms'] = $rooms;
        });
        match_json(['ok' => true]);
    }
    throw new MatchHttpError(422, 'a room role is host, join, answer, refuse, or close');
}

function match_run(): never
{
    match_headers();
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    if ($method === 'OPTIONS') {
        http_response_code(204);
        exit;
    }
    if (isset($_GET['room'])) {
        match_run_room($method, match_token('room', 'room token'));
    }
    $name = $_GET['session'] ?? '';
    if (!is_string($name) || preg_match(MATCH_NAME_PATTERN, $name) !== 1) {
        throw new MatchHttpError(422, 'a session name is lowercase words separated by dashes, 64 characters at most');
    }
    if ($method === 'GET') {
        $session = match_read_sessions()[$name] ?? null;
        if ($session === null || match_expired($session, time())) {
            throw new MatchHttpError(404, "no session named \"$name\"");
        }
        match_json(['name' => $name, ...$session]);
    }
    if ($method !== 'POST') {
        header('Allow: GET, POST, OPTIONS');
        throw new MatchHttpError(405, 'use GET, POST, or OPTIONS');
    }
    $role = $_GET['role'] ?? '';
    $code = match_code();
    if ($role === 'offer') {
        match_mutate(function (array &$store) use ($name, $code): void {
            $sessions = &$store['sessions'];
            $live = array_filter(
                $sessions,
                fn (array $session, string $key) => $key !== $name && !match_expired($session, time()),
                ARRAY_FILTER_USE_BOTH,
            );
            if (count($live) >= MATCH_MAX_SESSIONS) {
                throw new MatchHttpError(503, 'the signalling server is full');
            }
            $sessions[$name] = ['offer' => $code, 'answer' => null, 'created' => time()];
        });
        match_json(['ok' => true], 201);
    }
    if ($role === 'answer') {
        match_mutate(function (array &$store) use ($name, $code): void {
            $sessions = &$store['sessions'];
            $session = $sessions[$name] ?? null;
            if ($session === null || match_expired($session, time())) {
                throw new MatchHttpError(404, "no session named \"$name\"");
            }
            if ($session['answer'] !== null) {
                throw new MatchHttpError(409, "the session \"$name\" is already answered");
            }
            $sessions[$name]['answer'] = $code;
        });
        match_json(['ok' => true]);
    }
    throw new MatchHttpError(422, 'the role is either "offer" or "answer"');
}

try {
    match_run();
} catch (MatchHttpError $error) {
    match_json(['error' => $error->getMessage()], $error->status);
} catch (Throwable $error) {
    error_log('signalling piplet failed: ' . $error->getMessage());
    match_json(['error' => 'the signalling server failed'], 500);
}

__halt_compiler();
{"sessions":{}}
