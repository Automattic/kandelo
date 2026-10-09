<?php

$input = fopen('php://stdin', 'rb');
$output = fopen('php://stdout', 'wb');

function readExactly($stream, int $length): ?string
{
    $data = '';
    while (strlen($data) < $length) {
        $chunk = fread($stream, $length - strlen($data));
        if ($chunk === false || $chunk === '') {
            if ($data === '' && feof($stream)) {
                return null;
            }
            throw new RuntimeException('incomplete RoadRunner frame');
        }
        $data .= $chunk;
    }
    return $data;
}

function sendFrame($stream, int $flags, string $context, string $body = ''): void
{
    $payload = $context . $body;
    $prefix = pack('CCV', 0x14, $flags, strlen($payload));
    $frame = $prefix . pack('VCCV', crc32($prefix), 0, 0, strlen($context)) . $payload;
    while ($frame !== '') {
        $written = fwrite($stream, $frame);
        if ($written === false || $written === 0) {
            throw new RuntimeException('failed to write RoadRunner frame');
        }
        $frame = substr($frame, $written);
    }
}

function readVarint(string $data, int &$offset): int
{
    $value = 0;
    for ($shift = 0; $shift < 64; $shift += 7) {
        if ($offset >= strlen($data)) {
            throw new RuntimeException('truncated protobuf varint');
        }
        $byte = ord($data[$offset++]);
        $value |= ($byte & 0x7f) << $shift;
        if (($byte & 0x80) === 0) {
            return $value;
        }
    }
    throw new RuntimeException('oversized protobuf varint');
}

function readBytes(string $data, int &$offset): string
{
    $length = readVarint($data, $offset);
    if ($length < 0 || $length > strlen($data) - $offset) {
        throw new RuntimeException('invalid protobuf length');
    }
    $value = substr($data, $offset, $length);
    $offset += $length;
    return $value;
}

function fields(string $data): array
{
    $offset = 0;
    $fields = [];
    while ($offset < strlen($data)) {
        $tag = readVarint($data, $offset);
        $number = $tag >> 3;
        $wire = $tag & 7;
        if ($number === 0) {
            throw new RuntimeException('invalid protobuf field');
        }
        if ($wire === 0) {
            $value = readVarint($data, $offset);
        } elseif ($wire === 2) {
            $value = readBytes($data, $offset);
        } else {
            throw new RuntimeException('unsupported protobuf wire type');
        }
        $fields[$number][] = $value;
    }
    return $fields;
}

function requestFromContext(string $context): array
{
    $message = fields($context);
    $headers = [];
    foreach ($message[5] ?? [] as $entry) {
        $map = fields($entry);
        $name = $map[1][0] ?? '';
        $values = [];
        foreach ($map[2] ?? [] as $headerValue) {
            $values = array_merge($values, fields($headerValue)[1] ?? []);
        }
        if ($name !== '') {
            $headers[$name] = $values;
        }
    }
    return [
        'method' => $message[3][0] ?? 'GET',
        'uri' => $message[4][0] ?? '/',
        'headers' => $headers,
    ];
}

function encodeVarint(int $value): string
{
    $encoded = '';
    do {
        $byte = $value & 0x7f;
        $value >>= 7;
        $encoded .= chr($value === 0 ? $byte : $byte | 0x80);
    } while ($value !== 0);
    return $encoded;
}

function encodeBytes(int $number, string $value): string
{
    return encodeVarint(($number << 3) | 2) . encodeVarint(strlen($value)) . $value;
}

function responseContext(int $status, array $headers): string
{
    $encoded = "\x08" . encodeVarint($status);
    foreach ($headers as $name => $values) {
        $headerValue = '';
        foreach ($values as $value) {
            $headerValue .= encodeBytes(1, $value);
        }
        $encoded .= encodeBytes(2, encodeBytes(1, $name) . encodeBytes(2, $headerValue));
    }
    return $encoded;
}

