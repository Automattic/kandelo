import { expect, it } from "vitest";
import { comparisonWorkerPools, phpFpmWorkerCount } from "../../benchmarks/wordpress-stack-config";
import { limitPhpFpmPool } from "../../apps/browser-demos/lib/init/php-fpm-pool";

it("gives both services equal capacity while preserving ports, comments and unrelated settings", () => {
  const fpm = "; pm.max_children = 99\n[www]\nlisten = /run/php.sock\npm = static\npm.max_children = 1 ; small image default\n";
  const franken = "PHPRC=/etc/frankenphp\nFRANKENPHP_NUM_THREADS=2\nFRANKENPHP_PORT=8080\n";
  expect(comparisonWorkerPools(fpm, franken, 4)).toEqual({
    fpm: fpm.replace("= 1 ;", "= 4 ;"),
    franken: franken.replace("THREADS=2", "THREADS=4"),
  });
});

it("preserves CRLF and accepts the smallest and largest supported explicit pools", () => {
  for (const workers of [1, 32]) {
    const result = comparisonWorkerPools("pm.max_children=6\r\n", "FRANKENPHP_NUM_THREADS=6 # explicit\r\n", workers);
    expect(result).toEqual({ fpm: `pm.max_children=${workers}\r\n`, franken: `FRANKENPHP_NUM_THREADS=${workers} # explicit\r\n` });
    expect(phpFpmWorkerCount(result.fpm)).toBe(workers);
  }
});

it.each([0, -1, 33, 1.5, NaN, Infinity])("refuses invalid worker count %s", workers => {
  expect(() => comparisonWorkerPools("pm.max_children=1\n", "FRANKENPHP_NUM_THREADS=2\n", workers)).toThrow(RangeError);
});

it.each([
  ["", "FRANKENPHP_NUM_THREADS=2\n"],
  ["pm.max_children=1\npm.max_children=2\n", "FRANKENPHP_NUM_THREADS=2\n"],
  ["pm.max_children=1\n", ""],
  ["pm.max_children=1\n", "FRANKENPHP_NUM_THREADS=2\nFRANKENPHP_NUM_THREADS=4\n"],
])("refuses absent or ambiguous pool configurations", (fpm, franken) => {
  expect(() => comparisonWorkerPools(fpm, franken, 2)).toThrow(/Expected one/);
});

it("keeps a smaller image pool and preserves its complete FPM configuration", () => {
  const config = "[global]\nerror_log=/var/log/custom.log\n[www]\nlisten=/run/php.sock\nuser=nobody\npm=static\npm.max_children=2\nclear_env=yes\n";
  expect(limitPhpFpmPool(config, 6)).toBe(config);
  expect(limitPhpFpmPool(config, 2)).toBe(config);
});

it("caps an oversized explicit pool without changing other settings", () => {
  const config = "[www]\r\nlisten=127.0.0.1:9010\r\npm=static\r\npm.max_children = 6 ; image default\r\nclear_env=yes\r\n";
  expect(limitPhpFpmPool(config, 4)).toBe(config.replace("= 6 ;", "= 4 ;"));
});

it.each([
  "include=/etc/php-fpm.d/*.conf\n",
  "[one]\npm.max_children=2\n[two]\npm.max_children=4\n",
  "[www]\npm.max_children=${PHP_WORKERS}\n",
  "[www]\npm.max_children=0\n",
  "include=/etc/php-fpm.d/*.conf\n[www]\npm=static\npm.max_children=6\n",
  "[www]\npm=dynamic\npm.start_servers=5\npm.max_children=6\n",
  "[one]\npm=static\npm.max_children=6\n[two]\npm=dynamic\npm.max_children=${PHP_WORKERS}\n",
])("preserves configurations it cannot safely cap", config => {
  expect(limitPhpFpmPool(config, 1)).toBe(config);
});

it.each([0, -1, 1.5, NaN])("refuses invalid host pool limit %s", limit => {
  expect(() => limitPhpFpmPool("pm.max_children=1\n", limit)).toThrow(RangeError);
});
