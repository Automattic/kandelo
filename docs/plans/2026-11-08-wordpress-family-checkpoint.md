# WordPress family publication and configuration checkpoint

The normal frozen-source build `4770` publishes both canonical images and
three Go programs, passes both image-layout audits, and passes the two
standalone FrankenPHP WordPress Node cases. Its family selection fails all
three selected cases (three unrelated web-stack cases are not selected).
This is a failed aggregate gate, not canonical release acceptance.

The first switch from Caddy to PHP-FPM fails when an ordinary fork meets
the host's temporary process-memory retirement backlog. The two MariaDB
paths start their services but return HTTP 500. These are separate failures;
changing database configuration does not resolve retirement admission.

## MariaDB cause and controlled proof

`installWordPressFamilyCaddy` copies the SQLite WordPress image's
`/etc/php.ini` over the LAMP image's PHP-FPM configuration. That loses
`mysqli.default_socket=/run/mysqld/mysql.sock` and its PDO counterpart.
FrankenPHP already reads its separate `/etc/frankenphp/php.ini`.

Private control `54a7` runs two fresh Kandelo machines using the same
hash-verified normal family image and kernel from `4770`. With the original
configuration, actual PHP reports an empty socket, connection errno 2002
("No such file or directory"), and the WordPress homepage returns HTTP 500.
Adding only the ordinary socket settings before the second machine boots
makes the connection succeed (errno zero) and the homepage return HTTP 200.
Both control assertions pass in 19 seconds with no skips. The preceding
`6bd2` attempt records the same observations but fails both assertions
because its diagnostic parser attempts to decode combined curl/PHP
warnings as JSON. That failed report is retained separately.

The revision-13 family recipe therefore preserves LAMP's FPM configuration
while copying embedded PHP's separate configuration directory. It changes
no PHP, Go, WordPress or database algorithm. Raw control source, exact
artifact hashes, output and reports are retained in the review checkout at
`.context/agent-jobs/wordpress-family-mariadb-socket-control-1108-034332-54a7/scratch/family-socket-control/`.
This controlled proof is not acceptance of rebuilt revision-13 images.

## Remaining acceptance

Build the revision-13 family through its normal resolver and own SDK,
then rerun Node and all three browser engines for both database backends,
Caddy/FPM switching, persistence and uploads. Investigate fork-retirement
admission without weakening snapshot ownership or resource limits. The
shared preview remains the verified revision-45 partial WordPress image;
it is not replaced by the failed family product.