function forwardRequest(array $request, string $body): array
{
    $path = parse_url($request['uri'], PHP_URL_PATH) ?: '/';
    $query = parse_url($request['uri'], PHP_URL_QUERY);
    if (!str_starts_with($path, '/')) {
        throw new RuntimeException('invalid request path');
    }
    $backendPort = (int)(getenv('WP_BACKEND_PORT') ?: 38080);
    if ($backendPort <= 0 || $backendPort > 65535) {
        throw new RuntimeException('invalid WordPress backend port');
    }
    $target = 'http://127.0.0.1:' . $backendPort . $path;
    if ($query !== null && $query !== '') {
        $target .= '?' . $query;
    }
    $headers = [];
    $hasHost = false;
    foreach ($request['headers'] as $name => $values) {
        if (!preg_match('/^[A-Za-z0-9-]+$/', $name)) {
            throw new RuntimeException('invalid request header name');
        }
        if (in_array(strtolower($name), ['connection', 'transfer-encoding', 'content-length'], true)) {
            continue;
        }
        if (strtolower($name) === 'host') {
            $hasHost = true;
        }
        foreach ($values as $value) {
            if (strpbrk($value, "\r\n") !== false) {
                throw new RuntimeException('invalid request header value');
            }
            $headers[] = $name . ': ' . $value;
        }
    }
    if (!$hasHost) {
        $uriHost = parse_url($request['uri'], PHP_URL_HOST);
        $uriPort = parse_url($request['uri'], PHP_URL_PORT);
        if (is_string($uriHost) && preg_match('/^[A-Za-z0-9.:-]+$/', $uriHost)) {
            $headers[] = 'Host: ' . $uriHost . ($uriPort === null ? '' : ':' . $uriPort);
        }
    }
    $headers[] = 'Connection: close';
    $context = stream_context_create(['http' => [
        'method' => $request['method'],
        'header' => implode("\r\n", $headers),
        'content' => $body,
        'ignore_errors' => true,
        'follow_location' => 0,
        'timeout' => 30,
    ]]);
    $response = @file_get_contents($target, false, $context);
    if ($response === false || !isset($http_response_header[0])) {
        throw new RuntimeException('WordPress backend request failed');
    }
    if (!preg_match('/^HTTP\/\S+\s+(\d{3})/', $http_response_header[0], $match)) {
        throw new RuntimeException('invalid WordPress backend status');
    }
    $responseHeaders = [];
    foreach (array_slice($http_response_header, 1) as $line) {
        $separator = strpos($line, ':');
        if ($separator === false) {
            continue;
        }
        $name = substr($line, 0, $separator);
        if (in_array(strtolower($name), ['connection', 'transfer-encoding', 'content-length'], true)) {
            continue;
        }
        $responseHeaders[$name][] = trim(substr($line, $separator + 1));
    }
    return [(int)$match[1], $responseHeaders, $response];
}

while (($header = readExactly($input, 12)) !== null) {
    $headerWords = ord($header[0]) & 0x0f;
    $length = unpack('V', substr($header, 2, 4))[1];
    if ((ord($header[0]) >> 4) !== 1 || $headerWords < 3 || $length > 16 * 1024 * 1024) {
        throw new RuntimeException('invalid RoadRunner frame header');
    }
    $options = readExactly($input, ($headerWords - 3) * 4);
    $payload = readExactly($input, $length);
    if ($options === null || $payload === null) {
        throw new RuntimeException('incomplete RoadRunner request');
    }
    if ((ord($header[1]) & 1) !== 0) {
        $command = json_decode($payload, true, 512, JSON_THROW_ON_ERROR);
        if (isset($command['pid'])) {
            sendFrame($output, 0x09, json_encode(['pid' => getmypid()], JSON_THROW_ON_ERROR));
        } elseif (isset($command['stop'])) {
            break;
        } else {
            throw new RuntimeException('unknown RoadRunner control frame');
        }
        continue;
    }
    if (strlen($options) < 4) {
        throw new RuntimeException('missing RoadRunner context length');
    }
    $contextLength = unpack('V', substr($options, 0, 4))[1];
    if ($contextLength > strlen($payload)) {
        throw new RuntimeException('invalid RoadRunner context length');
    }
    $request = requestFromContext(substr($payload, 0, $contextLength));
    try {
        [$status, $headers, $body] = forwardRequest($request, substr($payload, $contextLength));
    } catch (Throwable $error) {
        fwrite(STDERR, $error->getMessage() . "\n");
        $status = 502;
        $headers = ['Content-Type' => ['text/plain']];
        $body = "WordPress backend unavailable\n";
    }
    sendFrame($output, 0x80, responseContext($status, $headers), $body);
}
