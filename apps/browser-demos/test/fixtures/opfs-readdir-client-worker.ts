import { OpfsFileSystem } from "../../../../host/src/vfs/opfs";

const O_WRONLY = 0x0001;
const O_CREAT = 0x0040;
const O_TRUNC = 0x0200;

self.onmessage = (
  event: MessageEvent<{ buffer: SharedArrayBuffer; dir: string }>,
) => {
  const { buffer, dir } = event.data;
  const fs = OpfsFileSystem.create(buffer);
  const files = ["alpha.txt", "beta.txt", "gamma-with-a-longer-name.txt"];
  try {
    fs.mkdir(dir, 0o755);
    for (const file of files) {
      const fd = fs.open(`${dir}/${file}`, O_WRONLY | O_CREAT | O_TRUNC, 0o644);
      fs.close(fd);
    }

    const handle = fs.opendir(dir);
    // Collect name and type together: readdir decodes the name from the shared
    // channel and reads the trailing d_type byte at data[nameLen], so the test
    // can assert both halves of that decode.
    const entries: { name: string; type: number }[] = [];
    try {
      for (let entry = fs.readdir(handle); entry !== null; entry = fs.readdir(handle)) {
        entries.push({ name: entry.name, type: entry.type });
      }
    } finally {
      fs.closedir(handle);
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    // Report the listing before cleanup: a transient unlink/rmdir fault
    // must not mask a directory listing that already succeeded.
    self.postMessage({ type: "result", entries });
    cleanup(fs, dir, files);
  } catch (error) {
    cleanup(fs, dir, files);
    self.postMessage({
      type: "error",
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
  } finally {
    self.close();
  }
};

// Best-effort teardown. Each removal is guarded so one failure cannot
// abort the rest or change the outcome already reported to the test.
function cleanup(fs: OpfsFileSystem, dir: string, files: string[]): void {
  for (const file of files) {
    try {
      fs.unlink(`${dir}/${file}`);
    } catch {
      // Best effort; the listing result stands.
    }
  }
  try {
    fs.rmdir(dir);
  } catch {
    // Best effort; the listing result stands.
  }
}
