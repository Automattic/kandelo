import type { VfsImageFilesystem } from "../../../host/src/vfs/vfs-image-filesystem";
/**
 * The WordPress images' first-boot secrets service.
 *
 * # Why this exists
 *
 * The `wordpress` and `lamp` images are byte-reproducible: the build-time
 * WordPress install runs on a deterministic guest (seeded entropy, a clock
 * pinned to SOURCE_DATE_EPOCH; `crates/runtime-core/src/image_build_determinism.rs`),
 * so two builds of one cache key produce the same bytes. The price is that
 * nothing the image contains is secret -- anyone can rebuild it -- and every
 * machine booted from one download starts from the same bytes. That was
 * already true before the images were reproducible: every machine shared the
 * build's keys and salts.
 *
 * So each machine makes its own secrets the first time it boots, from its own
 * entropy (the host's `crypto.getRandomValues`, reached through
 * `/dev/urandom`), before any WordPress code runs:
 *
 * - WordPress's eight keys and salts (`AUTH_KEY` ... `NONCE_SALT`), which sign
 *   login cookies and nonces. They are written to `WORDPRESS_SECRETS_PATH`,
 *   which `wp-config.php` requires; the image carries only a placeholder
 *   there that stops WordPress with an explanation.
 * - The admin password's hash salt. The password itself is the demo's
 *   published credential (`admin` / `password`; the demo guide's "Log in as
 *   admin" action types it) and stays the same by design. But the build
 *   hashed it with seeded entropy, so every image carried the identical
 *   hash; a machine re-hashes it with its own salt (see
 *   `wordpressAdminRehashMuPlugin`).
 *
 * The service is idempotent: when the file holds eight well-formed keys it
 * leaves it alone and says so. A later boot of the same machine (the same persisted filesystem) keeps
 * its secrets; a fresh boot of the shared image makes new ones. The file's
 * header records when it was generated. It runs identically on the Node and
 * browser hosts because it is an ordinary dinit service in the image. It uses
 * only bash builtins (`$SRANDOM` for entropy), because each extra program a
 * first boot starts is a process launch and, for coreutils, a lazy download
 * on the path to the machine's first page: an earlier version that piped
 * `head`, `base64`, `tr` and `fold` added about four seconds to the first
 * response on the Node host.
 *
 * # Alternatives rejected
 *
 * - Install WordPress on first boot instead of at build time. The image would
 *   be reproducible with no deterministic guest, but every first boot would
 *   pay the installer (MariaDB bootstrap, schema creation, bcrypt) that the
 *   build-time install exists to avoid.
 * - Deterministic build only, no rotation. Reproducible, but every machine
 *   would share keys anyone can recompute, which lets anyone forge a login
 *   cookie for any machine they can reach.
 * - Accept non-reproducible images. Leaves the cache-key contract broken and
 *   the build's secrets still shared by every download.
 *
 * # Residual risks
 *
 * - The admin password stays the published demo credential; only its salt
 *   is per machine. Anyone who can reach a machine can log in until its
 *   owner changes the password -- the demo's intended behaviour.
 * - LAMP's MariaDB runs with `--skip-grant-tables --skip-networking`: it has
 *   no credentials to rotate, and is reachable only through its socket inside
 *   the machine.
 * - A machine whose first boot fails before the service runs still has the
 *   placeholder, so WordPress stops with an explanation rather than running
 *   with shared or missing keys.
 */
import { writeVfsFile, ensureDirRecursive } from "./vfs-image-helpers";
import type { DinitService } from "./dinit-image-helpers";
import {
  WORDPRESS_DEFAULT_ADMIN_PASSWORD,
  WORDPRESS_DEFAULT_ADMIN_USER,
} from "./wordpress-preinstall";
import {
  WORDPRESS_SECRETS_PATH,
  WORDPRESS_SECRET_NAMES,
} from "../../../apps/browser-demos/lib/init/wordpress-runtime-config";

export const WORDPRESS_SECRETS_SERVICE = "wordpress-secrets";
export const WORDPRESS_ADMIN_REHASH_MU_PLUGIN_PATH =
  "/var/www/html/wp-content/mu-plugins/kandelo-admin-rehash.php";
/** The option recording that this machine re-salted the admin hash. */
export const WORDPRESS_ADMIN_REHASH_MARKER = "kandelo_admin_hash_resalted";
export const WORDPRESS_SECRETS_SCRIPT = "/usr/sbin/kandelo-wordpress-secrets";

/** PHP-FPM's workers run as `nobody`; they read the file, root writes it. */
const PHP_FPM_GID = 65534;

