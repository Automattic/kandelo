#!/usr/bin/env bash
# Refresh the canonical rootfs CA bundle from curl.se's mirror of Mozilla's
# root certificates. Run manually when bumping the bundle. The fetched bytes
# are checked in and scripts/build-rootfs.sh installs them at OpenSSL's default
# /etc/ssl/cert.pem path and the conventional ca-certificates.crt path.
#
# Source upstream: https://curl.se/docs/caextract.html
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEST="$REPO_ROOT/images/rootfs/etc/ssl/cert.pem"
URL="https://curl.se/ca/cacert.pem"

echo "==> Fetching $URL"
curl -fsSL --max-time 60 -o "$DEST.tmp" "$URL"

# Sanity check: must be PEM, must contain at least 100 certs.
if ! head -1 "$DEST.tmp" | grep -q '^##'; then
    echo "ERROR: response does not look like the Mozilla CA bundle" >&2
    rm -f "$DEST.tmp"
    exit 1
fi
n=$(grep -c '^-----BEGIN CERTIFICATE-----' "$DEST.tmp" || true)
if [ "$n" -lt 100 ]; then
    echo "ERROR: only $n certificates in bundle, refusing to install" >&2
    rm -f "$DEST.tmp"
    exit 1
fi

mv "$DEST.tmp" "$DEST"
echo "==> Wrote $DEST ($n certs, $(wc -c < "$DEST") bytes)"
echo "    Header: $(grep '^## Certificate data from Mozilla last updated on:' "$DEST" || true)"
