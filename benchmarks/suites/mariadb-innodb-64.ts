/**
 * Suite: MariaDB (InnoDB engine) — wasm64 build.
 *
 * Same workload as mariadb-innodb but targets the memory64 MariaDB binary
 * in examples/libs/mariadb/mariadb-install-64/.
 */
import type { BenchmarkSuite } from "../types.js";
import { runMariaDBBenchmark } from "./mariadb.js";

const suite: BenchmarkSuite = {
  name: "mariadb-innodb-64",
  async run(): Promise<Record<string, number>> {
    return runMariaDBBenchmark("InnoDB", "wasm64");
  },
};

export default suite;
