import { expect, it } from "vitest";
import { comparisonWorkerPools, phpFpmWorkerCount } from "../../benchmarks/wordpress-stack-config";

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
