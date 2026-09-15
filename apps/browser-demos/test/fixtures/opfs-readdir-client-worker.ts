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
    const names: string[] = [];
    try {
      for (let entry = fs.readdir(handle); entry !== null; entry = fs.readdir(handle)) {
        names.push(entry.name);
      }
    } finally {
      fs.closedir(handle);
    }

    for (const file of files) fs.unlink(`${dir}/${file}`);
    fs.rmdir(dir);
    self.postMessage({ type: "result", names: names.sort() });
  } catch (error) {
    for (const file of files) {
      try {
        fs.unlink(`${dir}/${file}`);
      } catch {
        // Preserve the original failure.
      }
    }
    try {
      fs.rmdir(dir);
    } catch {
      // Preserve the original failure.
    }
    self.postMessage({
      type: "error",
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
  } finally {
    self.close();
  }
};
