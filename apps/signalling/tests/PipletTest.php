<?php

/**
 * The signalling piplet, exercised over real HTTP against a real `php -S`.
 * The file is self-modifying, so every case serves a throwaway copy, never
 * the repository file.
 */

const PIPLET_BASE = 'http://127.0.0.1:18792/';

function piplet(callable $run, ?callable $mutateSource = null): void
{
    $directory = sys_get_temp_dir() . '/kandelo-signalling-' . bin2hex(random_bytes(8));
    mkdir($directory);
    $copy = $directory . '/piplet.php';
    $source = file_get_contents(dirname(__DIR__) . '/piplet.php');
    file_put_contents($copy, $mutateSource === null ? $source : $mutateSource($source));
    $server = proc_open(
        ['php', '-S', '127.0.0.1:18792', $copy],
        [['file', '/dev/null', 'r'], ['file', '/dev/null', 'w'], ['file', '/dev/null', 'w']],
        $pipes,
    );
    try {
        $ready = false;
        for ($attempt = 0; $attempt < 50 && !$ready; $attempt++) {
            $ready = read('readiness-probe')['status'] === 404;
            if (!$ready) {
                usleep(100000);
            }
        }
        expect($ready)->toBeTrue('the signalling piplet did not start');
        $run($copy);
    } finally {
        proc_terminate($server);
        proc_close($server);
        foreach (scandir($directory) as $entry) {
            if ($entry === '.' || $entry === '..') {
                continue;
            }
            unlink($directory . '/' . $entry);
        }
        rmdir($directory);
    }
}

function request(string $method, string $query, ?string $code = null, array $headers = []): array
{
    $options = ['method' => $method, 'ignore_errors' => true, 'timeout' => 5];
    if ($code !== null) {
        $headers[] = 'Content-Type: text/plain';
        $options['content'] = $code;
    }
    if ($headers !== []) {
        $options['header'] = implode("\r\n", $headers);
    }
    set_error_handler(fn (): bool => true);
    try {
        $body = file_get_contents(PIPLET_BASE . $query, false, stream_context_create(['http' => $options]));
        $lines = $http_response_header ?? [];
    } finally {
        restore_error_handler();
    }
    $status = 0;
    $headers = [];
    foreach ($lines as $line) {
        if (preg_match('#^HTTP/\S+ (\d{3})#', $line, $match) === 1) {
            $status = (int) $match[1];
            continue;
        }
        [$key, $value] = explode(':', $line, 2) + [1 => ''];
        $headers[strtolower($key)] = trim($value);
    }
    return ['status' => $status, 'headers' => $headers, 'body' => $body === false ? null : $body];
}

function read(string $name): array
{
    return request('GET', "?session=$name");
}

function offer(string $name, string $code = 'kandelo1:offer'): array
{
    return request('POST', "?session=$name&role=offer", $code);
}

function answer(string $name, string $code = 'kandelo1:answer'): array
{
    return request('POST', "?session=$name&role=answer", $code);
}

test('a session carries an offer and one answer', function (): void {
    piplet(function (string $copy): void {
        expect(read('foo')['status'])->toBe(404);
        expect(offer('foo')['status'])->toBe(201);
        $hosted = json_decode(read('foo')['body'], true);
        expect($hosted['offer'])->toBe('kandelo1:offer');
        expect($hosted['answer'])->toBeNull();
        expect(answer('foo')['status'])->toBe(200);
        $joined = json_decode(read('foo')['body'], true);
        expect($joined['answer'])->toBe('kandelo1:answer');
        expect(answer('foo', 'kandelo1:late')['status'])->toBe(409);
        expect(file_get_contents($copy))->toContain('"kandelo1:answer"');
    });
});

test('hosting again replaces the session', function (): void {
    piplet(function (): void {
        offer('foo');
        answer('foo');
        expect(offer('foo', 'kandelo1:fresh')['status'])->toBe(201);
        $fresh = json_decode(read('foo')['body'], true);
        expect($fresh['offer'])->toBe('kandelo1:fresh');
        expect($fresh['answer'])->toBeNull();
    });
});

