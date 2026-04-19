/**
 * Suite: MariaDB (Aria engine)
 *
 * Bootstrap and query execution performance with the Aria storage engine.
 */
import type { BenchmarkSuite } from "../types.js";
import { runMariaDBBenchmark } from "./mariadb.js";

const suite: BenchmarkSuite = {
  name: "mariadb-aria",
  async run(): Promise<Record<string, number>> {
    return runMariaDBBenchmark("Aria");
  },
};

export default suite;
