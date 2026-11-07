import filesystem from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { getEnvironmentData, isMainThread } from "node:worker_threads";

const probe = getEnvironmentData("kandelo-short-file-read");
if (!isMainThread && probe !== undefined) {
  const counts = new Int32Array(probe.counts);
  Atomics.add(counts, 3, 1);
  const descriptors = new Set();
  const open = filesystem.openSync;
  const close = filesystem.closeSync;
  const read = filesystem.readSync;
  const stat = filesystem.fstatSync;
  const identity = filesystem.statSync(probe.path, { bigint: true });
  let grown = false;
  filesystem.openSync = (...arguments_) => {
    const descriptor = open(...arguments_);
    const opened = stat(descriptor, { bigint: true });
    if (opened.dev === identity.dev && opened.ino === identity.ino) descriptors.add(descriptor);
    return descriptor;
  };
  filesystem.closeSync = (...arguments_) => {
    const result = close(...arguments_);
    descriptors.delete(arguments_[0]);
    return result;
  };
  filesystem.readSync = (...arguments_) => {
    if (descriptors.has(arguments_[0])) {
      if (!grown) {
        const before = stat(arguments_[0], { bigint: true });
        grown = true;
        Atomics.store(counts, 1, Number(before.size));
        filesystem.writeFileSync(probe.path, new Uint8Array(probe.bytes));
        Atomics.add(counts, 0, 1);
      }
      arguments_[3] = Math.min(arguments_[3], 17);
      Atomics.add(counts, 2, 1);
    }
    return read(...arguments_);
  };
  syncBuiltinESMExports();
}
