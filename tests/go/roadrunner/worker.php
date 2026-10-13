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

function sendFrame($stream, int $flags, string $payload, array $options = []): void
{
    $prefix = pack('CCV', 0x10 | (3 + count($options)), $flags, strlen($payload));
    $frame = $prefix . pack('VCC', crc32($prefix), 0, 0);
    foreach ($options as $option) {
        $frame .= pack('V', $option);
    }
    $frame .= $payload;
    while ($frame !== '') {
        $written = fwrite($stream, $frame);
        if ($written === false || $written === 0) {
            throw new RuntimeException('failed to write RoadRunner frame');
        }
        $frame = substr($frame, $written);
    }
}

while (($header = readExactly($input, 12)) !== null) {
    $headerWords = ord($header[0]) & 0x0f;
    $length = unpack('V', substr($header, 2, 4))[1];
    if ((ord($header[0]) >> 4) !== 1 || $headerWords < 3 || $length > 1048576) {
        throw new RuntimeException('invalid RoadRunner frame header');
    }
    readExactly($input, ($headerWords - 3) * 4);
    $payload = readExactly($input, $length);
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
    $responseHeader = "\x08\xc8\x01";
    sendFrame($output, 0x80, $responseHeader . "ROADRUNNER PHP PASS\n", [strlen($responseHeader)]);
}
