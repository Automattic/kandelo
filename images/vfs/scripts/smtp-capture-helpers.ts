import type { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import { writeVfsFile, ensureDirRecursive } from "./vfs-image-helpers";
import type { DinitService } from "./dinit-image-helpers";

export const SMTP_CAPTURE_DIR = "/var/mail/smtp-capture";
export const SMTP_CAPTURE_PORT = 1025;

export function populateSmtpCaptureConfig(fs: MemoryFileSystem): void {
  ensureDirRecursive(fs, "/usr/local/bin");
  ensureDirRecursive(fs, SMTP_CAPTURE_DIR);
  ensureDirRecursive(fs, `${SMTP_CAPTURE_DIR}/tmp`);
  ensureDirRecursive(fs, `${SMTP_CAPTURE_DIR}/new`);

  const startScript = `#!/bin/sh
exec /usr/sbin/msmtpd \\
  --interface=127.0.0.1 \\
  --port=${SMTP_CAPTURE_PORT} \\
  --log=/var/log/msmtpd.log \\
  --command="/usr/local/bin/smtp-capture %F"
`;

  const captureScript = `#!/bin/sh
set -eu

mail_dir="\${SMTP_CAPTURE_DIR:-${SMTP_CAPTURE_DIR}}"
tmp_dir="$mail_dir/tmp"
new_dir="$mail_dir/new"
mkdir -p "$tmp_dir" "$new_dir"

stamp="$(date +%Y%m%d%H%M%S 2>/dev/null || printf '00000000000000')"
seq=0
name="$stamp.$$.$seq.eml"
tmp_file="$tmp_dir/$name"
while [ -e "$tmp_file" ]; do
  seq=$((seq + 1))
  name="$stamp.$$.$seq.eml"
  tmp_file="$tmp_dir/$name"
done

from="\${1:-}"
if [ "$#" -gt 0 ]; then
  shift
fi

{
  printf 'X-SMTP-Envelope-From: %s\\r\\n' "$from"
  for rcpt in "$@"; do
    printf 'X-SMTP-Envelope-To: %s\\r\\n' "$rcpt"
  done
  printf '\\r\\n'
  cat
} > "$tmp_file"

mv "$tmp_file" "$new_dir/$name"
`;

  writeVfsFile(fs, "/usr/local/bin/start-msmtpd", startScript, 0o755);
  writeVfsFile(fs, "/usr/local/bin/smtp-capture", captureScript, 0o755);
}

export function smtpCaptureService(): DinitService {
  return {
    name: "smtp-capture",
    type: "process",
    command: "/bin/sh /usr/local/bin/start-msmtpd",
    logfile: "/var/log/smtp-capture.log",
    restart: false,
  };
}

export function wordpressSmtpCaptureMuPlugin(): string {
  return `<?php
add_action('phpmailer_init', function($phpmailer) {
    $phpmailer->isSMTP();
    $phpmailer->Host = '127.0.0.1';
    $phpmailer->Port = ${SMTP_CAPTURE_PORT};
    $phpmailer->SMTPAuth = false;
    $phpmailer->SMTPAutoTLS = false;
    $phpmailer->Timeout = 5;
});
add_filter('wp_mail_from', function() {
    return 'wordpress@kandelo.local';
});
add_filter('wp_mail_from_name', function() {
    return 'Kandelo WordPress Demo';
});
add_filter('http_request_args', function($args) {
    $ca_file = '/etc/ssl/certs/ca-certificates.crt';
    if (is_readable($ca_file)) {
        $args['sslcertificates'] = $ca_file;
    }
    return $args;
});
add_filter('wp_admin_canonical_url', function($url) {
    $home_path = wp_parse_url(home_url('/'), PHP_URL_PATH);
    if (!$home_path || '/' === $home_path) {
        return $url;
    }

    $prefix = rtrim($home_path, '/');
    $parts = wp_parse_url($url);
    if (empty($parts['path']) || 0 === strpos($parts['path'], $prefix . '/')) {
        return $url;
    }

    $rebuilt = '';
    if (!empty($parts['scheme'])) {
        $rebuilt .= $parts['scheme'] . '://';
    }
    if (!empty($parts['host'])) {
        $rebuilt .= $parts['host'];
    }
    if (!empty($parts['port'])) {
        $rebuilt .= ':' . $parts['port'];
    }
    $rebuilt .= $prefix . '/' . ltrim($parts['path'], '/');
    if (!empty($parts['query'])) {
        $rebuilt .= '?' . $parts['query'];
    }
    return $rebuilt;
});
if (!defined('DISALLOW_FILE_MODS')) define('DISALLOW_FILE_MODS', true);
`;
}
