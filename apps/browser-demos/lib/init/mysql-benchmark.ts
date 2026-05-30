export const MYSQL_BENCHMARK_PHP = `<?php
declare(strict_types=1);

header('Content-Type: application/json');

mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);

function bench_now_ms(): float {
    return hrtime(true) / 1000000;
}

function bench_stats(array $values): array {
    $n = count($values);
    if ($n === 0) {
        return array('n' => 0);
    }
    sort($values, SORT_NUMERIC);
    $sum = array_sum($values);
    $p50 = $values[(int) floor(($n - 1) * 0.50)];
    $p95 = $values[(int) floor(($n - 1) * 0.95)];
    return array(
        'n' => $n,
        'min_ms' => $values[0],
        'avg_ms' => $sum / $n,
        'p50_ms' => $p50,
        'p95_ms' => $p95,
        'max_ms' => $values[$n - 1],
    );
}

function bench_connect(array $cfg): mysqli {
    $db = mysqli_init();
    $db->options(MYSQLI_OPT_CONNECT_TIMEOUT, 5);
    $db->real_connect(
        $cfg['host'],
        'root',
        '',
        '',
        $cfg['port'],
        $cfg['socket']
    );
    return $db;
}

function bench_variant(string $name, array $cfg, int $connectIters, int $queryIters): array {
    $connectTimes = array();
    $connectQueryTimes = array();
    $reuseQueryTimes = array();

    for ($i = 0; $i < $connectIters; $i++) {
        $t = bench_now_ms();
        $db = bench_connect($cfg);
        $connectTimes[] = bench_now_ms() - $t;

        $t = bench_now_ms();
        $db->query('SELECT 1')->free();
        $connectQueryTimes[] = bench_now_ms() - $t;
        $db->close();
    }

    $db = bench_connect($cfg);
    $db->query('SELECT 1')->free();
    for ($i = 0; $i < $queryIters; $i++) {
        $t = bench_now_ms();
        $db->query('SELECT 1')->free();
        $reuseQueryTimes[] = bench_now_ms() - $t;
    }
    $db->close();

    return array(
        'host' => $cfg['host'],
        'port' => $cfg['port'],
        'socket' => $cfg['socket'],
        'connect' => bench_stats($connectTimes),
        'select_after_connect' => bench_stats($connectQueryTimes),
        'select_reused_connection' => bench_stats($reuseQueryTimes),
    );
}

$connectIters = max(1, min(50, (int) ($_GET['connect_iters'] ?? 8)));
$queryIters = max(1, min(200, (int) ($_GET['query_iters'] ?? 25)));
$socket = ini_get('mysqli.default_socket') ?: '/tmp/mysql.sock';

$variants = array(
    'unix' => array('host' => 'localhost', 'port' => null, 'socket' => $socket),
    'tcp' => array('host' => '127.0.0.1', 'port' => 3306, 'socket' => null),
    'unix_persistent' => array('host' => 'p:localhost', 'port' => null, 'socket' => $socket),
    'tcp_persistent' => array('host' => 'p:127.0.0.1', 'port' => 3306, 'socket' => null),
);

$started = bench_now_ms();
$results = array();
foreach ($variants as $name => $cfg) {
    try {
        $results[$name] = bench_variant($name, $cfg, $connectIters, $queryIters);
    } catch (Throwable $e) {
        $results[$name] = array(
            'host' => $cfg['host'],
            'port' => $cfg['port'],
            'socket' => $cfg['socket'],
            'error' => $e->getMessage(),
        );
    }
}

echo json_encode(array(
    'connect_iters' => $connectIters,
    'query_iters' => $queryIters,
    'default_socket' => $socket,
    'elapsed_ms' => bench_now_ms() - $started,
    'variants' => $results,
), JSON_PRETTY_PRINT);
`;