export function wordpressSecretsScript(): string {
  const names = WORDPRESS_SECRET_NAMES.join(" ");
  return `#!/bin/bash
# First-boot WordPress secrets: see images/vfs/scripts/wordpress-first-boot.ts.
# Writes this machine's keys and salts from its own entropy, once. The image
# is reproducible, so it cannot carry them.
#
# Only bash builtins, so a first boot starts no extra programs: $SRANDOM is
# 32 bits from getrandom(2) per expansion, and the image's placeholder file
# (root:nobody 0640) is rewritten in place, keeping its owner and mode.
set -eu
export TZ=UTC
umask 027

secrets=${WORDPRESS_SECRETS_PATH}
alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
key_line='^define\\('"'"'[A-Z_]+'"'"', '"'"'[A-Za-z0-9_-]{64}'"'"'\\);$'

# The file holds eight 64-character keys.
has_keys() {
  local line count=0
  [ -r "$secrets" ] || return 1
  while IFS= read -r line; do
    if [[ $line =~ $key_line ]]; then count=$((count + 1)); fi
  done < "$secrets"
  [ "$count" -eq 8 ]
}

if has_keys; then
  echo "wordpress-secrets: keeping this machine's secrets ($secrets)"
  exit 0
fi

# 64 characters, six random bits each.
new_key() {
  local r i
  key=
  while [ \${#key} -lt 64 ]; do
    r=$SRANDOM
    for i in 0 1 2 3 4; do
      key+=\${alphabet:$(( (r >> (i * 6)) & 63 )):1}
    done
  done
  key=\${key:0:64}
}

printf -v stamp '%(%Y-%m-%dT%H:%M:%SZ)T' -1
content="<?php
// WordPress keys and salts for this machine only, generated on its first
// boot at $stamp by $0.
"
for name in ${names}; do
  new_key
  content+="define('$name', '$key');"$'\\n'
done
printf '%s' "$content" > "$secrets"
if ! has_keys; then
  echo "wordpress-secrets: could not write $secrets" >&2
  exit 1
fi
echo "wordpress-secrets: generated this machine's secrets ($secrets)"
`;
}

/**
 * What the image ships at `WORDPRESS_SECRETS_PATH` until a machine's first
 * boot replaces it: not keys, but a PHP file that stops WordPress with an
 * explanation, so a machine whose first-boot service did not run fails
 * loudly instead of running on no keys (WordPress would otherwise fall back
 * to keys it generates and stores in the database, silently).
 */
export const WORDPRESS_SECRETS_PLACEHOLDER = `<?php
// Replaced on this machine's first boot by the wordpress-secrets service
// (images/vfs/scripts/wordpress-first-boot.ts). If WordPress stops here, that
// service has not run.
throw new RuntimeException('wordpress-secrets: this machine has not generated its WordPress keys yet');
`;

/**
 * An mu-plugin that re-salts the admin password hash once per machine.
 *
 * Why an mu-plugin on the first request rather than the first-boot service:
 * WordPress's hash (`$wp$2y$...`, bcrypt of an HMAC of the password) needs
 * PHP, and the images ship `php-fpm` but no PHP CLI; a service would need a
 * second 36 MB PHP binary or a FastCGI client in the image. Running inside
 * WordPress uses WordPress's own `wp_set_password` and nothing new. The
 * cost is one bcrypt verify and one bcrypt hash on the machine's first
 * request.
 *
 * It re-salts only while the hash still verifies against the published demo
 * password, so a machine whose owner changed the password is left alone,
 * and records `WORDPRESS_ADMIN_REHASH_MARKER` so later requests (and later
 * boots of the same machine) skip it. It does nothing inside the build's
 * installer (`WP_INSTALLING`), whose rows must stay deterministic. Two
 * concurrent first requests may both re-salt; the last write wins and both
 * results verify.
 */
export function wordpressAdminRehashMuPlugin(
  adminUser: string,
  demoPassword: string,
): string {
  const php = (value: string) => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  return `<?php
// Kandelo: give this machine its own salt for the published demo admin
// password. See images/vfs/scripts/wordpress-first-boot.ts.
if ( defined( 'WP_INSTALLING' ) && WP_INSTALLING ) {
    return;
}
add_action( 'init', static function () {
    if ( get_option( '${WORDPRESS_ADMIN_REHASH_MARKER}' ) ) {
        return;
    }
    $user = get_user_by( 'login', ${php(adminUser)} );
    if ( $user && wp_check_password( ${php(demoPassword)}, $user->user_pass, $user->ID ) ) {
        wp_set_password( ${php(demoPassword)}, $user->ID );
    }
    update_option( '${WORDPRESS_ADMIN_REHASH_MARKER}', gmdate( 'c' ), false );
}, 0 );
`;
}

/**
 * Install the service's script and the placeholder it replaces. The
 * placeholder carries the owner and mode the secrets need: root writes it,
 * PHP-FPM's nobody workers read it, no one else can.
 */
export function populateWordPressFirstBootSecrets(fs: VfsImageFilesystem): void {
  ensureDirRecursive(fs, "/var/www/html/wp-content/mu-plugins");
  writeVfsFile(
    fs,
    WORDPRESS_ADMIN_REHASH_MU_PLUGIN_PATH,
    wordpressAdminRehashMuPlugin(
      WORDPRESS_DEFAULT_ADMIN_USER,
      WORDPRESS_DEFAULT_ADMIN_PASSWORD,
    ),
  );
  ensureDirRecursive(fs, "/usr/sbin");
  ensureDirRecursive(fs, "/etc/kandelo");
  writeVfsFile(fs, WORDPRESS_SECRETS_SCRIPT, wordpressSecretsScript(), 0o755);
  writeVfsFile(fs, WORDPRESS_SECRETS_PATH, WORDPRESS_SECRETS_PLACEHOLDER, 0o640);
  fs.chown(WORDPRESS_SECRETS_PATH, 0, PHP_FPM_GID);
  fs.chmod(WORDPRESS_SECRETS_PATH, 0o640);
}

/** PHP-FPM depends on this service, so no WordPress code runs without secrets. */
export function wordpressFirstBootSecretsService(): DinitService {
  return {
    name: WORDPRESS_SECRETS_SERVICE,
    type: "scripted",
    command: `/bin/bash ${WORDPRESS_SECRETS_SCRIPT}`,
    logfile: "/var/log/wordpress-secrets.log",
    restart: false,
  };
}