test('a session name is lowercase words separated by dashes', function (): void {
    piplet(function (): void {
        expect(read('foo-bar-baz-qux-quux-corge')['status'])->toBe(404);
        $names = [
            'bad/name',
            'Foo',
            'foo3',
            'foo_bar',
            'foo.bar',
            '-foo',
            'foo-',
            'foo--bar',
            str_repeat('a', 65),
        ];
        foreach ($names as $name) {
            expect(read($name)['status'])->toBe(422, $name);
            expect(offer($name)['status'])->toBe(422, $name);
        }
    });
});

test('malformed requests are refused', function (): void {
    piplet(function (): void {
        expect(offer('foo', 'not a code')['status'])->toBe(422);
        expect(answer('foo')['status'])->toBe(404);
        expect(request('POST', '?session=foo&role=nope', 'kandelo1:x')['status'])->toBe(422);
        expect(request('DELETE', '?session=foo')['status'])->toBe(405);
    });
});

test('a connect code is 1 to 65536 bytes', function (): void {
    piplet(function (): void {
        expect(offer('foo', '')['status'])->toBe(413);
        expect(offer('foo', str_pad('kandelo1:', 65537, 'a'))['status'])->toBe(413);
        expect(offer('foo', str_pad('kandelo1:', 65536, 'a'))['status'])->toBe(201);
    });
});

test('a full server refuses a new session but not a re-offer', function (): void {
    piplet(
        function (): void {
            expect(offer('foo')['status'])->toBe(201);
            expect(offer('bar')['status'])->toBe(201);
            expect(offer('baz')['status'])->toBe(503);
            expect(offer('foo', 'kandelo1:fresh')['status'])->toBe(201);
        },
        fn (string $source): string => str_replace(
            'MATCH_MAX_SESSIONS = 256',
            'MATCH_MAX_SESSIONS = 2',
            $source,
        ),
    );
});

test('responses are CORS-open for the browser client', function (): void {
    piplet(function (): void {
        expect(request('OPTIONS', '?session=foo')['status'])->toBe(204);
        $response = read('foo');
        expect($response['headers']['access-control-allow-origin'])->toBe('*');
        expect($response['headers']['cross-origin-resource-policy'])->toBe('cross-origin');
    });
});

test('sessions expire and are pruned from the file', function (): void {
    piplet(
        function (string $copy): void {
            offer('shortlived');
            usleep(1100000);
            expect(read('shortlived')['status'])->toBe(404);
            expect(answer('shortlived')['status'])->toBe(404);
            offer('next');
            $stored = file_get_contents($copy);
            expect($stored)->not->toContain('shortlived');
            expect($stored)->toContain('next');
        },
        fn (string $source): string => str_replace(
            'MATCH_SESSION_TTL_SECONDS = 600',
            'MATCH_SESSION_TTL_SECONDS = 1',
            $source,
        ),
    );
});

const ROOM = 'roomtokenroomtokenroom';
const HOST_KEY = 'hostkeyhostkeyhostkeyhost';
const JOIN_A = 'joinaaaaaaaaaaaaaaaaaaaa';
const JOIN_B = 'joinbbbbbbbbbbbbbbbbbbbb';

function host(string $name = 'Friday game night', string $key = HOST_KEY, string $room = ROOM): array
{
    return request('POST', "?room=$room&role=host", json_encode(['name' => $name]), ["X-Kandelo-Host-Key: $key"]);
}

function hostRoom(string $role, string $join, string $body, string $key = HOST_KEY): array
{
    return request('POST', '?room=' . ROOM . "&role=$role&join=$join", $body, ["X-Kandelo-Host-Key: $key"]);
}

function joinRoom(string $join, string $code = 'kandelo1:offer'): array
{
    return request('POST', '?room=' . ROOM . "&role=join&join=$join", $code);
}

function joinStatus(string $join): array
{
    return request('GET', '?room=' . ROOM . "&join=$join");
}

