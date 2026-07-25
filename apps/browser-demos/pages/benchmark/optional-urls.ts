/**
 * Optional application-binary URL imports are resolved via `import.meta.glob`.
 *
 * This module is loaded only by application benchmark suites. Static top-level
 * `?url` imports in the main benchmark module would fail every suite if an
 * unrelated application file were missing. `import.meta.glob` returns an empty
 * map for a missing file, so the requesting suite reports a focused build hint.
 */
// Paths are relative to this file
// (apps/browser-demos/pages/benchmark/optional-urls.ts). Vite normalizes glob
// result keys, so callers must use the same relative strings declared here.
export const OPTIONAL_URLS = {
  ...import.meta.glob("../../../../packages/registry/erlang/bin/beam.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../packages/registry/erlang/beam.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../packages/registry/nginx/nginx.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../local-binaries/programs/wasm32/nginx.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../binaries/programs/wasm32/nginx.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../binaries/programs/wasm32/php/php-fpm.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../local-binaries/programs/wasm32/php/php-fpm.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../packages/registry/coreutils/bin/coreutils.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../local-binaries/programs/wasm32/coreutils.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../binaries/programs/wasm32/coreutils.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../packages/registry/grep/bin/grep.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../local-binaries/programs/wasm32/grep.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../binaries/programs/wasm32/grep.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../packages/registry/sed/bin/sed.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../local-binaries/programs/wasm32/sed.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../binaries/programs/wasm32/sed.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../packages/registry/mariadb/mariadb-install/bin/mariadbd.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../local-binaries/programs/wasm32/mariadb/mariadbd.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../binaries/programs/wasm32/mariadb/mariadbd.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../packages/registry/mariadb/mariadb-install/share/mysql/mysql_system_tables.sql", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../packages/registry/mariadb/mariadb-install/share/mysql/mysql_system_tables_data.sql", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../packages/registry/mariadb/mariadb-install-64/bin/mariadbd.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../local-binaries/programs/wasm64/mariadb/mariadbd.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../binaries/programs/wasm64/mariadb/mariadbd.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../packages/registry/mariadb/mariadb-install-64/share/mysql/mysql_system_tables.sql", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../packages/registry/mariadb/mariadb-install-64/share/mysql/mysql_system_tables_data.sql", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../local-binaries/programs/wasm32/erlang-vfs.vfs.zst", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../binaries/programs/wasm32/erlang-vfs.vfs.zst", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../public/erlang.vfs.zst", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../local-binaries/programs/wasm32/wordpress.vfs.zst", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../binaries/programs/wasm32/wordpress.vfs.zst", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../public/wordpress.vfs.zst", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../public/mariadb.vfs.zst", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../public/mariadb-64.vfs.zst", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../local-binaries/programs/wasm32/mariadb-vfs.vfs.zst", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../binaries/programs/wasm32/mariadb-vfs.vfs.zst", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../local-binaries/programs/wasm64/mariadb-vfs.vfs.zst", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../binaries/programs/wasm64/mariadb-vfs.vfs.zst", {
    query: "?url", import: "default",
  }),
} as Record<string, () => Promise<string>>;
