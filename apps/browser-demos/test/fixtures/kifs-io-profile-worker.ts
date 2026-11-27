import "../../../../host/src/browser-kernel-worker-entry";
import { observeComputer } from "../../../../benchmarks/kifs-io-observer.mjs";

const computers = new Map<string, ReturnType<typeof observeComputer>>();
const open = FileSystemFileHandle.prototype.createSyncAccessHandle;
FileSystemFileHandle.prototype.createSyncAccessHandle = async function (...args: Parameters<typeof open>) {
  const handle = await open.apply(this, args);
  const name = /^(shell-comparison-[\w-]+)(?:\.g[01])?\.(?:volume(?:-seal)?|journal)$/.exec(this.name)?.[1];
  if (!name) return handle;
  const observer = computers.get(name) ?? observeComputer(name);
  computers.set(name, observer);
  // publishKifsGeneration clears the seal, stages and verifies synchronously,
  // then writes the seal. Only volume/journal operations enter the counters.
  if (this.name.endsWith(".volume-seal")) {
    const truncate = handle.truncate.bind(handle);
    handle.truncate = size => {
      truncate(size);
      if (size === 0) observer.beginPreparation();
    };
    const write = handle.write.bind(handle);
    handle.write = (...parameters: Parameters<typeof write>) => {
      observer.endPreparation();
      return write(...parameters);
    };
    const close = handle.close.bind(handle);
    handle.close = () => { observer.endPreparation(); close(); };
    return handle;
  }
  const volume = this.name.endsWith(".volume");
  const read = handle.read.bind(handle);
  handle.read = (...parameters: Parameters<typeof read>) => {
    const bytes = read(...parameters);
    observer.read(bytes);
    return bytes;
  };
  const write = handle.write.bind(handle);
  handle.write = (...parameters: Parameters<typeof write>) => {
    const bytes = write(...parameters);
    const at = parameters[1]?.at;
    observer.written(bytes, volume && bytes === 168 && (at === 0 || at === 4096));
    return bytes;
  };
  const flush = handle.flush.bind(handle);
  handle.flush = () => observer.flush(flush);
  return handle;
};
