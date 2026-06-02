import { expect, test } from "@playwright/test";
import { MYSQL_BENCHMARK_PHP } from "../lib/init/mysql-benchmark";
import { wordpressConfigTemplate } from "../lib/init/wordpress-runtime-config";

test("wordpress mariadb config uses Unix sockets without persistent mysqli", () => {
  const config = wordpressConfigTemplate("mariadb");

  expect(config).toContain("define('DB_HOST', 'localhost');");
  expect(config).not.toContain("KANDELO_MYSQLI_PERSISTENT");
  expect(config).not.toContain("p:localhost");
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
