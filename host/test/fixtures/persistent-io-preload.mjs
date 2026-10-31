import filesystem from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { getEnvironmentData, isMainThread } from "node:worker_threads";

const probe = getEnvironmentData("kandelo-persistent-io-probe");
if (!isMainThread && probe !== undefined) {
  const counts = new BigUint64Array(probe.counts);
  const descriptors = new Set();
  const open = filesystem.openSync;
  const read = filesystem.readSync;
  const close = filesystem.closeSync;
  const readFile = filesystem.readFileSync;
  filesystem.openSync = (...arguments_) => {
    const descriptor = open(...arguments_);
    if (String(arguments_[0]) === probe.path) descriptors.add(descriptor);
    return descriptor;
  };
  filesystem.readSync = (...arguments_) => {
    const count = read(...arguments_);
    if (descriptors.has(arguments_[0])) {
      Atomics.add(counts, 0, BigInt(count));
      Atomics.add(counts, 1, 1n);
      const position = Number(arguments_[4]);
      if (position < probe.guard.end && position + count > probe.guard.start) Atomics.store(counts, 3, 1n);
      const requested = BigInt(arguments_[3]);
      let previous = Atomics.load(counts, 2);
      while (requested > previous) {
        const observed = Atomics.compareExchange(counts, 2, previous, requested);
        if (observed === previous) break;
        previous = observed;
      }
    }
    return count;
  };
  filesystem.closeSync = (...arguments_) => {
    const result = close(...arguments_);
    descriptors.delete(arguments_[0]);
    return result;
  };
  filesystem.readFileSync = (...arguments_) => {
    if (String(arguments_[0]) === probe.path || descriptors.has(arguments_[0])) Atomics.store(counts, 3, 1n);
    return readFile(...arguments_);
  };
  syncBuiltinESMExports();
}
