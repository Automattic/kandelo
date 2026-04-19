/**
 * Suite: MariaDB (InnoDB engine)
 *
 * Bootstrap and query execution performance with the InnoDB storage engine.
 */
import type { BenchmarkSuite } from "../types.js";
import { runMariaDBBenchmark } from "./mariadb.js";

const suite: BenchmarkSuite = {
  name: "mariadb-innodb",
  async run(): Promise<Record<string, number>> {
    return runMariaDBBenchmark("InnoDB");
  },
};

export default suite;
