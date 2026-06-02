import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { MYSQL_BENCHMARK_PHP } from "../lib/init/mysql-benchmark";
import {
  patchWordPressMysqliPersistentSource,
  wordpressConfigTemplate,
} from "../lib/init/wordpress-runtime-config";

test("wordpress mariadb config uses Unix sockets with persistent mysqli", () => {
  const config = wordpressConfigTemplate("mariadb");

  expect(config).toContain("define('DB_HOST', 'localhost');");
  expect(config).toContain("define('KANDELO_MYSQLI_PERSISTENT', true);");
  expect(config).toContain("WP_INSTALLING");
  expect(config).toContain("wp_new_blog_notification");
  expect(config).not.toContain("p:localhost");
  expect(config).not.toContain("pre_wp_mail");
});

test("wordpress mysqli patch enables persistent host selection", () => {
  const source = "mysqli_real_connect( $this->dbh, $host, $this->dbuser, $this->dbpassword );";
  const patched = patchWordPressMysqliPersistentSource(source);

  expect(patched).toContain("defined( 'KANDELO_MYSQLI_PERSISTENT' )");
  expect(patched).toContain("? 'p:' . $host : $host");
  expect(patchWordPressMysqliPersistentSource(patched)).toBe(patched);
});

test("generated mariadb launchers start threaded servers by default", () => {
  const launcherPaths = [
    "../../../images/vfs/scripts/build-lamp-vfs-image.ts",
    "../../../images/vfs/scripts/build-mariadb-vfs-image.ts",
    "../../../images/vfs/scripts/build-mariadb-test-vfs-image.ts",
    "../pages/benchmark/main.ts",
  ];

  for (const launcherPath of launcherPaths) {
    const source = readFileSync(new URL(launcherPath, import.meta.url), "utf8");
    expect(source, launcherPath).not.toContain("--thread-handling=no-threads");
  }
});

test("browser mysqli benchmark keeps persistent variants opt-in", () => {
  const defaultVariants = MYSQL_BENCHMARK_PHP.match(/\$variants = array\(([\s\S]*?)\);/);

  expect(defaultVariants?.[1]).toContain("'unix'");
  expect(defaultVariants?.[1]).toContain("'tcp'");
  expect(defaultVariants?.[1]).not.toContain("persistent");
  expect(MYSQL_BENCHMARK_PHP).toContain("include_persistent");
  expect(MYSQL_BENCHMARK_PHP.indexOf("'tcp_persistent'")).toBeLessThan(
    MYSQL_BENCHMARK_PHP.indexOf("'unix_persistent'"),
  );
});
