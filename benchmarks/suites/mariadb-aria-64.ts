/**
 * Suite: MariaDB (Aria engine) — wasm64 build.
 *
 * Same workload as mariadb-aria but targets the memory64 MariaDB binary
 * in examples/libs/mariadb/mariadb-install-64/.
 */
import type { BenchmarkSuite } from "../types.js";
import { runMariaDBBenchmark } from "./mariadb.js";

const suite: BenchmarkSuite = {
  name: "mariadb-aria-64",
  async run(): Promise<Record<string, number>> {
    return runMariaDBBenchmark("Aria", "wasm64");
  },
};

export default suite;