test('a room matches several joiners to one host', function (): void {
    piplet(function (): void {
        expect(request('GET', '?room=' . ROOM)['status'])->toBe(404);
        expect(joinRoom(JOIN_A)['status'])->toBe(404);
        expect(host()['status'])->toBe(200);
        expect(json_decode(request('GET', '?room=' . ROOM)['body'], true)['name'])->toBe('Friday game night');
        expect(joinRoom(JOIN_A, 'kandelo1:offer-a')['status'])->toBe(201);
        expect(joinRoom(JOIN_B, 'kandelo1:offer-b')['status'])->toBe(201);
        expect(joinRoom(JOIN_A)['status'])->toBe(409);
        $waiting = json_decode(host()['body'], true)['joins'];
        expect($waiting)->toBe([
            ['join' => JOIN_A, 'offer' => 'kandelo1:offer-a'],
            ['join' => JOIN_B, 'offer' => 'kandelo1:offer-b'],
        ]);
        expect(json_decode(joinStatus(JOIN_A)['body'], true))->toBe(['answer' => null, 'refused' => null]);
        expect(hostRoom('answer', JOIN_A, 'kandelo1:answer-a')['status'])->toBe(200);
        expect(hostRoom('refuse', JOIN_B, 'the session is full')['status'])->toBe(200);
        expect(hostRoom('answer', JOIN_A, 'kandelo1:again')['status'])->toBe(409);
        expect(json_decode(joinStatus(JOIN_A)['body'], true)['answer'])->toBe('kandelo1:answer-a');
        expect(json_decode(joinStatus(JOIN_B)['body'], true)['refused'])->toBe('the session is full');
        expect(json_decode(host()['body'], true)['joins'])->toBe([]);
    });
});

test('only the host key acts for the host', function (): void {
    piplet(function (string $copy): void {
        host();
        joinRoom(JOIN_A);
        $other = 'someoneelsesomeoneelse';
        expect(host('Taken over', $other)['status'])->toBe(403);
        expect(hostRoom('answer', JOIN_A, 'kandelo1:forged', $other)['status'])->toBe(403);
        expect(request('POST', '?room=' . ROOM . '&role=close', '', ["X-Kandelo-Host-Key: $other"])['status'])->toBe(403);
        expect(request('POST', '?room=' . ROOM . '&role=host', json_encode(['name' => 'x']))['status'])->toBe(401);
        expect(file_get_contents($copy))->not->toContain(HOST_KEY);
        expect(request('POST', '?room=' . ROOM . '&role=close', '', ['X-Kandelo-Host-Key: ' . HOST_KEY])['status'])->toBe(200);
        expect(request('GET', '?room=' . ROOM)['status'])->toBe(404);
    });
});

test('room tokens, names and joins are validated', function (): void {
    piplet(function (): void {
        foreach (['short', 'Roomtokenroomtokenroom', 'room-token-room-token-room', str_repeat('a', 65)] as $token) {
            expect(request('GET', "?room=$token")['status'])->toBe(422, $token);
        }
        expect(host('')['status'])->toBe(422);
        expect(host(str_repeat('n', 65))['status'])->toBe(422);
        expect(host("Game\u{0007} night ✨")['status'])->toBe(200);
        expect(json_decode(request('GET', '?room=' . ROOM)['body'], true)['name'])->toBe('Game night ✨');
        expect(joinRoom(JOIN_A, 'not a code')['status'])->toBe(422);
        expect(request('POST', '?room=' . ROOM . '&role=nope', '', ['X-Kandelo-Host-Key: ' . HOST_KEY])['status'])->toBe(422);
    });
});

test('a room limits joins waiting at once', function (): void {
    piplet(function (): void {
        host();
        foreach (range(0, 7) as $index) {
            expect(joinRoom('join' . str_repeat(chr(97 + $index), 20))['status'])->toBe(201);
        }
        expect(joinRoom('join' . str_repeat('z', 20))['status'])->toBe(503);
        hostRoom('answer', 'join' . str_repeat('a', 20), 'kandelo1:answer');
        expect(joinRoom('join' . str_repeat('z', 20))['status'])->toBe(201);
    });
});

test('a room ends when its host stops checking in', function (): void {
    piplet(
        function (string $copy): void {
            host();
            joinRoom(JOIN_A);
            usleep(1100000);
            expect(request('GET', '?room=' . ROOM)['status'])->toBe(404);
            expect(joinRoom(JOIN_B)['status'])->toBe(404);
            offer('pruning');
            expect(file_get_contents($copy))->not->toContain(ROOM);
        },
        fn (string $source): string => str_replace(
            'MATCH_ROOM_TTL_SECONDS = 60',
            'MATCH_ROOM_TTL_SECONDS = 1',
            $source,
        ),
    );
});
