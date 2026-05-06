#!/usr/bin/env bash
#
# Stage non-binary fixtures that the benchmark suites need but that
# scripts/fetch-binaries.sh doesn't provide:
#
#   * WordPress + SQLite plugin checkout under examples/wordpress/wordpress/
#     (consumed by benchmarks/suites/wordpress.ts via runCentralizedProgram
#     against the packaged php.wasm)
#
#   * MariaDB bootstrap SQL (mysql_system_tables.sql + mysql_system_tables_data.sql)
#     under examples/libs/mariadb/share/mysql/ (consumed by
#     benchmarks/suites/mariadb.ts during the bootstrap measurement;
#     not part of the mariadb package's [[outputs]] which only ship
#     mariadbd.wasm + mysqltest.wasm).
#
# Idempotent — re-running is a no-op when files already exist.
# Used by .github/workflows/benchmarks.yml; safe to invoke locally too.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# WordPress fixtures
bash "$REPO_ROOT/examples/wordpress/setup.sh"

# MariaDB bootstrap SQL — version pinned to match
# examples/libs/mariadb/package.toml (kept in sync manually).
MARIADB_VERSION="10.5.28"
SQL_DST="$REPO_ROOT/examples/libs/mariadb/share/mysql"
mkdir -p "$SQL_DST"

stage_mariadb_sql() {
    local name="$1"
    local dst="$SQL_DST/$name"
    if [ -f "$dst" ]; then
        echo "==> $name already present"
        return 0
    fi
    local url="https://raw.githubusercontent.com/MariaDB/server/mariadb-${MARIADB_VERSION}/scripts/${name}"
    echo "==> Fetching $name from MariaDB ${MARIADB_VERSION} source"
    curl --retry 5 --retry-delay 2 -fsSL "$url" -o "$dst"
}

stage_mariadb_sql mysql_system_tables.sql
stage_mariadb_sql mysql_system_tables_data.sql

echo "==> Bench fixtures staged."
