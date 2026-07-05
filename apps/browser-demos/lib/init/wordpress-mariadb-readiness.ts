export const WORDPRESS_MARIADB_SOCKET_PATH = "/tmp/mysql.sock";
export const WORDPRESS_MARIADB_READY_PATH = "/kandelo-ready.php";
export const WORDPRESS_MARIADB_READY_FILE = `/var/www/html${WORDPRESS_MARIADB_READY_PATH}`;

export const WORDPRESS_MARIADB_READY_PHP = `<?php
mysqli_report(MYSQLI_REPORT_OFF);

$mysqli = mysqli_init();
if (!$mysqli) {
    http_response_code(503);
    header('Content-Type: text/plain');
    echo "mysqli init failed\\n";
    exit;
}

if (defined('MYSQLI_OPT_CONNECT_TIMEOUT')) {
    mysqli_options($mysqli, MYSQLI_OPT_CONNECT_TIMEOUT, 2);
}

$connected = @mysqli_real_connect(
    $mysqli,
    'localhost',
    'root',
    '',
    'wordpress',
    0,
    '${WORDPRESS_MARIADB_SOCKET_PATH}'
);

if (!$connected) {
    http_response_code(503);
    header('Content-Type: text/plain');
    echo "mariadb unavailable: " . mysqli_connect_error() . "\\n";
    exit;
}

$result = @mysqli_query(
    $mysqli,
    "SELECT option_value FROM wp_options WHERE option_name = 'siteurl' LIMIT 1"
);

if (!$result) {
    http_response_code(503);
    header('Content-Type: text/plain');
    echo "wordpress database unavailable: " . mysqli_error($mysqli) . "\\n";
    mysqli_close($mysqli);
    exit;
}

$row = mysqli_fetch_row($result);
if (!$row || $row[0] === '') {
    http_response_code(503);
    header('Content-Type: text/plain');
    echo "wordpress siteurl missing\\n";
    mysqli_close($mysqli);
    exit;
}

mysqli_close($mysqli);
header('Content-Type: text/plain');
echo "ready\\n";
`;
